import {optionalTimestampMillis, requireTimestampMillis, toJson} from "../../lib/postgres-values.js";
import {randomUUID} from "node:crypto";

import {requireBoolean} from "../../lib/booleans.js";
import {hasActiveClaim} from "../../lib/claims.js";
import {isJsonObject, type JsonObject} from "../../lib/json.js";
import {toDateOrNull} from "../../lib/dates.js";
import {optionalNonEmptyString, requireNonEmptyString} from "../../lib/strings.js";
import type {PgClientLike, PgPoolLike} from "../../lib/postgres-query.js";
import {parseWatchDetectorConfig, parseWatchSourceConfig} from "./config.js";
import {ensurePostgresWatchSchema} from "./postgres-schema.js";
import {buildWatchTableNames, type WatchTableNames} from "./postgres-shared.js";
import type {RecordWatchEventResult, WatchStore} from "./store.js";
import type {
    ClaimWatchInput,
    ClaimWatchResult,
    CompleteWatchRunInput,
    CreateWatchInput,
    DisableWatchInput,
    FailWatchRunInput,
    ListDueWatchesInput,
    ListWatchRunsInput,
    ListWatchesInput,
    RecordWatchEventInput,
    StartWatchRunInput,
    UpdateWatchInput,
    WatchEventRecord,
    WatchRecord,
    WatchRunHistoryRecord,
    WatchRunRecord,
    WatchSpec,
} from "./types.js";

export interface PostgresWatchStoreOptions {
  pool: PgPoolLike;
}

function missingWatchError(watchId: string): Error {
  return new Error(`Unknown watch ${watchId}`);
}

function missingWatchRunError(runId: string): Error {
  return new Error(`Unknown watch run ${runId}`);
}

function requireWatchString(field: string, value: unknown): string {
  return requireNonEmptyString(value, `Watch ${field} must not be empty.`);
}

function optionalWatchString(field: string, value: unknown): string | undefined {
  return optionalNonEmptyString(value, `Watch ${field} must not be empty.`);
}

function normalizeIntervalMinutes(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("Watch intervalMinutes must be a positive integer.");
  }

  return value;
}

function parseIntervalMinutes(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error("Watch intervalMinutes must be a positive integer.");
  }

  return value;
}

function readOptionalJsonObject(value: unknown, field: string): JsonObject | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (!isJsonObject(value)) {
    throw new Error(`Watch ${field} must be a JSON object.`);
  }

  return value;
}

function parseWatchRunStatus(value: unknown): WatchRunRecord["status"] {
  if (
    value === "claimed"
    || value === "running"
    || value === "no_change"
    || value === "changed"
    || value === "failed"
    || value === "disabled"
  ) {
    return value;
  }

  throw new Error(`Unsupported watch run status ${String(value)}.`);
}

function parseWatchEventKind(value: unknown): WatchEventRecord["eventKind"] {
  if (value === "new_items" || value === "snapshot_changed" || value === "percent_change") {
    return value;
  }

  throw new Error(`Unsupported watch event kind ${String(value)}.`);
}

function parseWatchRow(row: Record<string, unknown>): WatchRecord {
  return {
    id: requireWatchString("id", row.id),
    sessionId: requireWatchString("session id", row.session_id),
    createdByIdentityId: optionalWatchString("created identity id", row.created_by_identity_id),
    title: requireWatchString("title", row.title),
    intervalMinutes: parseIntervalMinutes(row.interval_minutes),
    source: parseWatchSourceConfig(row.source_config),
    detector: parseWatchDetectorConfig(row.detector_config),
    enabled: requireBoolean(row.enabled, "Watch enabled flag must be a boolean."),
    nextPollAt: optionalTimestampMillis(row.next_poll_at, "Watch next_poll_at must be a valid timestamp."),
    claimedAt: optionalTimestampMillis(row.claimed_at, "Watch claimed_at must be a valid timestamp."),
    claimedBy: optionalWatchString("claim owner", row.claimed_by),
    claimExpiresAt: optionalTimestampMillis(row.claim_expires_at, "Watch claim_expires_at must be a valid timestamp."),
    cooldownUntil: optionalTimestampMillis(row.cooldown_until, "Watch cooldown_until must be a valid timestamp."),
    lastError: optionalWatchString("last error", row.last_error),
    state: readOptionalJsonObject(row.state, "state"),
    disabledAt: optionalTimestampMillis(row.disabled_at, "Watch disabled_at must be a valid timestamp."),
    createdAt: requireTimestampMillis(row.created_at, "Watch created_at must be a valid timestamp."),
    updatedAt: requireTimestampMillis(row.updated_at, "Watch updated_at must be a valid timestamp."),
  };
}

function parseWatchRunRow(row: Record<string, unknown>): WatchRunRecord {
  return {
    id: requireWatchString("run id", row.id),
    watchId: requireWatchString("id", row.watch_id),
    sessionId: requireWatchString("session id", row.session_id),
    createdByIdentityId: optionalWatchString("created identity id", row.created_by_identity_id),
    scheduledFor: requireTimestampMillis(row.scheduled_for, "Watch scheduled_for must be a valid timestamp."),
    status: parseWatchRunStatus(row.status),
    resolvedThreadId: optionalWatchString("resolved thread id", row.resolved_thread_id),
    emittedEventId: optionalWatchString("emitted event id", row.emitted_event_id),
    error: optionalWatchString("error", row.error),
    createdAt: requireTimestampMillis(row.created_at, "Watch created_at must be a valid timestamp."),
    startedAt: optionalTimestampMillis(row.started_at, "Watch started_at must be a valid timestamp."),
    finishedAt: optionalTimestampMillis(row.finished_at, "Watch finished_at must be a valid timestamp."),
  };
}

function parseWatchEventRow(row: Record<string, unknown>): WatchEventRecord {
  return {
    id: requireWatchString("event id", row.id),
    watchId: requireWatchString("id", row.watch_id),
    sessionId: requireWatchString("session id", row.session_id),
    createdByIdentityId: optionalWatchString("created identity id", row.created_by_identity_id),
    resolvedThreadId: optionalWatchString("resolved thread id", row.resolved_thread_id),
    eventKind: parseWatchEventKind(row.event_kind),
    summary: requireWatchString("summary", row.summary),
    dedupeKey: requireWatchString("dedupe key", row.dedupe_key),
    payload: readOptionalJsonObject(row.payload, "event payload"),
    createdAt: requireTimestampMillis(row.created_at, "Watch created_at must be a valid timestamp."),
  };
}

function parseWatchRunHistoryRow(row: Record<string, unknown>): WatchRunHistoryRecord {
  const run = parseWatchRunRow(row);
  const eventId = optionalWatchString("event id", row.event_id);
  if (!eventId) {
    return run;
  }

  return {
    ...run,
    event: {
      id: eventId,
      eventKind: parseWatchEventKind(row.event_kind),
      summary: requireWatchString("event summary", row.event_summary),
      dedupeKey: requireWatchString("event dedupe key", row.event_dedupe_key),
      createdAt: requireTimestampMillis(row.event_created_at, "Watch event_created_at must be a valid timestamp."),
    },
  };
}

function normalizeCreateInput(input: CreateWatchInput): {
  sessionId: string;
  createdByIdentityId?: string;
  title: string;
  intervalMinutes: number;
  source: WatchSpec["source"];
  detector: WatchSpec["detector"];
  enabled: boolean;
  state?: JsonObject;
  nextPollAt: Date | null;
} {
  const enabled = input.enabled ?? true;
  return {
    sessionId: requireWatchString("session id", input.sessionId),
    createdByIdentityId: input.createdByIdentityId?.trim() || undefined,
    title: requireWatchString("title", input.title),
    intervalMinutes: normalizeIntervalMinutes(input.intervalMinutes),
    source: input.source,
    detector: input.detector,
    enabled,
    state: input.state,
    nextPollAt: input.nextPollAt === undefined
      ? (enabled ? new Date() : null)
      : input.nextPollAt === null
        ? null
        : toDateOrNull(input.nextPollAt),
  };
}

async function readLockedWatch(
  client: PgClientLike,
  tables: WatchTableNames,
  input: Pick<UpdateWatchInput, "watchId" | "sessionId">,
): Promise<WatchRecord> {
  const result = await client.query(
    `
      SELECT *
      FROM ${tables.watches}
      WHERE id = $1
        AND session_id = $2
      FOR UPDATE
    `,
    [
      requireWatchString("id", input.watchId),
      requireWatchString("session id", input.sessionId),
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw missingWatchError(input.watchId);
  }

  return parseWatchRow(row as Record<string, unknown>);
}

export class PostgresWatchStore implements WatchStore {
  private readonly pool: PgPoolLike;
  private readonly tables: WatchTableNames;

  constructor(options: PostgresWatchStoreOptions) {
    this.pool = options.pool;
    this.tables = buildWatchTableNames();
  }

  async ensureSchema(): Promise<void> {
    await ensurePostgresWatchSchema(this.pool);
  }

  async createWatch(input: CreateWatchInput): Promise<WatchRecord> {
    const normalized = normalizeCreateInput(input);
    const result = await this.pool.query(
      `
        INSERT INTO ${this.tables.watches} (
          id,
          session_id,
          created_by_identity_id,
          title,
          interval_minutes,
          source_config,
          detector_config,
          enabled,
          next_poll_at,
          state
        ) VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6::jsonb,
          $7::jsonb,
          $8,
          $9,
          $10::jsonb
        )
        RETURNING *
      `,
      [
        randomUUID(),
        normalized.sessionId,
        normalized.createdByIdentityId ?? null,
        normalized.title,
        normalized.intervalMinutes,
        toJson(normalized.source),
        toJson(normalized.detector),
        normalized.enabled,
        normalized.nextPollAt,
        toJson(normalized.state ?? null),
      ],
    );

    return parseWatchRow(result.rows[0] as Record<string, unknown>);
  }

  async updateWatch(input: UpdateWatchInput): Promise<WatchRecord> {
    const client = await this.pool.connect();
    let inTransaction = false;

    try {
      await client.query("BEGIN");
      inTransaction = true;

      const existing = await readLockedWatch(client, this.tables, input);
      if (hasActiveClaim(existing, Date.now())) {
        throw new Error(`Watch ${existing.id} is currently running and cannot be updated.`);
      }

      const resetState = input.source !== undefined || input.detector !== undefined;
      const nextIntervalMinutes = input.intervalMinutes === undefined
        ? existing.intervalMinutes
        : normalizeIntervalMinutes(input.intervalMinutes);
      const intervalChanged = nextIntervalMinutes !== existing.intervalMinutes;
      const enabled = input.enabled ?? existing.enabled;
      const nextState = input.state === undefined
        ? (resetState ? null : existing.state ?? null)
        : input.state;
      const nextPollAt = !enabled
        ? null
        : input.nextPollAt !== undefined
          ? (input.nextPollAt === null ? null : toDateOrNull(input.nextPollAt))
          : resetState
          ? new Date()
          : intervalChanged
            ? new Date(Date.now() + nextIntervalMinutes * 60_000)
            : existing.nextPollAt === undefined
              ? null
              : new Date(existing.nextPollAt);
      const result = await client.query(
        `
          UPDATE ${this.tables.watches}
          SET title = $2,
              interval_minutes = $3,
              source_config = $4::jsonb,
              detector_config = $5::jsonb,
              enabled = $6,
              state = $7::jsonb,
              disabled_at = CASE WHEN $6 THEN NULL ELSE COALESCE(disabled_at, NOW()) END,
              next_poll_at = CASE WHEN $6 THEN COALESCE($8, NOW()) ELSE NULL END,
              last_error = CASE WHEN $9 THEN NULL ELSE last_error END,
              updated_at = NOW()
          WHERE id = $1
          RETURNING *
        `,
        [
          existing.id,
          input.title === undefined ? existing.title : requireWatchString("title", input.title),
          nextIntervalMinutes,
          toJson(input.source ?? existing.source),
          toJson(input.detector ?? existing.detector),
          enabled,
          toJson(nextState),
          nextPollAt,
          resetState,
        ],
      );

      await client.query("COMMIT");
      inTransaction = false;
      return parseWatchRow(result.rows[0] as Record<string, unknown>);
    } catch (error) {
      if (inTransaction) {
        await client.query("ROLLBACK").catch(() => undefined);
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async disableWatch(input: DisableWatchInput): Promise<WatchRecord> {
    const client = await this.pool.connect();
    let inTransaction = false;

    try {
      await client.query("BEGIN");
      inTransaction = true;

      const existing = await readLockedWatch(client, this.tables, input);
      if (hasActiveClaim(existing, Date.now())) {
        throw new Error(`Watch ${existing.id} is currently running and cannot be disabled.`);
      }

      const result = await client.query(
        `
          UPDATE ${this.tables.watches}
          SET enabled = FALSE,
              disabled_at = NOW(),
              next_poll_at = NULL,
              claimed_at = NULL,
              claimed_by = NULL,
              claim_expires_at = NULL,
              last_error = $2,
              updated_at = NOW()
          WHERE id = $1
          RETURNING *
        `,
        [
          existing.id,
          (input.reason?.trim() || existing.lastError) ?? null,
        ],
      );

      await client.query("COMMIT");
      inTransaction = false;
      return parseWatchRow(result.rows[0] as Record<string, unknown>);
    } catch (error) {
      if (inTransaction) {
        await client.query("ROLLBACK").catch(() => undefined);
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async getWatch(watchId: string): Promise<WatchRecord> {
    const result = await this.pool.query(
      `SELECT * FROM ${this.tables.watches} WHERE id = $1`,
      [requireWatchString("id", watchId)],
    );
    const row = result.rows[0];
    if (!row) {
      throw missingWatchError(watchId);
    }

    return parseWatchRow(row as Record<string, unknown>);
  }

  async listWatches(input: ListWatchesInput): Promise<readonly WatchRecord[]> {
    const status = input.status ?? "enabled";
    const limit = Math.max(1, input.limit ?? 25);
    const statusFilter = status === "enabled"
      ? "AND enabled = TRUE AND disabled_at IS NULL"
      : status === "disabled"
        ? "AND (enabled = FALSE OR disabled_at IS NOT NULL)"
        : "";
    const result = await this.pool.query(
      `
        SELECT *
        FROM ${this.tables.watches}
        WHERE session_id = $1
          ${statusFilter}
        ORDER BY enabled DESC, next_poll_at ASC NULLS LAST, created_at DESC, id ASC
        LIMIT $2
      `,
      [
        requireWatchString("session id", input.sessionId),
        limit,
      ],
    );

    return result.rows.map((row) => parseWatchRow(row as Record<string, unknown>));
  }

  async listDueWatches(input: ListDueWatchesInput = {}): Promise<readonly WatchRecord[]> {
    const asOf = new Date(input.asOf ?? Date.now());
    const limit = Math.max(1, input.limit ?? 25);
    const result = await this.pool.query(
      `
        SELECT *
        FROM ${this.tables.watches}
        WHERE enabled = TRUE
          AND disabled_at IS NULL
          AND next_poll_at IS NOT NULL
          AND next_poll_at <= $1
          AND (claim_expires_at IS NULL OR claim_expires_at <= $1)
        ORDER BY next_poll_at ASC, created_at ASC
        LIMIT $2
      `,
      [asOf, limit],
    );

    return result.rows.map((row) => parseWatchRow(row as Record<string, unknown>));
  }

  async claimWatch(input: ClaimWatchInput): Promise<ClaimWatchResult | null> {
    const client = await this.pool.connect();
    let inTransaction = false;

    try {
      await client.query("BEGIN");
      inTransaction = true;

      const result = await client.query(
        `
          SELECT *
          FROM ${this.tables.watches}
          WHERE id = $1
            AND enabled = TRUE
            AND disabled_at IS NULL
            AND next_poll_at IS NOT NULL
            AND next_poll_at <= NOW()
            AND (claim_expires_at IS NULL OR claim_expires_at <= NOW())
          FOR UPDATE
        `,
        [requireWatchString("id", input.watchId)],
      );
      const row = result.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        inTransaction = false;
        return null;
      }

      const watch = parseWatchRow(row as Record<string, unknown>);
      const scheduledFor = watch.nextPollAt ?? Date.now();
      const claimedResult = await client.query(
        `
          UPDATE ${this.tables.watches}
          SET claimed_at = NOW(),
              claimed_by = $2,
              claim_expires_at = $3,
              next_poll_at = $4,
              updated_at = NOW()
          WHERE id = $1
          RETURNING *
        `,
        [
          watch.id,
          requireWatchString("claimedBy", input.claimedBy),
          new Date(input.claimExpiresAt),
          toDateOrNull(input.nextPollAt),
        ],
      );
      const claimedWatch = parseWatchRow(claimedResult.rows[0] as Record<string, unknown>);
      const runResult = await client.query(
        `
          INSERT INTO ${this.tables.watchRuns} (
            id,
            watch_id,
            session_id,
            created_by_identity_id,
            scheduled_for,
            status
          ) VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            'claimed'
          )
          RETURNING *
        `,
        [
          randomUUID(),
          claimedWatch.id,
          claimedWatch.sessionId,
          claimedWatch.createdByIdentityId ?? null,
          new Date(scheduledFor),
        ],
      );

      await client.query("COMMIT");
      inTransaction = false;
      return {
        watch: claimedWatch,
        run: parseWatchRunRow(runResult.rows[0] as Record<string, unknown>),
      };
    } catch (error) {
      if (inTransaction) {
        await client.query("ROLLBACK").catch(() => undefined);
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async startWatchRun(input: StartWatchRunInput): Promise<WatchRunRecord> {
    const result = await this.pool.query(
      `
        UPDATE ${this.tables.watchRuns}
        SET status = 'running',
            resolved_thread_id = COALESCE($2, resolved_thread_id),
            resolved_thread_session_id = CASE
              WHEN COALESCE($2, resolved_thread_id) IS NULL THEN NULL
              ELSE session_id
            END,
            started_at = COALESCE(started_at, NOW())
        WHERE id = $1
        RETURNING *
      `,
      [
        requireWatchString("run id", input.runId),
        input.resolvedThreadId ?? null,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw missingWatchRunError(input.runId);
    }

    return parseWatchRunRow(row as Record<string, unknown>);
  }

  async completeWatchRun(input: CompleteWatchRunInput): Promise<WatchRunRecord> {
    const client = await this.pool.connect();
    let inTransaction = false;

    try {
      await client.query("BEGIN");
      inTransaction = true;

      const runResult = await client.query(
        `
          UPDATE ${this.tables.watchRuns}
          SET status = $2,
              resolved_thread_id = COALESCE($3, resolved_thread_id),
              resolved_thread_session_id = CASE
                WHEN COALESCE($3, resolved_thread_id) IS NULL THEN NULL
                ELSE session_id
              END,
              emitted_event_watch_id = CASE
                WHEN COALESCE($4, emitted_event_id) IS NULL THEN NULL
                ELSE watch_id
              END,
              emitted_event_id = COALESCE($4, emitted_event_id),
              error = NULL,
              finished_at = NOW()
          WHERE id = $1
          RETURNING *
        `,
        [
          requireWatchString("run id", input.runId),
          input.status,
          input.resolvedThreadId ?? null,
          input.emittedEventId ?? null,
        ],
      );
      const runRow = runResult.rows[0];
      if (!runRow) {
        throw missingWatchRunError(input.runId);
      }

      const run = parseWatchRunRow(runRow as Record<string, unknown>);
      await client.query(
        `
          UPDATE ${this.tables.watches}
          SET state = $2::jsonb,
              claimed_at = NULL,
              claimed_by = NULL,
              claim_expires_at = NULL,
              last_error = $3,
              updated_at = NOW()
          WHERE id = $1
        `,
        [
          run.watchId,
          toJson(input.state),
          input.lastError ?? null,
        ],
      );

      await client.query("COMMIT");
      inTransaction = false;
      return run;
    } catch (error) {
      if (inTransaction) {
        await client.query("ROLLBACK").catch(() => undefined);
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async failWatchRun(input: FailWatchRunInput): Promise<WatchRunRecord> {
    const client = await this.pool.connect();
    let inTransaction = false;

    try {
      await client.query("BEGIN");
      inTransaction = true;

      const runResult = await client.query(
        `
          UPDATE ${this.tables.watchRuns}
          SET status = 'failed',
              resolved_thread_id = COALESCE($2, resolved_thread_id),
              resolved_thread_session_id = CASE
                WHEN COALESCE($2, resolved_thread_id) IS NULL THEN NULL
                ELSE session_id
              END,
              error = $3,
              finished_at = NOW()
          WHERE id = $1
          RETURNING *
        `,
        [
          requireWatchString("run id", input.runId),
          input.resolvedThreadId ?? null,
          requireWatchString("error", input.error),
        ],
      );
      const runRow = runResult.rows[0];
      if (!runRow) {
        throw missingWatchRunError(input.runId);
      }

      const run = parseWatchRunRow(runRow as Record<string, unknown>);
      await client.query(
        `
          UPDATE ${this.tables.watches}
          SET state = COALESCE($2::jsonb, state),
              claimed_at = NULL,
              claimed_by = NULL,
              claim_expires_at = NULL,
              last_error = $3,
              updated_at = NOW()
          WHERE id = $1
        `,
        [
          run.watchId,
          toJson(input.state),
          input.error,
        ],
      );

      await client.query("COMMIT");
      inTransaction = false;
      return run;
    } catch (error) {
      if (inTransaction) {
        await client.query("ROLLBACK").catch(() => undefined);
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async clearWatchClaim(watchId: string): Promise<WatchRecord> {
    const result = await this.pool.query(
      `
        UPDATE ${this.tables.watches}
        SET claimed_at = NULL,
            claimed_by = NULL,
            claim_expires_at = NULL,
            updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [requireWatchString("id", watchId)],
    );
    const row = result.rows[0];
    if (!row) {
      throw missingWatchError(watchId);
    }

    return parseWatchRow(row as Record<string, unknown>);
  }

  async recordEvent(input: RecordWatchEventInput): Promise<RecordWatchEventResult> {
    const id = randomUUID();
    const inserted = await this.pool.query(
      `
        INSERT INTO ${this.tables.watchEvents} (
          id,
          watch_id,
          session_id,
          created_by_identity_id,
          resolved_thread_id,
          resolved_thread_session_id,
          event_kind,
          summary,
          dedupe_key,
          payload
        ) VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10::jsonb
        )
        ON CONFLICT (watch_id, dedupe_key) DO NOTHING
        RETURNING *
      `,
      [
        id,
        requireWatchString("watch id", input.watchId),
        requireWatchString("session id", input.sessionId),
        input.createdByIdentityId?.trim() || null,
        requireWatchString("resolved thread id", input.resolvedThreadId),
        requireWatchString("session id", input.sessionId),
        input.eventKind,
        requireWatchString("summary", input.summary),
        requireWatchString("dedupe key", input.dedupeKey),
        toJson(input.payload),
      ],
    );
    const insertedRow = inserted.rows[0];
    if (insertedRow) {
      const created = String((insertedRow as {id?: unknown}).id ?? "") === id;
      return {
        event: parseWatchEventRow(insertedRow as Record<string, unknown>),
        created,
      };
    }

    const existing = await this.pool.query(
      `
        SELECT *
        FROM ${this.tables.watchEvents}
        WHERE watch_id = $1 AND dedupe_key = $2
      `,
      [input.watchId, input.dedupeKey],
    );
    const row = existing.rows[0];
    if (!row) {
      throw new Error(`Unable to read existing watch event for ${input.watchId}.`);
    }

    return {
      event: parseWatchEventRow(row as Record<string, unknown>),
      created: false,
    };
  }

  async getLatestWatchRun(watchId: string): Promise<WatchRunRecord | null> {
    const result = await this.pool.query(
      `
        SELECT *
        FROM ${this.tables.watchRuns}
        WHERE watch_id = $1
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [requireWatchString("id", watchId)],
    );
    const row = result.rows[0];
    return row ? parseWatchRunRow(row as Record<string, unknown>) : null;
  }

  async listWatchRuns(input: ListWatchRunsInput): Promise<readonly WatchRunHistoryRecord[]> {
    const limit = Math.max(1, input.limit ?? 25);
    const result = await this.pool.query(
      `
        SELECT
          run.*,
          event.id AS event_id,
          event.event_kind AS event_kind,
          event.summary AS event_summary,
          event.dedupe_key AS event_dedupe_key,
          event.created_at AS event_created_at
        FROM ${this.tables.watchRuns} AS run
        LEFT JOIN ${this.tables.watchEvents} AS event
          ON event.watch_id = run.watch_id
          AND event.id = run.emitted_event_id
        WHERE run.watch_id = $1
          AND run.session_id = $2
        ORDER BY run.created_at DESC, run.id ASC
        LIMIT $3
      `,
      [
        requireWatchString("id", input.watchId),
        requireWatchString("session id", input.sessionId),
        limit,
      ],
    );

    return result.rows.map((row) => parseWatchRunHistoryRow(row as Record<string, unknown>));
  }
}
