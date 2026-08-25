import {randomUUID} from "node:crypto";

import {resolveChannelRouteTarget} from "../../channels/route-target.js";
import type {PgQueryable} from "../../../lib/postgres-query.js";
import type {ThreadEnqueueResult} from "./store.js";
import {ThreadRunClaimLostError} from "./store.js";
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
  notificationChannel: string;
  targetId: string;
  targetLabel: "thread" | "session";
  targetSql: string;
  payload: ThreadInputPayload;
  deliveryMode: ThreadInputDeliveryMode;
  enqueueOptions?: ThreadEnqueueOptions;
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
    "admitted_run_id",
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
  // Stable input UUIDs survive `/reset`, so retries may resolve a tombstone on
  // an older thread. Session scope prevents cross-session disclosure; the
  // immutable routing fingerprint prevents an unrelated same-session input
  // from being accepted or promoted merely because its UUID collides.
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
    ), promoted AS (
      UPDATE ${tables.inputs} AS input
      SET delivery_mode = 'wake'
      FROM matched
      WHERE input.id = matched.id
        AND input.applied_at IS NULL
        AND input.discarded_at IS NULL
        AND input.delivery_mode = 'queue'
        AND $3 = 'wake'
      RETURNING ${inputStateColumns("input")}
    ), resolved AS (
      SELECT * FROM promoted
      UNION ALL
      SELECT * FROM matched
      WHERE NOT EXISTS (SELECT 1 FROM promoted)
    ), updated_thread AS (
      UPDATE ${tables.threads} AS thread
      SET updated_at = NOW()
      FROM promoted
      WHERE thread.id = promoted.thread_id
      RETURNING thread.id
    ), wake AS (
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
      LEFT JOIN updated_thread ON updated_thread.id = resolved.thread_id
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
      ), updated_thread AS (
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
      FOR UPDATE OF thread
    `,
  });
}

export async function enqueueSessionThreadInput(options: {
  pool: PgQueryable;
  tables: ThreadRuntimeTableNames;
  sessionTable: string;
  sessionRuntimeConfigTable: string;
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
      FOR UPDATE OF thread
    `,
  } satisfies ThreadInputEnqueueMutationOptions;
  try {
    return await enqueueInputAtTarget(mutation);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== `Unknown session ${options.sessionId}.`) {
      throw error;
    }
    // If reset held the session lock when this statement took its snapshot,
    // PostgreSQL can expose the updated session row after waiting while the
    // newly inserted thread remains invisible to that old statement snapshot.
    // One fresh statement is enough; the uncontended ingress path stays one RTT.
    return enqueueInputAtTarget(mutation);
  }
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
    ), visible_wake_input AS MATERIALIZED (
      SELECT 1 AS present
      FROM ${tables.inputs} AS input
      INNER JOIN locked_thread ON locked_thread.id = input.thread_id
      WHERE input.applied_at IS NULL
        AND input.discarded_at IS NULL
        AND input.delivery_mode = 'wake'
      LIMIT 1
    ), admission_edge AS MATERIALIZED (
      SELECT 1 AS present FROM observed_wake
      UNION ALL
      SELECT 1 AS present FROM visible_wake_input
      WHERE NOT EXISTS (SELECT 1 FROM observed_wake)
    ), pending AS MATERIALIZED (
      SELECT input.*
      FROM ${tables.inputs} AS input
      INNER JOIN locked_thread ON locked_thread.id = input.thread_id
      WHERE input.thread_id = $1
        AND input.applied_at IS NULL
        AND input.discarded_at IS NULL
        AND input.message IS NOT NULL
        AND (
          input.admitted_run_id = $2
          OR EXISTS (SELECT 1 FROM admission_edge)
        )
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
          admitted_run_id = NULL,
          metadata = NULL,
          message = NULL
      FROM inserted_messages AS message
      WHERE input.id = message.input_id
        AND input.thread_id = message.thread_id
      RETURNING input.id, input.thread_id
    ), admitted_remaining AS (
      -- Bind the complete visible FIFO snapshot to this run. A newer wake
      -- generation that committed while the statement waited remains armed;
      -- the durable wake-row fallback also repairs edges from older runtimes.
      UPDATE ${tables.inputs} AS input
      SET delivery_mode = 'queue',
          admitted_run_id = active_run.id
      FROM active_run
      CROSS JOIN admission_edge
      WHERE input.thread_id = active_run.thread_id
        AND input.applied_at IS NULL
        AND input.discarded_at IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM applied_inputs AS applied
          WHERE applied.id = input.id
      )
      RETURNING input.id
    ), input_mutations AS MATERIALIZED (
      SELECT
        (SELECT COUNT(*) FROM applied_inputs) AS applied_count,
        (SELECT COUNT(*) FROM admitted_remaining) AS admitted_count
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
      CROSS JOIN (SELECT COUNT(*) FROM admitted_remaining) AS admission_boundary
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
          admitted_run_id = NULL,
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

export async function promoteQueuedThreadInputs(options: {
  pool: PgQueryable;
  tables: ThreadRuntimeTableNames;
  sessionTable: string;
  sessionRuntimeConfigTable: string;
  notificationChannel: string;
  threadId?: string;
}): Promise<readonly string[]> {
  const values: unknown[] = [options.notificationChannel];
  const threadPredicate = options.threadId === undefined ? "" : "AND thread.id = $2";
  if (options.threadId !== undefined) {
    values.push(options.threadId);
  }

  const result = await options.pool.query(`
    WITH target_sessions AS MATERIALIZED (
      SELECT session.id, session.current_thread_id
      FROM ${options.sessionTable} AS session
      INNER JOIN ${options.tables.threads} AS thread
        ON thread.id = session.current_thread_id
       AND thread.session_id = session.id
      WHERE EXISTS (
        SELECT 1
        FROM ${options.tables.inputs} AS input
        WHERE input.thread_id = thread.id
          AND input.applied_at IS NULL
          AND input.discarded_at IS NULL
          AND input.delivery_mode = 'queue'
      )
      ${threadPredicate}
      ORDER BY session.id
      FOR UPDATE OF session
    ), target_threads AS MATERIALIZED (
      SELECT thread.id, thread.session_id
      FROM ${options.tables.threads} AS thread
      INNER JOIN target_sessions AS session
        ON session.id = thread.session_id
       AND session.current_thread_id = thread.id
      ORDER BY thread.id
      FOR UPDATE OF thread
    ), promoted AS (
      UPDATE ${options.tables.inputs} AS input
      SET delivery_mode = 'wake'
      FROM target_threads AS thread
      WHERE input.thread_id = thread.id
        AND input.applied_at IS NULL
        AND input.discarded_at IS NULL
        AND input.delivery_mode = 'queue'
      RETURNING input.thread_id
    ), changed_threads AS (
      SELECT DISTINCT thread_id FROM promoted
    ), updated_threads AS (
      UPDATE ${options.tables.threads} AS thread
      SET updated_at = NOW()
      FROM changed_threads
      WHERE thread.id = changed_threads.thread_id
      RETURNING thread.id
    ), wake AS (
      INSERT INTO ${options.sessionRuntimeConfigTable} (
        session_id,
        pending_wake_at,
        pending_wake_generation
      )
      SELECT thread.session_id, NOW(), 1
      FROM changed_threads
      INNER JOIN target_threads AS thread
        ON thread.id = changed_threads.thread_id
      ON CONFLICT (session_id) DO UPDATE
      SET pending_wake_at = NOW(),
          pending_wake_generation = ${options.sessionRuntimeConfigTable}.pending_wake_generation + 1,
          updated_at = NOW()
      RETURNING session_id
    ), notified AS (
      SELECT updated_threads.id,
             pg_notify(
               $1,
               json_build_object('kind', 'thread_runnable', 'threadId', updated_threads.id)::text
             ) AS notification
      FROM updated_threads
    )
    SELECT id AS thread_id, notification,
           (SELECT COUNT(*) FROM wake) AS wake_count
    FROM notified
    ORDER BY id ASC
  `, values);
  return result.rows.map((row) => parseInputThreadIdRow(row as Record<string, unknown>));
}
