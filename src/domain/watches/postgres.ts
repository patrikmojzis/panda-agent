import {optionalTimestampMillis, requireTimestampMillis, toJson} from "../../lib/postgres-values.js";
import {randomUUID} from "node:crypto";

import {requireBoolean} from "../../lib/booleans.js";
import {isJsonObject, type JsonObject} from "../../lib/json.js";
import {toDateOrNull} from "../../lib/dates.js";
import {optionalNonEmptyString, requireNonEmptyString} from "../../lib/strings.js";
import type {PgClientLike, PgPoolLike} from "../../lib/postgres-query.js";
import {withTransaction} from "../../lib/postgres-transaction.js";
import {enqueueSessionInputWithClient} from "../threads/runtime/postgres-inputs.js";
import {buildThreadRuntimeTableNames} from "../threads/runtime/postgres-shared.js";
import {stringToUserMessage} from "../../kernel/agent/helpers/input.js";
import {renderWatchEventPrompt} from "../../prompts/runtime/watch-events.js";
import {parseWatchDetectorConfig, parseWatchSourceConfig} from "./config.js";
import {buildWatchTableNames, type WatchTableNames} from "./postgres-shared.js";
import {buildSessionTableNames} from "../sessions/postgres-shared.js";
import type {WatchStore} from "./store.js";
import type {
    ClaimWatchInput,
    ClaimWatchResult,
    AcceptWatchEvaluationInput,
    RenewWatchClaimInput,
    CreateWatchInput,
    DisableWatchInput,
    FailWatchRunInput,
    ListDueWatchesInput,
    ListWatchRunsInput,
    ListWatchesInput,
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
    claimRunId: optionalWatchString("claim run", row.claim_run_id),
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
  private readonly sessionTables = buildSessionTableNames();
  private readonly threadTables = buildThreadRuntimeTableNames();

  constructor(options: PostgresWatchStoreOptions) {
    this.pool = options.pool;
    this.tables = buildWatchTableNames();
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

      await this.lockSession(client, input.sessionId);
      const existing = await readLockedWatch(client, this.tables, input);
      const now = await this.readClock(client);
      if ((existing.claimExpiresAt ?? 0) > now) {
        throw new Error(`Watch ${existing.id} is currently running and cannot be updated.`);
      }

      if (existing.claimRunId) await this.retireExpiredClaim(client, existing.claimRunId);
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
              claimed_at = NULL, claimed_by = NULL, claim_expires_at = NULL, claim_run_id = NULL,
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

      await this.lockSession(client, input.sessionId);
      const existing = await readLockedWatch(client, this.tables, input);
      const now = await this.readClock(client);
      if ((existing.claimExpiresAt ?? 0) > now) {
        throw new Error(`Watch ${existing.id} is currently running and cannot be disabled.`);
      }

      if (existing.claimRunId) await this.retireExpiredClaim(client, existing.claimRunId);
      const result = await client.query(
        `
          UPDATE ${this.tables.watches}
          SET enabled = FALSE,
              disabled_at = NOW(),
              next_poll_at = NULL,
              claim_run_id = NULL,
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
        SELECT watch.*
        FROM ${this.tables.watches} AS watch
        INNER JOIN ${this.sessionTables.sessions} AS session
          ON session.id = watch.session_id
         AND session.archived_at IS NULL
        WHERE watch.enabled = TRUE
          AND watch.disabled_at IS NULL
          AND watch.next_poll_at IS NOT NULL
          AND watch.next_poll_at <= $1
          AND (watch.claim_expires_at IS NULL OR watch.claim_expires_at <= $1)
        ORDER BY watch.next_poll_at ASC, watch.created_at ASC
        LIMIT $2
      `,
      [asOf, limit],
    );

    return result.rows.map((row) => parseWatchRow(row as Record<string, unknown>));
  }

  private async retireExpiredClaim(client: PgClientLike, runId: string): Promise<void> {
    await client.query(`UPDATE ${this.tables.watchRuns}
      SET status = 'failed', error = 'Watch claim expired before acceptance; retired without replay.',
          finished_at = clock_timestamp()
      WHERE id = $1 AND status IN ('claimed', 'running')`, [runId]);
  }

  private async readClock(client: PgClientLike): Promise<number> {
    const result = await client.query("SELECT clock_timestamp() AS now");
    return requireTimestampMillis((result.rows[0] as Record<string, unknown>).now, "Invalid database clock.");
  }

  private async lockSession(client: PgClientLike, sessionId: string): Promise<Record<string, unknown>> {
    const result = await client.query(`
      SELECT id, archived_at, current_thread_id, created_by_identity_id
      FROM ${this.sessionTables.sessions} WHERE id = $1 FOR UPDATE
    `, [sessionId]);
    const session = result.rows[0] as Record<string, unknown> | undefined;
    if (!session) throw new Error(`Unknown session ${sessionId}`);
    return session;
  }

  private async lockClaim(client: PgClientLike, runId: string) {
    // Session-first matches archive/reset and input admission. Never infer ownership from run order.
    const scope = await client.query(`SELECT session_id FROM ${this.tables.watchRuns} WHERE id = $1`, [runId]);
    const sessionId = (scope.rows[0] as {session_id?: string} | undefined)?.session_id;
    if (!sessionId) throw missingWatchRunError(runId);
    const session = await this.lockSession(client, sessionId);
    const watchResult = await client.query(`
      SELECT * FROM ${this.tables.watches}
      WHERE id = (SELECT watch_id FROM ${this.tables.watchRuns} WHERE id = $1) FOR UPDATE
    `, [runId]);
    const runResult = await client.query(`SELECT * FROM ${this.tables.watchRuns} WHERE id = $1 FOR UPDATE`, [runId]);
    if (!watchResult.rows[0] || !runResult.rows[0]) throw missingWatchRunError(runId);
    return {
      session,
      watch: parseWatchRow(watchResult.rows[0] as Record<string, unknown>),
      run: parseWatchRunRow(runResult.rows[0] as Record<string, unknown>),
    };
  }

  private ownsClaim(claim: Awaited<ReturnType<PostgresWatchStore["lockClaim"]>>, now: number): boolean {
    return claim.session.archived_at === null && claim.watch.enabled && !claim.watch.disabledAt
      && claim.watch.claimRunId === claim.run.id && (claim.watch.claimExpiresAt ?? 0) > now
      && (claim.run.status === "claimed" || claim.run.status === "running");
  }

  async claimWatch(input: ClaimWatchInput): Promise<ClaimWatchResult | null> {
    return withTransaction(this.pool, async (client) => {
      const scope = await client.query(`SELECT session_id FROM ${this.tables.watches} WHERE id = $1`, [input.watchId]);
      const sessionId = (scope.rows[0] as {session_id?: string} | undefined)?.session_id;
      if (!sessionId) return null;
      const session = await this.lockSession(client, sessionId);
      if (session.archived_at !== null) return null;
      const watch = await readLockedWatch(client, this.tables, {watchId: input.watchId, sessionId});
      const now = await this.readClock(client);
      if (!watch.enabled || watch.disabledAt || watch.nextPollAt === undefined || watch.nextPollAt > now
        || (watch.claimExpiresAt ?? 0) > now || input.claimExpiresAt <= now) return null;
      if (watch.claimRunId) await this.retireExpiredClaim(client, watch.claimRunId);
      const runId = randomUUID();
      const claimed = await client.query(`UPDATE ${this.tables.watches}
        SET claimed_at = $5, claimed_by = $2, claim_expires_at = $3, next_poll_at = $4,
            claim_run_id = $6, updated_at = $5
        WHERE id = $1 RETURNING *`, [watch.id, requireWatchString("claimedBy", input.claimedBy),
        new Date(input.claimExpiresAt), toDateOrNull(input.nextPollAt), new Date(now), runId]);
      const run = await client.query(`INSERT INTO ${this.tables.watchRuns}
        (id, watch_id, session_id, created_by_identity_id, scheduled_for, status)
        VALUES ($1, $2, $3, $4, $5, 'claimed') RETURNING *`,
        [runId, watch.id, watch.sessionId, watch.createdByIdentityId ?? null, new Date(watch.nextPollAt)]);
      return {watch: parseWatchRow(claimed.rows[0] as Record<string, unknown>),
        run: parseWatchRunRow(run.rows[0] as Record<string, unknown>)};
    });
  }

  async startWatchRun(input: StartWatchRunInput): Promise<WatchRunRecord | null> {
    return withTransaction(this.pool, async (client) => {
      const claim = await this.lockClaim(client, input.runId);
      if (!this.ownsClaim(claim, await this.readClock(client))) return null;
      const result = await client.query(`UPDATE ${this.tables.watchRuns}
        SET status = 'running', resolved_thread_id = $2, resolved_thread_session_id = $3,
            started_at = COALESCE(started_at, clock_timestamp()) WHERE id = $1 RETURNING *`,
        [input.runId, claim.session.current_thread_id, claim.run.sessionId]);
      return parseWatchRunRow(result.rows[0] as Record<string, unknown>);
    });
  }

  async renewWatchClaim(input: RenewWatchClaimInput): Promise<boolean> {
    if (!Number.isFinite(input.claimTtlMs) || input.claimTtlMs <= 0) throw new Error("Invalid watch claim TTL.");
    return withTransaction(this.pool, async (client) => {
      const claim = await this.lockClaim(client, input.runId);
      const now = await this.readClock(client);
      if (!this.ownsClaim(claim, now)) return false;
      await client.query(`UPDATE ${this.tables.watches}
        SET claim_expires_at = $2, updated_at = $3 WHERE id = $1 AND claim_run_id = $4`,
        [claim.watch.id, new Date(now + input.claimTtlMs), new Date(now), input.runId]);
      return true;
    });
  }

  async acceptWatchEvaluation(input: AcceptWatchEvaluationInput): Promise<WatchRunRecord | null> {
    if (input.evaluation.changed && !input.evaluation.event) throw new Error("Changed watch evaluation requires an event.");
    return withTransaction(this.pool, async (client) => {
      const claim = await this.lockClaim(client, input.runId);
      // A committed occurrence is its own receipt, even after reset/archive or a lost COMMIT acknowledgement.
      if (claim.run.status === "changed" || claim.run.status === "no_change") return claim.run;
      const changed = input.evaluation.changed;
      if (changed) {
        await client.query(`SELECT id FROM ${this.threadTables.threads} WHERE id = $1 FOR UPDATE`,
          [claim.session.current_thread_id]);
      }
      if (!this.ownsClaim(claim, await this.readClock(client))) return null;
      let threadId: string | null = null;
      const event = input.evaluation.event;
      if (changed && event) {
        const occurredIso = new Date(claim.run.scheduledFor).toISOString();
        const payload: JsonObject = {watchId: claim.watch.id, eventId: input.runId};
        if (event.payload) payload.details = event.payload;
        const enqueue = await enqueueSessionInputWithClient(client, claim.watch.sessionId, {
          message: stringToUserMessage(renderWatchEventPrompt({title: claim.watch.title,
            eventKind: event.eventKind, summary: event.summary, occurredIso, payload})),
          source: "watch_event", externalMessageId: input.runId,
          identityId: claim.watch.createdByIdentityId ?? optionalWatchString("session creator", claim.session.created_by_identity_id),
          metadata: {watchEvent: {watchId: claim.watch.id, title: claim.watch.title, eventId: input.runId,
            eventKind: event.eventKind, occurredAt: occurredIso}},
        }, "wake", {inputId: input.runId});
        threadId = enqueue.input.threadId;
        await client.query(`INSERT INTO ${this.tables.watchEvents}
          (id, watch_id, session_id, created_by_identity_id, resolved_thread_id, resolved_thread_session_id,
           event_kind, summary, dedupe_key, payload)
          VALUES ($1, $2, $3, $4, $5, $3, $6, $7, $8, $9::jsonb)`,
          [input.runId, claim.watch.id, claim.watch.sessionId, claim.watch.createdByIdentityId ?? null,
            threadId, event.eventKind, event.summary, `run:${input.runId}`, toJson(event.payload ?? null)]);
      }
      const result = await client.query(`UPDATE ${this.tables.watchRuns}
        SET status = $2, resolved_thread_id = COALESCE($3, resolved_thread_id),
            resolved_thread_session_id = CASE WHEN COALESCE($3, resolved_thread_id) IS NULL THEN NULL ELSE session_id END,
            emitted_event_id = $4, emitted_event_watch_id = CASE WHEN $4::uuid IS NULL THEN NULL ELSE watch_id END,
            error = NULL, finished_at = clock_timestamp() WHERE id = $1 RETURNING *`,
        [input.runId, changed ? "changed" : "no_change", threadId, changed ? input.runId : null]);
      await client.query(`UPDATE ${this.tables.watches}
        SET state = $2::jsonb, claimed_at = NULL, claimed_by = NULL, claim_expires_at = NULL,
            claim_run_id = NULL, last_error = NULL, updated_at = clock_timestamp()
        WHERE id = $1 AND claim_run_id = $3`, [claim.watch.id, toJson(input.evaluation.nextState), input.runId]);
      return parseWatchRunRow(result.rows[0] as Record<string, unknown>);
    });
  }

  async failWatchRun(input: FailWatchRunInput): Promise<WatchRunRecord | null> {
    return withTransaction(this.pool, async (client) => {
      const claim = await this.lockClaim(client, input.runId);
      if (claim.run.status === "failed") return claim.run;
      if (!this.ownsClaim(claim, await this.readClock(client))) return null;
      const result = await client.query(`UPDATE ${this.tables.watchRuns}
        SET status = 'failed', error = $2, finished_at = clock_timestamp() WHERE id = $1 RETURNING *`,
        [input.runId, requireWatchString("error", input.error)]);
      await client.query(`UPDATE ${this.tables.watches}
        SET claimed_at = NULL, claimed_by = NULL, claim_expires_at = NULL, claim_run_id = NULL,
            last_error = $2, updated_at = clock_timestamp() WHERE id = $1 AND claim_run_id = $3`,
        [claim.watch.id, input.error, input.runId]);
      return parseWatchRunRow(result.rows[0] as Record<string, unknown>);
    });
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
