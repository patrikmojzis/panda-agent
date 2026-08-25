import {randomUUID} from "node:crypto";

import {resolveChannelRouteTarget} from "../../channels/route-target.js";
import type {RememberedRoute} from "../../channels/types.js";
import type {PgQueryable} from "../../../lib/postgres-query.js";
import {requireNonEmptyString, trimToUndefined} from "../../../lib/strings.js";
import type {ThreadEnqueueResult} from "./store.js";
import {ThreadInputAdmissionBlockedError, ThreadRunClaimLostError} from "./store.js";
import {buildActiveThreadRunGuardCte} from "./postgres-run-claims.js";
import {parseInputRow, parseInputThreadIdRow, parseMessageRow} from "./postgres-rows.js";
import type {ThreadRuntimeTableNames} from "./postgres-shared.js";
import type {
  ThreadEnqueueOptions,
  ThreadInputDeliveryMode,
  ThreadInputPayload,
  ThreadMessageRecord,
} from "./types.js";
import {
  createThreadRuntimeJsonbPersistenceError,
  serializeThreadRuntimeJsonb,
} from "./postgres-jsonb-safety.js";

const MAX_INPUTS_PER_APPLY = 500;

interface ThreadInputMutationOptions {
  pool: PgQueryable;
  tables: ThreadRuntimeTableNames;
  notificationChannel: string;
  threadId: string;
}

interface ThreadInputEnqueueMutationOptions {
  pool: PgQueryable;
  tables: ThreadRuntimeTableNames;
  sessionTable: string;
  sessionRuntimeConfigTable: string;
  sessionRouteTable: string;
  notificationChannel: string;
  targetId: string;
  targetLabel: "thread" | "session";
  targetSql: string;
  payload: ThreadInputPayload;
  deliveryMode: ThreadInputDeliveryMode;
  enqueueOptions?: ThreadEnqueueOptions;
}

interface PreparedRememberedRoute {
  identityId?: string;
  route: RememberedRoute;
  metadataJson: ReturnType<typeof serializeThreadRuntimeJsonb>;
}

function prepareRememberedRoute(options: ThreadEnqueueOptions | undefined): PreparedRememberedRoute | undefined {
  const capture = options?.rememberedRoute;
  if (!capture) return undefined;
  const route = capture.route;
  if (!Number.isSafeInteger(route.capturedAt) || route.capturedAt < 0) {
    throw new Error("Remembered route capturedAt must be a non-negative safe integer.");
  }
  const normalized: RememberedRoute = {
    source: requireNonEmptyString(route.source, "Remembered route source must not be empty."),
    connectorKey: requireNonEmptyString(route.connectorKey, "Remembered route connector key must not be empty."),
    externalConversationId: requireNonEmptyString(
      route.externalConversationId,
      "Remembered route conversation id must not be empty.",
    ),
    externalActorId: trimToUndefined(route.externalActorId),
    externalMessageId: trimToUndefined(route.externalMessageId),
    capturedAt: route.capturedAt,
    ...(route.deliveryContext === undefined ? {} : {deliveryContext: route.deliveryContext}),
  };
  return {
    identityId: trimToUndefined(capture.identityId),
    route: normalized,
    metadataJson: serializeThreadRuntimeJsonb(normalized),
  };
}

// PostgreSQL executes data-modifying CTEs even when the final SELECT is empty.
// Joining the accepted input relation is what makes a rejected collision leave
// both the input ledger and its remembered reply route untouched.
function buildRememberedRouteCte(
  table: string,
  route: PreparedRememberedRoute | undefined,
  firstParameter: number,
  acceptedRelation: "inserted" | "resolved",
): {sql: string; values: readonly unknown[]} {
  if (!route) {
    return {sql: "remembered_route AS (SELECT 1 AS skipped WHERE FALSE)", values: []};
  }
  const conflictTarget = route.identityId
    ? "(session_id, identity_id, channel) WHERE identity_id IS NOT NULL"
    : "(session_id, channel) WHERE identity_id IS NULL";
  const p = (offset: number) => `$${firstParameter + offset}`;
  return {
    sql: `remembered_route AS (
      INSERT INTO ${table} AS route (
        session_id,
        identity_id,
        channel,
        connector_key,
        external_conversation_id,
        external_actor_id,
        external_message_id,
        captured_at_ms,
        metadata
      )
      SELECT
        target_thread.session_id,
        ${p(0)},
        ${p(1)},
        ${p(2)},
        ${p(3)},
        ${p(4)},
        ${p(5)},
        ${p(6)},
        ${p(7)}::jsonb
      FROM target_thread
      CROSS JOIN ${acceptedRelation}
      ON CONFLICT ${conflictTarget} DO UPDATE
      SET connector_key = CASE WHEN route.captured_at_ms <= EXCLUDED.captured_at_ms
            THEN EXCLUDED.connector_key ELSE route.connector_key END,
          external_conversation_id = CASE WHEN route.captured_at_ms <= EXCLUDED.captured_at_ms
            THEN EXCLUDED.external_conversation_id ELSE route.external_conversation_id END,
          external_actor_id = CASE WHEN route.captured_at_ms <= EXCLUDED.captured_at_ms
            THEN EXCLUDED.external_actor_id ELSE route.external_actor_id END,
          external_message_id = CASE WHEN route.captured_at_ms <= EXCLUDED.captured_at_ms
            THEN EXCLUDED.external_message_id ELSE route.external_message_id END,
          captured_at_ms = GREATEST(route.captured_at_ms, EXCLUDED.captured_at_ms),
          metadata = CASE WHEN route.captured_at_ms <= EXCLUDED.captured_at_ms
            THEN EXCLUDED.metadata ELSE route.metadata END,
          updated_at = CASE WHEN route.captured_at_ms <= EXCLUDED.captured_at_ms
            THEN NOW() ELSE route.updated_at END
      RETURNING route.id
    )`,
    values: [
      route.identityId ?? null,
      route.route.source,
      route.route.connectorKey,
      route.route.externalConversationId,
      route.route.externalActorId ?? null,
      route.route.externalMessageId ?? null,
      route.route.capturedAt,
      route.metadataJson.json,
    ],
  };
}

function inputStateColumns(alias: string): string {
  return [
    "id",
    "thread_id",
    "input_order",
    "delivery_mode",
    "source",
    "connector_key",
    "channel_id",
    "external_message_id",
    "actor_id",
    "identity_id",
    "created_at",
    "applied_at",
    "applied_run_id",
    "discarded_at",
  ].map((column) => `${alias}.${column}`).join(",\n        ");
}

function enqueueDisposition(input: ReturnType<typeof parseInputRow>): ThreadEnqueueResult["disposition"] {
  if (input.status === "applied") {
    return "duplicate_applied";
  }
  if (input.status === "discarded") {
    return "duplicate_discarded";
  }
  return "duplicate_pending";
}

async function resolveDuplicateInput(options: ThreadInputEnqueueMutationOptions & {
  inputId: string;
  connectorKey: string;
}): Promise<ThreadEnqueueResult> {
  const {pool, tables, inputId, payload, connectorKey, deliveryMode} = options;
  const rememberedRoute = prepareRememberedRoute(options.enqueueOptions);
  const routeCte = buildRememberedRouteCte(
    options.sessionRouteTable,
    rememberedRoute,
    9,
    "resolved",
  );
  // Stable input UUIDs survive `/reset`, so retries may resolve a tombstone on
  // an older thread. Session scope prevents cross-session disclosure; the
  // immutable routing fingerprint prevents an unrelated same-session input
  // from being accepted merely because its UUID collides.
  const result = await pool.query(`
    WITH target_thread AS MATERIALIZED (${options.targetSql}), matched AS MATERIALIZED (
      SELECT ${inputStateColumns("input")}
      FROM ${tables.inputs} AS input
      INNER JOIN ${tables.threads} AS input_thread ON input_thread.id = input.thread_id
      CROSS JOIN target_thread
      WHERE (
           input.id = $1
           AND input_thread.session_id = target_thread.session_id
           AND input.source = $4
           AND input.connector_key = $5
           AND (input.channel_id = $6::text OR (input.channel_id IS NULL AND $6::text IS NULL))
           AND (input.external_message_id = $7::text OR (input.external_message_id IS NULL AND $7::text IS NULL))
         )
         OR (
           $7::text IS NOT NULL
           AND input.thread_id = target_thread.id
           AND input.source = $4
           AND input.connector_key = $5
           AND (input.channel_id = $6::text OR (input.channel_id IS NULL AND $6::text IS NULL))
           AND input.external_message_id = $7
         )
      ORDER BY (input.id = $1) DESC, input.input_order DESC
      LIMIT 1
      FOR UPDATE OF input
    ), resolved AS (
      SELECT * FROM matched
    ), ${routeCte.sql}, wake AS (
      INSERT INTO ${options.sessionRuntimeConfigTable} (
        session_id,
        pending_wake_at,
        pending_wake_generation
      )
      SELECT target_thread.session_id, NOW(), 1
      FROM target_thread
      CROSS JOIN resolved
      WHERE $3 = 'wake'
        AND resolved.applied_at IS NULL
        AND resolved.discarded_at IS NULL
      ON CONFLICT (session_id) DO UPDATE
      SET pending_wake_at = NOW(),
          pending_wake_generation = ${options.sessionRuntimeConfigTable}.pending_wake_generation + 1,
          updated_at = NOW()
      RETURNING session_id
    ), notified AS (
      SELECT pg_notify(
        $8,
        json_build_object('kind', 'thread_runnable', 'threadId', resolved.thread_id)::text
      ) AS notification
      FROM resolved
      WHERE $3 = 'wake'
        AND resolved.applied_at IS NULL
        AND resolved.discarded_at IS NULL
    )
    SELECT resolved.*, notified.notification,
           (SELECT COUNT(*) FROM wake) AS wake_count
    FROM resolved
    LEFT JOIN notified ON TRUE
  `, [
    inputId,
    options.targetId,
    deliveryMode,
    payload.source,
    connectorKey,
    payload.channelId ?? null,
    payload.externalMessageId ?? null,
    options.notificationChannel,
    ...routeCte.values,
  ]);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    throw new Error(`Thread input conflict for ${inputId} did not resolve to a durable input.`);
  }
  const input = parseInputRow(row);
  return {input, disposition: enqueueDisposition(input)};
}

async function enqueueInputAtTarget(options: ThreadInputEnqueueMutationOptions): Promise<ThreadEnqueueResult> {
  const {pool, tables, payload, deliveryMode} = options;
  const inputId = options.enqueueOptions?.inputId ?? randomUUID();
  const connectorKey = resolveChannelRouteTarget(payload)?.target.connectorKey ?? "";
  const metadataJson = serializeThreadRuntimeJsonb(payload.metadata);
  const messageJson = serializeThreadRuntimeJsonb(payload.message);
  const rememberedRoute = prepareRememberedRoute(options.enqueueOptions);
  const routeCte = buildRememberedRouteCte(
    options.sessionRouteTable,
    rememberedRoute,
    13,
    "inserted",
  );

  try {
    const result = await pool.query(`
      WITH target_thread AS MATERIALIZED (${options.targetSql}), inserted AS (
        INSERT INTO ${tables.inputs} (
          id,
          thread_id,
          delivery_mode,
          source,
          connector_key,
          channel_id,
          external_message_id,
          actor_id,
          identity_id,
          created_at,
          metadata,
          message
        )
        SELECT
          $1,
          target_thread.id,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          NOW(),
          $10::jsonb,
          $11::jsonb
        FROM target_thread
        RETURNING ${inputStateColumns(tables.inputs)}
      ), ${routeCte.sql}, updated_thread AS (
        UPDATE ${tables.threads} AS thread
        SET updated_at = NOW()
        FROM inserted
        WHERE thread.id = inserted.thread_id
        RETURNING thread.id
      ), wake AS (
        INSERT INTO ${options.sessionRuntimeConfigTable} (
          session_id,
          pending_wake_at,
          pending_wake_generation
        )
        SELECT target_thread.session_id, NOW(), 1
        FROM target_thread
        CROSS JOIN inserted
        WHERE inserted.delivery_mode = 'wake'
        ON CONFLICT (session_id) DO UPDATE
        SET pending_wake_at = NOW(),
            pending_wake_generation = ${options.sessionRuntimeConfigTable}.pending_wake_generation + 1,
            updated_at = NOW()
        RETURNING session_id
      ), notified AS (
        SELECT pg_notify(
          $12,
          json_build_object(
            'kind',
            CASE WHEN inserted.delivery_mode = 'wake' THEN 'thread_runnable' ELSE 'thread_changed' END,
            'threadId',
            inserted.thread_id
          )::text
        ) AS notification
        FROM inserted
        INNER JOIN updated_thread ON updated_thread.id = inserted.thread_id
      )
      SELECT inserted.*, notified.notification,
             (SELECT COUNT(*) FROM wake) AS wake_count
      FROM inserted
      INNER JOIN notified ON TRUE
    `, [
      inputId,
      options.targetId,
      deliveryMode,
      payload.source,
      connectorKey,
      payload.channelId ?? null,
      payload.externalMessageId ?? null,
      payload.actorId ?? null,
      payload.identityId ?? null,
      metadataJson.json,
      messageJson.json,
      options.notificationChannel,
      ...routeCte.values,
    ]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`Unknown ${options.targetLabel} ${options.targetId}.`);
    }
    return {input: parseInputRow(row), disposition: "inserted"};
  } catch (error) {
    const jsonbError = createThreadRuntimeJsonbPersistenceError(error, {
      operation: "enqueueThreadInput",
      table: tables.inputs,
      fields: [
        {name: "metadata", nulCount: metadataJson.nulCount},
        {name: "message", nulCount: messageJson.nulCount},
        ...(rememberedRoute
          ? [{name: "rememberedRoute", nulCount: rememberedRoute.metadataJson.nulCount}]
          : []),
      ],
    });
    if (jsonbError) {
      throw jsonbError;
    }
    if ((error as {code?: string}).code !== "23505") {
      throw error;
    }
    return resolveDuplicateInput({...options, inputId, connectorKey});
  }
}

export async function enqueueThreadInput(
  options: ThreadInputMutationOptions & {
    sessionTable: string;
    sessionRuntimeConfigTable: string;
    sessionRouteTable: string;
    payload: ThreadInputPayload;
    deliveryMode: ThreadInputDeliveryMode;
    enqueueOptions?: ThreadEnqueueOptions;
  },
): Promise<ThreadEnqueueResult> {
  return enqueueInputAtTarget({
    ...options,
    targetId: options.threadId,
    targetLabel: "thread",
    targetSql: `
      WITH target_session AS MATERIALIZED (
        SELECT thread.session_id
        FROM ${options.tables.threads} AS thread
        WHERE thread.id = $2
      ), locked_session AS MATERIALIZED (
        SELECT session.id, session.current_thread_id
        FROM ${options.sessionTable} AS session
        INNER JOIN target_session ON target_session.session_id = session.id
        WHERE session.current_thread_id = $2
        FOR UPDATE OF session
      )
      SELECT thread.id, thread.session_id
      FROM ${options.tables.threads} AS thread
      INNER JOIN locked_session
        ON locked_session.id = thread.session_id
       AND locked_session.current_thread_id = thread.id
      WHERE thread.id = $2
        AND thread.run_claims_blocked_at IS NULL
      FOR UPDATE OF thread
    `,
  });
}

export async function enqueueSessionThreadInput(options: {
  pool: PgQueryable;
  tables: ThreadRuntimeTableNames;
  sessionTable: string;
  sessionRuntimeConfigTable: string;
  sessionRouteTable: string;
  notificationChannel: string;
  sessionId: string;
  payload: ThreadInputPayload;
  deliveryMode: ThreadInputDeliveryMode;
  enqueueOptions?: ThreadEnqueueOptions;
}): Promise<ThreadEnqueueResult> {
  const mutation = {
    ...options,
    targetId: options.sessionId,
    targetLabel: "session",
    targetSql: `
      WITH locked_session AS MATERIALIZED (
        SELECT session.id, session.current_thread_id
        FROM ${options.sessionTable} AS session
        WHERE session.id = $2
        FOR UPDATE OF session
      )
      SELECT thread.id, thread.session_id
      FROM locked_session AS session
      INNER JOIN ${options.tables.threads} AS thread
        ON thread.id = session.current_thread_id
       AND thread.session_id = session.id
       AND thread.run_claims_blocked_at IS NULL
      FOR UPDATE OF thread
    `,
  } satisfies ThreadInputEnqueueMutationOptions;
  let observedThreadId: string | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await enqueueInputAtTarget(mutation);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== `Unknown session ${options.sessionId}.`) {
        throw error;
      }
      // A reset can make an old statement snapshot miss its newly-current
      // replacement. Diagnose from a fresh snapshot: blocked means defer;
      // observing a new unblocked generation earns one bounded retry.
      const state = await options.pool.query(`
        SELECT session.current_thread_id,
               thread.run_claims_blocked_at IS NOT NULL AS blocked
        FROM ${options.sessionTable} AS session
        LEFT JOIN ${options.tables.threads} AS thread
          ON thread.id = session.current_thread_id
         AND thread.session_id = session.id
        WHERE session.id = $1
      `, [options.sessionId]);
      const row = state.rows[0] as {current_thread_id?: unknown; blocked?: unknown} | undefined;
      if (row?.blocked === true && typeof row.current_thread_id === "string") {
        throw new ThreadInputAdmissionBlockedError(options.sessionId, row.current_thread_id);
      }
      if (
        typeof row?.current_thread_id === "string"
        && row.current_thread_id !== observedThreadId
        && attempt < 2
      ) {
        observedThreadId = row.current_thread_id;
        continue;
      }
      throw error;
    }
  }
  throw new Error(`Unknown session ${options.sessionId}.`);
}

export async function applyPendingThreadInputs(
  options: ThreadInputMutationOptions & {
    sessionRuntimeConfigTable: string;
    runId: string;
  },
): Promise<readonly ThreadMessageRecord[]> {
  const {pool, tables} = options;
  const result = await pool.query(`
    WITH ${buildActiveThreadRunGuardCte(tables, {runIdParameter: 2, threadIdParameter: 1})},
    locked_thread AS MATERIALIZED (
      SELECT thread.id, thread.session_id
      FROM ${tables.threads} AS thread
      INNER JOIN active_run ON active_run.thread_id = thread.id
      WHERE thread.id = $1
      FOR UPDATE OF thread
    ),
    observed_wake AS MATERIALIZED (
      SELECT config.session_id, config.pending_wake_generation
      FROM ${options.sessionRuntimeConfigTable} AS config
      INNER JOIN locked_thread AS thread
        ON thread.session_id = config.session_id
      WHERE config.pending_wake_at IS NOT NULL
    ), admission_cutoff AS MATERIALIZED (
      SELECT MAX(input.input_order) AS input_order
      FROM ${tables.inputs} AS input
      INNER JOIN locked_thread ON locked_thread.id = input.thread_id
      CROSS JOIN observed_wake
      WHERE input.applied_at IS NULL
        AND input.discarded_at IS NULL
      HAVING MAX(input.input_order) IS NOT NULL
    ), extended_run AS (
      UPDATE ${tables.runs} AS run
      SET admitted_through_input_order = GREATEST(
        COALESCE(run.admitted_through_input_order, 0),
        admission_cutoff.input_order
      )
      FROM active_run
      CROSS JOIN admission_cutoff
      WHERE run.id = active_run.id
      RETURNING run.*
    ), effective_run AS MATERIALIZED (
      SELECT id, thread_id, admitted_through_input_order FROM extended_run
      UNION ALL
      SELECT id, thread_id, admitted_through_input_order FROM active_run
      WHERE NOT EXISTS (SELECT 1 FROM extended_run)
    ), pending AS MATERIALIZED (
      SELECT input.*
      FROM ${tables.inputs} AS input
      INNER JOIN locked_thread ON locked_thread.id = input.thread_id
      INNER JOIN effective_run AS run ON run.thread_id = input.thread_id
      WHERE input.thread_id = $1
        AND input.applied_at IS NULL
        AND input.discarded_at IS NULL
        AND input.message IS NOT NULL
        AND input.input_order <= run.admitted_through_input_order
      ORDER BY input.input_order ASC
      LIMIT ${MAX_INPUTS_PER_APPLY}
      FOR UPDATE OF input
    ), inserted_messages AS (
      INSERT INTO ${tables.messages} (
        id,
        input_id,
        thread_id,
        origin,
        source,
        channel_id,
        external_message_id,
        actor_id,
        identity_id,
        run_id,
        run_thread_id,
        created_at,
        metadata,
        message
      )
      SELECT
        pending.id,
        pending.id,
        pending.thread_id,
        'input',
        pending.source,
        pending.channel_id,
        pending.external_message_id,
        pending.actor_id,
        pending.identity_id,
        $2,
        pending.thread_id,
        pending.created_at,
        pending.metadata,
        pending.message
      FROM pending
      RETURNING *
    ), applied_inputs AS (
      UPDATE ${tables.inputs} AS input
      SET applied_at = NOW(),
          applied_run_id = $2,
          metadata = NULL,
          message = NULL
      FROM inserted_messages AS message
      WHERE input.id = message.input_id
        AND input.thread_id = message.thread_id
      RETURNING input.id, input.thread_id
    ), input_mutations AS MATERIALIZED (
      SELECT (SELECT COUNT(*) FROM applied_inputs) AS applied_count
    ), consumed_wake AS (
      -- Input rows always precede the config row in the lock protocol. The
      -- explicit dependency matters: sibling data-modifying CTEs otherwise
      -- have no execution order in PostgreSQL.
      UPDATE ${options.sessionRuntimeConfigTable} AS config
      SET pending_wake_at = NULL,
          updated_at = NOW()
      FROM observed_wake
      CROSS JOIN input_mutations
      WHERE config.session_id = observed_wake.session_id
        AND config.pending_wake_generation = observed_wake.pending_wake_generation
      RETURNING config.session_id
    ), updated_thread AS (
      UPDATE ${tables.threads} AS thread
      SET updated_at = NOW()
      FROM (SELECT DISTINCT thread_id FROM applied_inputs) AS applied
      WHERE thread.id = applied.thread_id
      RETURNING thread.id
    ), notified AS (
      SELECT pg_notify(
        $3,
        json_build_object('kind', 'thread_changed', 'threadId', updated_thread.id)::text
      ) AS notification
      FROM updated_thread
    )
    SELECT
      message.id,
      message.input_id,
      message.thread_id,
      message.sequence,
      message.origin,
      message.source,
      message.channel_id,
      message.external_message_id,
      message.actor_id,
      message.identity_id,
      message.run_id,
      message.created_at,
      message.metadata,
      message.message,
      FALSE AS empty_batch,
      TRUE AS notification_sent
    FROM inserted_messages AS message
    INNER JOIN applied_inputs AS applied ON applied.id = message.input_id
    INNER JOIN notified ON TRUE
    UNION ALL
    SELECT
      NULL::uuid,
      NULL::uuid,
      active_run.thread_id,
      NULL::bigint,
      NULL::text,
      NULL::text,
      NULL::text,
      NULL::text,
      NULL::text,
      NULL::text,
      active_run.id,
      NULL::timestamptz,
      NULL::jsonb,
      NULL::jsonb,
      TRUE AS empty_batch,
      FALSE AS notification_sent
    FROM active_run
    WHERE NOT EXISTS (SELECT 1 FROM inserted_messages)
    ORDER BY empty_batch ASC, sequence ASC
  `, [options.threadId, options.runId, options.notificationChannel]);

  if (result.rows.length === 0) {
    throw new ThreadRunClaimLostError(options.runId);
  }
  if ((result.rows[0] as {empty_batch?: unknown}).empty_batch === true) {
    return [];
  }
  return result.rows.map((row) => parseMessageRow(row as Record<string, unknown>));
}

export async function discardPendingThreadInputs(options: ThreadInputMutationOptions): Promise<number> {
  const result = await options.pool.query(`
    WITH target_thread AS MATERIALIZED (
      SELECT id
      FROM ${options.tables.threads}
      WHERE id = $1
      FOR UPDATE
    ), discarded AS (
      UPDATE ${options.tables.inputs} AS input
      SET discarded_at = NOW(),
          metadata = NULL,
          message = NULL
      FROM target_thread
      WHERE input.thread_id = target_thread.id
        AND input.applied_at IS NULL
        AND input.discarded_at IS NULL
      RETURNING input.id, input.thread_id
    ), updated_thread AS (
      UPDATE ${options.tables.threads} AS thread
      SET updated_at = NOW()
      FROM (SELECT DISTINCT thread_id FROM discarded) AS changed
      WHERE thread.id = changed.thread_id
      RETURNING thread.id
    ), notified AS (
      SELECT pg_notify(
        $2,
        json_build_object('kind', 'thread_changed', 'threadId', updated_thread.id)::text
      ) AS notification
      FROM updated_thread
    )
    SELECT target_thread.id, COUNT(discarded.id)::integer AS discarded_count,
           (SELECT COUNT(*) FROM notified) AS notification_count
    FROM target_thread
    LEFT JOIN discarded ON discarded.thread_id = target_thread.id
    GROUP BY target_thread.id
  `, [options.threadId, options.notificationChannel]);
  const row = result.rows[0] as {discarded_count?: unknown} | undefined;
  if (!row) {
    throw new Error(`Unknown thread ${options.threadId}`);
  }
  return Number(row.discarded_count ?? 0);
}

export async function wakePendingThreadInputs(options: {
  pool: PgQueryable;
  tables: ThreadRuntimeTableNames;
  sessionTable: string;
  sessionRuntimeConfigTable: string;
  notificationChannel: string;
  threadId: string;
}): Promise<readonly string[]> {
  const result = await options.pool.query(`
    WITH target_sessions AS MATERIALIZED (
      SELECT session.id, session.current_thread_id
      FROM ${options.sessionTable} AS session
      INNER JOIN ${options.tables.threads} AS thread
        ON thread.id = session.current_thread_id
       AND thread.session_id = session.id
      LEFT JOIN ${options.sessionRuntimeConfigTable} AS config
        ON config.session_id = session.id
      WHERE EXISTS (
        SELECT 1
        FROM ${options.tables.inputs} AS input
        WHERE input.thread_id = thread.id
          AND input.applied_at IS NULL
          AND input.discarded_at IS NULL
      )
        AND config.pending_wake_at IS NULL
        AND thread.id = $2
      ORDER BY session.id
      LIMIT 1
      FOR UPDATE OF session
    ), target_threads AS MATERIALIZED (
      SELECT thread.id, thread.session_id
      FROM ${options.tables.threads} AS thread
      INNER JOIN target_sessions AS session
        ON session.id = thread.session_id
       AND session.current_thread_id = thread.id
      ORDER BY thread.id
      FOR UPDATE OF thread
    ), wake AS (
      INSERT INTO ${options.sessionRuntimeConfigTable} (
        session_id,
        pending_wake_at,
        pending_wake_generation
      )
      SELECT thread.session_id, NOW(), 1
      FROM target_threads AS thread
      ON CONFLICT (session_id) DO UPDATE
      SET pending_wake_at = NOW(),
          pending_wake_generation = ${options.sessionRuntimeConfigTable}.pending_wake_generation + 1,
          updated_at = NOW()
      RETURNING session_id
    ), notified AS (
      SELECT thread.id,
             pg_notify(
               $1,
               json_build_object('kind', 'thread_runnable', 'threadId', thread.id)::text
             ) AS notification
      FROM target_threads AS thread
      INNER JOIN wake ON wake.session_id = thread.session_id
    )
    SELECT id AS thread_id, notification,
           (SELECT COUNT(*) FROM wake) AS wake_count
    FROM notified
    ORDER BY id ASC
  `, [options.notificationChannel, options.threadId]);
  return result.rows.map((row) => parseInputThreadIdRow(row as Record<string, unknown>));
}
