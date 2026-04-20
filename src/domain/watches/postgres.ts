import {randomUUID} from "node:crypto";

import type {PoolClient} from "pg";

import type {JsonObject} from "../../kernel/agent/types.js";
import {toDateOrNull} from "../../lib/dates.js";
import {requireNonEmptyString} from "../../lib/strings.js";
import {buildIdentityTableNames} from "../identity/postgres-shared.js";
import {buildSessionTableNames} from "../sessions/postgres-shared.js";
import type {PgPoolLike} from "../threads/runtime/postgres-db.js";
import {
    buildThreadRuntimeTableNames,
    CREATE_RUNTIME_SCHEMA_SQL,
    quoteIdentifier,
    toJson,
    toMillis
} from "../threads/runtime/postgres-shared.js";
import {addConstraint, assertIntegrityChecks} from "../../lib/postgres-integrity.js";
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
    RecordWatchEventInput,
    StartWatchRunInput,
    UpdateWatchInput,
    WatchEventRecord,
    WatchRecord,
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

function requireTrimmed(field: string, value: string): string {
  return requireNonEmptyString(value, `Watch ${field} must not be empty.`);
}

function normalizeIntervalMinutes(value: number): number {
  const normalized = Math.floor(value);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new Error("Watch intervalMinutes must be a positive integer.");
  }

  return normalized;
}

function toDate(value: number | undefined): Date | null {
  return toDateOrNull(value);
}

function parseWatchRow(row: Record<string, unknown>): WatchRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    createdByIdentityId: row.created_by_identity_id === null ? undefined : String(row.created_by_identity_id),
    title: String(row.title),
    intervalMinutes: Number(row.interval_minutes),
    source: row.source_config as WatchRecord["source"],
    detector: row.detector_config as WatchRecord["detector"],
    enabled: Boolean(row.enabled),
    nextPollAt: row.next_poll_at === null ? undefined : toMillis(row.next_poll_at),
    claimedAt: row.claimed_at === null ? undefined : toMillis(row.claimed_at),
    claimedBy: row.claimed_by === null ? undefined : String(row.claimed_by),
    claimExpiresAt: row.claim_expires_at === null ? undefined : toMillis(row.claim_expires_at),
    cooldownUntil: row.cooldown_until === null ? undefined : toMillis(row.cooldown_until),
    lastError: row.last_error === null ? undefined : String(row.last_error),
    state: row.state === null ? undefined : (row.state as WatchRecord["state"]),
    disabledAt: row.disabled_at === null ? undefined : toMillis(row.disabled_at),
    createdAt: toMillis(row.created_at),
    updatedAt: toMillis(row.updated_at),
  };
}

function parseWatchRunRow(row: Record<string, unknown>): WatchRunRecord {
  return {
    id: String(row.id),
    watchId: String(row.watch_id),
    sessionId: String(row.session_id),
    createdByIdentityId: row.created_by_identity_id === null ? undefined : String(row.created_by_identity_id),
    scheduledFor: toMillis(row.scheduled_for),
    status: String(row.status) as WatchRunRecord["status"],
    resolvedThreadId: row.resolved_thread_id === null ? undefined : String(row.resolved_thread_id),
    emittedEventId: row.emitted_event_id === null ? undefined : String(row.emitted_event_id),
    error: row.error === null ? undefined : String(row.error),
    createdAt: toMillis(row.created_at),
    startedAt: row.started_at === null ? undefined : toMillis(row.started_at),
    finishedAt: row.finished_at === null ? undefined : toMillis(row.finished_at),
  };
}

function parseWatchEventRow(row: Record<string, unknown>): WatchEventRecord {
  return {
    id: String(row.id),
    watchId: String(row.watch_id),
    sessionId: String(row.session_id),
    createdByIdentityId: row.created_by_identity_id === null ? undefined : String(row.created_by_identity_id),
    resolvedThreadId: row.resolved_thread_id === null ? undefined : String(row.resolved_thread_id),
    eventKind: String(row.event_kind) as WatchEventRecord["eventKind"],
    summary: String(row.summary),
    dedupeKey: String(row.dedupe_key),
    payload: row.payload === null ? undefined : row.payload as JsonObject,
    createdAt: toMillis(row.created_at),
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
    sessionId: requireTrimmed("session id", input.sessionId),
    createdByIdentityId: input.createdByIdentityId?.trim() || undefined,
    title: requireTrimmed("title", input.title),
    intervalMinutes: normalizeIntervalMinutes(input.intervalMinutes),
    source: input.source,
    detector: input.detector,
    enabled,
    state: input.state,
    nextPollAt: input.nextPollAt === undefined
      ? (enabled ? new Date() : null)
      : input.nextPollAt === null
        ? null
        : toDate(input.nextPollAt),
  };
}

function isActiveClaim(watch: WatchRecord, nowMs: number): boolean {
  return watch.claimedAt !== undefined
    && watch.claimExpiresAt !== undefined
    && watch.claimExpiresAt > nowMs;
}

async function readLockedWatch(
  client: PoolClient,
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
      requireTrimmed("id", input.watchId),
      requireTrimmed("session id", input.sessionId),
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
  private readonly identityTableName: string;
  private readonly sessionTableName: string;
  private readonly threadTableName: string;

  constructor(options: PostgresWatchStoreOptions) {
    this.pool = options.pool;
    this.tables = buildWatchTableNames();
    this.identityTableName = buildIdentityTableNames().identities;
    this.sessionTableName = buildSessionTableNames().sessions;
    this.threadTableName = buildThreadRuntimeTableNames().threads;
  }

  async ensureSchema(): Promise<void> {
    await this.pool.query(CREATE_RUNTIME_SCHEMA_SQL);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.watches} (
        id UUID PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES ${this.sessionTableName}(id) ON DELETE CASCADE,
        created_by_identity_id TEXT REFERENCES ${this.identityTableName}(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        interval_minutes INTEGER NOT NULL,
        source_config JSONB NOT NULL,
        detector_config JSONB NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        next_poll_at TIMESTAMPTZ,
        claimed_at TIMESTAMPTZ,
        claimed_by TEXT,
        claim_expires_at TIMESTAMPTZ,
        cooldown_until TIMESTAMPTZ,
        last_error TEXT,
        state JSONB,
        disabled_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_watches_due_idx`)}
      ON ${this.tables.watches} (enabled, disabled_at, next_poll_at, id)
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_watches_identity_agent_idx`)}
      ON ${this.tables.watches} (session_id, created_at DESC)
    `);
    await this.pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_watches_session_id_id_idx`)}
      ON ${this.tables.watches} (session_id, id)
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.watchRuns} (
        id UUID PRIMARY KEY,
        watch_id UUID NOT NULL REFERENCES ${this.tables.watches}(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES ${this.sessionTableName}(id) ON DELETE CASCADE,
        created_by_identity_id TEXT REFERENCES ${this.identityTableName}(id) ON DELETE SET NULL,
        scheduled_for TIMESTAMPTZ NOT NULL,
        status TEXT NOT NULL,
        resolved_thread_id TEXT,
        resolved_thread_session_id TEXT,
        emitted_event_watch_id UUID,
        emitted_event_id UUID,
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_watch_runs_watch_created_idx`)}
      ON ${this.tables.watchRuns} (watch_id, created_at DESC)
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.watchEvents} (
        id UUID PRIMARY KEY,
        watch_id UUID NOT NULL REFERENCES ${this.tables.watches}(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES ${this.sessionTableName}(id) ON DELETE CASCADE,
        created_by_identity_id TEXT REFERENCES ${this.identityTableName}(id) ON DELETE SET NULL,
        resolved_thread_id TEXT,
        resolved_thread_session_id TEXT,
        event_kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        payload JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_watch_events_dedupe_idx`)}
      ON ${this.tables.watchEvents} (watch_id, dedupe_key)
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_watch_events_watch_created_idx`)}
      ON ${this.tables.watchEvents} (watch_id, created_at DESC)
    `);
    await this.pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_watch_events_watch_id_id_idx`)}
      ON ${this.tables.watchEvents} (watch_id, id)
    `);
    await this.pool.query(`
      ALTER TABLE ${this.tables.watchRuns}
      ADD COLUMN IF NOT EXISTS resolved_thread_session_id TEXT
    `);
    await this.pool.query(`
      ALTER TABLE ${this.tables.watchRuns}
      ADD COLUMN IF NOT EXISTS emitted_event_watch_id UUID
    `);
    await this.pool.query(`
      ALTER TABLE ${this.tables.watchEvents}
      ADD COLUMN IF NOT EXISTS resolved_thread_session_id TEXT
    `);
    await this.pool.query(`
      ALTER TABLE ${this.tables.watchEvents}
      ALTER COLUMN resolved_thread_id DROP NOT NULL
    `);
    await assertIntegrityChecks(this.pool, "Watch schema", [
      {
        label: "watch_runs.watch_id orphaned from watches.id",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM ${this.tables.watchRuns} AS run
          LEFT JOIN ${this.tables.watches} AS watch
            ON watch.id = run.watch_id
          WHERE watch.id IS NULL
        `,
      },
      {
        label: "watch_runs watch/session mismatch",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM ${this.tables.watchRuns} AS run
          INNER JOIN ${this.tables.watches} AS watch
            ON watch.id = run.watch_id
          WHERE watch.session_id <> run.session_id
        `,
      },
      {
        label: "watch_runs.resolved_thread_id orphaned from threads.id",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM ${this.tables.watchRuns} AS run
          LEFT JOIN ${this.threadTableName} AS thread
            ON thread.id = run.resolved_thread_id
          WHERE run.resolved_thread_id IS NOT NULL
            AND thread.id IS NULL
        `,
      },
      {
        label: "watch_runs.resolved_thread_id bound to another session",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM ${this.tables.watchRuns} AS run
          INNER JOIN ${this.threadTableName} AS thread
            ON thread.id = run.resolved_thread_id
          WHERE run.resolved_thread_id IS NOT NULL
            AND thread.session_id <> run.session_id
        `,
      },
      {
        label: "watch_runs.emitted_event_id orphaned from watch_events.id",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM ${this.tables.watchRuns} AS run
          LEFT JOIN ${this.tables.watchEvents} AS event
            ON event.id = run.emitted_event_id
          WHERE run.emitted_event_id IS NOT NULL
            AND event.id IS NULL
        `,
      },
      {
        label: "watch_runs.emitted_event_id bound to another watch",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM ${this.tables.watchRuns} AS run
          INNER JOIN ${this.tables.watchEvents} AS event
            ON event.id = run.emitted_event_id
          WHERE run.emitted_event_id IS NOT NULL
            AND event.watch_id <> run.watch_id
        `,
      },
      {
        label: "watch_events watch/session mismatch",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM ${this.tables.watchEvents} AS event
          INNER JOIN ${this.tables.watches} AS watch
            ON watch.id = event.watch_id
          WHERE watch.session_id <> event.session_id
        `,
      },
      {
        label: "watch_events.resolved_thread_id orphaned from threads.id",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM ${this.tables.watchEvents} AS event
          LEFT JOIN ${this.threadTableName} AS thread
            ON thread.id = event.resolved_thread_id
          WHERE event.resolved_thread_id IS NOT NULL
            AND thread.id IS NULL
        `,
      },
      {
        label: "watch_events.resolved_thread_id bound to another session",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM ${this.tables.watchEvents} AS event
          INNER JOIN ${this.threadTableName} AS thread
            ON thread.id = event.resolved_thread_id
          WHERE event.resolved_thread_id IS NOT NULL
            AND thread.session_id <> event.session_id
        `,
      },
    ]);
    await this.pool.query(`
      UPDATE ${this.tables.watchRuns}
      SET resolved_thread_session_id = NULL
      WHERE resolved_thread_id IS NULL
        AND resolved_thread_session_id IS NOT NULL
    `);
    await this.pool.query(`
      UPDATE ${this.tables.watchRuns}
      SET resolved_thread_session_id = thread.session_id
      FROM ${this.threadTableName} AS thread
      WHERE ${this.tables.watchRuns}.resolved_thread_id IS NOT NULL
        AND thread.id = ${this.tables.watchRuns}.resolved_thread_id
        AND (
          ${this.tables.watchRuns}.resolved_thread_session_id IS NULL
          OR ${this.tables.watchRuns}.resolved_thread_session_id <> thread.session_id
        )
    `);
    await this.pool.query(`
      UPDATE ${this.tables.watchRuns}
      SET emitted_event_watch_id = NULL
      WHERE emitted_event_id IS NULL
        AND emitted_event_watch_id IS NOT NULL
    `);
    await this.pool.query(`
      UPDATE ${this.tables.watchRuns}
      SET emitted_event_watch_id = event.watch_id
      FROM ${this.tables.watchEvents} AS event
      WHERE ${this.tables.watchRuns}.emitted_event_id IS NOT NULL
        AND event.id = ${this.tables.watchRuns}.emitted_event_id
        AND (
          ${this.tables.watchRuns}.emitted_event_watch_id IS NULL
          OR ${this.tables.watchRuns}.emitted_event_watch_id <> event.watch_id
        )
    `);
    await this.pool.query(`
      UPDATE ${this.tables.watchEvents}
      SET resolved_thread_session_id = NULL
      WHERE resolved_thread_id IS NULL
        AND resolved_thread_session_id IS NOT NULL
    `);
    await this.pool.query(`
      UPDATE ${this.tables.watchEvents}
      SET resolved_thread_session_id = thread.session_id
      FROM ${this.threadTableName} AS thread
      WHERE ${this.tables.watchEvents}.resolved_thread_id IS NOT NULL
        AND thread.id = ${this.tables.watchEvents}.resolved_thread_id
        AND (
          ${this.tables.watchEvents}.resolved_thread_session_id IS NULL
          OR ${this.tables.watchEvents}.resolved_thread_session_id <> thread.session_id
        )
    `);
    await addConstraint(this.pool, `
      ALTER TABLE ${this.tables.watchRuns}
      ADD CONSTRAINT ${quoteIdentifier(`${this.tables.prefix}_watch_runs_watch_scope_fk`)}
      FOREIGN KEY (session_id, watch_id)
      REFERENCES ${this.tables.watches}(session_id, id)
      ON DELETE CASCADE
    `);
    await addConstraint(this.pool, `
      ALTER TABLE ${this.tables.watchRuns}
      ADD CONSTRAINT ${quoteIdentifier(`${this.tables.prefix}_watch_runs_resolved_thread_fk`)}
      FOREIGN KEY (resolved_thread_id)
      REFERENCES ${this.threadTableName}(id)
      ON DELETE SET NULL
    `);
    await addConstraint(this.pool, `
      ALTER TABLE ${this.tables.watchRuns}
      ADD CONSTRAINT ${quoteIdentifier(`${this.tables.prefix}_watch_runs_emitted_event_fk`)}
      FOREIGN KEY (emitted_event_id)
      REFERENCES ${this.tables.watchEvents}(id)
      ON DELETE SET NULL
    `);
    await addConstraint(this.pool, `
      ALTER TABLE ${this.tables.watchRuns}
      ADD CONSTRAINT ${quoteIdentifier(`${this.tables.prefix}_watch_runs_emitted_event_scope_check`)}
      CHECK (
        (
          emitted_event_id IS NULL
          AND emitted_event_watch_id IS NULL
        ) OR (
          emitted_event_id IS NOT NULL
          AND emitted_event_watch_id = watch_id
        )
      )
    `);
    await addConstraint(this.pool, `
      ALTER TABLE ${this.tables.watchRuns}
      ADD CONSTRAINT ${quoteIdentifier(`${this.tables.prefix}_watch_runs_emitted_event_scope_fk`)}
      FOREIGN KEY (emitted_event_watch_id, emitted_event_id)
      REFERENCES ${this.tables.watchEvents}(watch_id, id)
      ON DELETE SET NULL
    `);
    await addConstraint(this.pool, `
      ALTER TABLE ${this.tables.watchRuns}
      ADD CONSTRAINT ${quoteIdentifier(`${this.tables.prefix}_watch_runs_resolved_thread_scope_check`)}
      CHECK (
        (
          resolved_thread_id IS NULL
          AND resolved_thread_session_id IS NULL
        ) OR (
          resolved_thread_id IS NOT NULL
          AND resolved_thread_session_id = session_id
        )
      )
    `);
    await addConstraint(this.pool, `
      ALTER TABLE ${this.tables.watchRuns}
      ADD CONSTRAINT ${quoteIdentifier(`${this.tables.prefix}_watch_runs_resolved_thread_scope_fk`)}
      FOREIGN KEY (resolved_thread_session_id, resolved_thread_id)
      REFERENCES ${this.threadTableName}(session_id, id)
      ON DELETE SET NULL
    `);
    await addConstraint(this.pool, `
      ALTER TABLE ${this.tables.watchEvents}
      ADD CONSTRAINT ${quoteIdentifier(`${this.tables.prefix}_watch_events_watch_scope_fk`)}
      FOREIGN KEY (session_id, watch_id)
      REFERENCES ${this.tables.watches}(session_id, id)
      ON DELETE CASCADE
    `);
    await addConstraint(this.pool, `
      ALTER TABLE ${this.tables.watchEvents}
      ADD CONSTRAINT ${quoteIdentifier(`${this.tables.prefix}_watch_events_resolved_thread_fk`)}
      FOREIGN KEY (resolved_thread_id)
      REFERENCES ${this.threadTableName}(id)
      ON DELETE SET NULL
    `);
    await addConstraint(this.pool, `
      ALTER TABLE ${this.tables.watchEvents}
      ADD CONSTRAINT ${quoteIdentifier(`${this.tables.prefix}_watch_events_resolved_thread_scope_check`)}
      CHECK (
        (
          resolved_thread_id IS NULL
          AND resolved_thread_session_id IS NULL
        ) OR (
          resolved_thread_id IS NOT NULL
          AND resolved_thread_session_id = session_id
        )
      )
    `);
    await addConstraint(this.pool, `
      ALTER TABLE ${this.tables.watchEvents}
      ADD CONSTRAINT ${quoteIdentifier(`${this.tables.prefix}_watch_events_resolved_thread_scope_fk`)}
      FOREIGN KEY (resolved_thread_session_id, resolved_thread_id)
      REFERENCES ${this.threadTableName}(session_id, id)
      ON DELETE SET NULL
    `);
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
      if (isActiveClaim(existing, Date.now())) {
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
          ? (input.nextPollAt === null ? null : toDate(input.nextPollAt))
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
          input.title === undefined ? existing.title : requireTrimmed("title", input.title),
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
      if (isActiveClaim(existing, Date.now())) {
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
      [requireTrimmed("id", watchId)],
    );
    const row = result.rows[0];
    if (!row) {
      throw missingWatchError(watchId);
    }

    return parseWatchRow(row as Record<string, unknown>);
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
        [requireTrimmed("id", input.watchId)],
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
          requireTrimmed("claimedBy", input.claimedBy),
          new Date(input.claimExpiresAt),
          toDate(input.nextPollAt),
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
        requireTrimmed("run id", input.runId),
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
          requireTrimmed("run id", input.runId),
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
          requireTrimmed("run id", input.runId),
          input.resolvedThreadId ?? null,
          requireTrimmed("error", input.error),
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
      [requireTrimmed("id", watchId)],
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
        requireTrimmed("watch id", input.watchId),
        requireTrimmed("session id", input.sessionId),
        input.createdByIdentityId?.trim() || null,
        requireTrimmed("resolved thread id", input.resolvedThreadId),
        requireTrimmed("session id", input.sessionId),
        input.eventKind,
        requireTrimmed("summary", input.summary),
        requireTrimmed("dedupe key", input.dedupeKey),
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
      [requireTrimmed("id", watchId)],
    );
    const row = result.rows[0];
    return row ? parseWatchRunRow(row as Record<string, unknown>) : null;
  }
}
