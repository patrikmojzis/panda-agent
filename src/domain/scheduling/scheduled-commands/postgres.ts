import {randomUUID} from "node:crypto";

import type {PgClientLike, PgPoolLike} from "../../../lib/postgres-query.js";
import {buildSessionTableNames} from "../../sessions/postgres-shared.js";
import {buildThreadRuntimeTableNames} from "../../threads/runtime/postgres-shared.js";
import {buildScheduledCommandTableNames} from "./postgres-shared.js";
import {ScheduledCommandVersionConflictError, type ScheduledCommandStore} from "./store.js";
import type {
  ClaimedScheduledCommand,
  ClaimedScheduledCommandRun,
  CreateScheduledCommandInput,
  ReplaceScheduledCommandVersionInput,
  ScheduledCommandListStatus,
  ScheduledCommandRecord,
  ScheduledCommandRunRecord,
  SettleScheduledCommandRunInput,
} from "./types.js";

const DEFAULT_READ_LIMIT = 25;
const MAX_READ_LIMIT = 100;

export interface PostgresScheduledCommandStoreOptions {
  pool: PgPoolLike;
}

function requireString(field: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Scheduled command ${field} must not be empty.`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function timestamp(value: unknown, field: string): number {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value));
  if (!Number.isFinite(parsed)) {
    throw new Error(`Scheduled command ${field} is invalid.`);
  }
  return parsed;
}

function optionalTimestamp(value: unknown, field: string): number | undefined {
  return value === null || value === undefined ? undefined : timestamp(value, field);
}

function integer(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Scheduled command ${field} is invalid.`);
  }
  return parsed;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Scheduled command ${field} is invalid.`);
  }
  return value;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`Scheduled command ${field} is invalid.`);
  }
  return [...value] as string[];
}

function readLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_READ_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_READ_LIMIT) {
    throw new Error(`Scheduled command read limit must be between 1 and ${MAX_READ_LIMIT}.`);
  }
  return limit;
}

function parseCommand(row: Record<string, unknown>): ScheduledCommandRecord {
  return {
    commandId: requireString("id", row.command_id),
    sessionId: requireString("session id", row.session_id),
    version: integer(row.version, "version"),
    title: requireString("title", row.title),
    command: requireString("command", row.command_text),
    ...(optionalString(row.cwd) ? {cwd: optionalString(row.cwd)} : {}),
    cron: requireString("cron", row.cron_expr),
    timezone: requireString("timezone", row.timezone),
    credentialNames: stringArray(row.credential_names, "credential names"),
    timeoutMs: integer(row.timeout_ms, "timeout"),
    enabled: boolean(row.enabled, "enabled"),
    keyId: requireString("key id", row.key_id),
    integrityTag: requireString("integrity tag", row.integrity_tag),
    ...(optionalString(row.created_by_identity_id) ? {createdByIdentityId: optionalString(row.created_by_identity_id)} : {}),
    ...(optionalString(row.created_from_message_id) ? {createdFromMessageId: optionalString(row.created_from_message_id)} : {}),
    ...(optionalTimestamp(row.next_fire_at, "next fire time") !== undefined
      ? {nextFireAt: optionalTimestamp(row.next_fire_at, "next fire time")}
      : {}),
    ...(optionalTimestamp(row.blocked_at, "blocked time") !== undefined
      ? {blockedAt: optionalTimestamp(row.blocked_at, "blocked time")}
      : {}),
    ...(optionalString(row.blocked_reason) ? {blockedReason: optionalString(row.blocked_reason)} : {}),
    consecutiveFailures: integer(row.consecutive_failures, "consecutive failures"),
    ...(optionalString(row.last_failure_code) ? {lastFailureCode: optionalString(row.last_failure_code)} : {}),
    ...(optionalString(row.last_notified_failure_code)
      ? {lastNotifiedFailureCode: optionalString(row.last_notified_failure_code)}
      : {}),
    createdAt: timestamp(row.command_created_at, "created time"),
    updatedAt: timestamp(row.updated_at, "updated time"),
  };
}

function parseRun(row: Record<string, unknown>): ScheduledCommandRunRecord {
  const trigger = row.trigger;
  const status = row.status;
  const notificationKind = row.notification_kind;
  if (trigger !== "schedule" && trigger !== "manual") {
    throw new Error("Scheduled command run trigger is invalid.");
  }
  if (!new Set(["pending", "claimed", "running", "succeeded", "failed", "cancelled"]).has(String(status))) {
    throw new Error("Scheduled command run status is invalid.");
  }
  if (notificationKind !== null && notificationKind !== undefined && notificationKind !== "failure" && notificationKind !== "recovery") {
    throw new Error("Scheduled command notification kind is invalid.");
  }
  return {
    id: requireString("run id", row.run_id ?? row.id),
    commandId: requireString("id", row.command_id),
    sessionId: requireString("session id", row.session_id),
    version: integer(row.version, "run version"),
    trigger,
    scheduledFor: timestamp(row.scheduled_for, "scheduled time"),
    status: status as ScheduledCommandRunRecord["status"],
    ...(optionalString(row.claim_token) ? {claimToken: optionalString(row.claim_token)} : {}),
    ...(optionalTimestamp(row.claimed_at, "claimed time") !== undefined ? {claimedAt: optionalTimestamp(row.claimed_at, "claimed time")} : {}),
    ...(optionalString(row.claimed_by) ? {claimedBy: optionalString(row.claimed_by)} : {}),
    ...(optionalTimestamp(row.claim_expires_at, "claim expiration") !== undefined
      ? {claimExpiresAt: optionalTimestamp(row.claim_expires_at, "claim expiration")}
      : {}),
    ...(optionalString(row.resolved_environment_id) ? {resolvedEnvironmentId: optionalString(row.resolved_environment_id)} : {}),
    ...(optionalString(row.resolved_cwd) ? {resolvedCwd: optionalString(row.resolved_cwd)} : {}),
    ...(row.exit_code === null || row.exit_code === undefined ? {} : {exitCode: integer(row.exit_code, "exit code")}),
    ...(typeof row.timed_out === "boolean" ? {timedOut: row.timed_out} : {}),
    ...(typeof row.stdout_preview === "string" ? {stdout: row.stdout_preview} : {}),
    ...(typeof row.stderr_preview === "string" ? {stderr: row.stderr_preview} : {}),
    ...(typeof row.stdout_truncated === "boolean" ? {stdoutTruncated: row.stdout_truncated} : {}),
    ...(typeof row.stderr_truncated === "boolean" ? {stderrTruncated: row.stderr_truncated} : {}),
    ...(optionalString(row.failure_code) ? {failureCode: optionalString(row.failure_code)} : {}),
    ...(optionalString(row.error) ? {error: optionalString(row.error)} : {}),
    ...(notificationKind ? {notificationKind} : {}),
    ...(optionalTimestamp(row.notified_at, "notification time") !== undefined
      ? {notifiedAt: optionalTimestamp(row.notified_at, "notification time")}
      : {}),
    createdAt: timestamp(row.created_at, "run created time"),
    ...(optionalTimestamp(row.started_at, "started time") !== undefined
      ? {startedAt: optionalTimestamp(row.started_at, "started time")}
      : {}),
    ...(optionalTimestamp(row.finished_at, "finished time") !== undefined
      ? {finishedAt: optionalTimestamp(row.finished_at, "finished time")}
      : {}),
  };
}

function commandSelect(versionJoin: string): string {
  return `
    command_row.id AS command_id,
    command_row.session_id,
    command_row.created_by_identity_id,
    command_row.created_from_message_id,
    command_row.next_fire_at,
    command_row.blocked_at,
    command_row.blocked_reason,
    command_row.consecutive_failures,
    command_row.last_failure_code,
    command_row.last_notified_failure_code,
    command_row.created_at AS command_created_at,
    command_row.updated_at,
    ${versionJoin}.version,
    ${versionJoin}.title,
    ${versionJoin}.command_text,
    ${versionJoin}.cwd,
    ${versionJoin}.cron_expr,
    ${versionJoin}.timezone,
    ${versionJoin}.credential_names,
    ${versionJoin}.timeout_ms,
    ${versionJoin}.enabled,
    ${versionJoin}.key_id,
    ${versionJoin}.integrity_tag
  `;
}

function missingCommand(commandId: string): Error {
  return new Error(`Scheduled command ${commandId} does not exist.`);
}

function rejectedMutation(runId: string, operation: string): Error {
  return new Error(`Scheduled command run ${runId} could not ${operation}; its claim or state changed.`);
}

export class PostgresScheduledCommandStore implements ScheduledCommandStore {
  private readonly pool: PgPoolLike;
  private readonly tables = buildScheduledCommandTableNames();
  private readonly sessions = buildSessionTableNames();
  private readonly threads = buildThreadRuntimeTableNames();

  constructor(options: PostgresScheduledCommandStoreOptions) {
    this.pool = options.pool;
  }

  async createCommand(input: CreateScheduledCommandInput): Promise<ScheduledCommandRecord> {
    const client = await this.pool.connect();
    let transaction = false;
    try {
      await client.query("BEGIN");
      transaction = true;
      if (input.createdFromMessageId) {
        const provenance = await client.query(`
          SELECT message.id
          FROM ${this.threads.messages} AS message
          INNER JOIN ${this.threads.threads} AS thread ON thread.id = message.thread_id
          WHERE message.id = $1 AND thread.session_id = $2
        `, [input.createdFromMessageId, input.sessionId]);
        if (provenance.rows.length === 0) {
          throw new Error(`Scheduled command provenance input ${input.createdFromMessageId} does not belong to session ${input.sessionId}.`);
        }
      }
      await client.query(`
        INSERT INTO ${this.tables.scheduledCommands} (
          id, session_id, created_by_identity_id, created_from_message_id,
          active_version, next_fire_at
        ) VALUES ($1, $2, $3, $4, 1, $5)
      `, [input.id, input.sessionId, input.createdByIdentityId ?? null, input.createdFromMessageId ?? null,
        input.nextFireAt === undefined ? null : new Date(input.nextFireAt)]);
      await client.query(`
        INSERT INTO ${this.tables.scheduledCommandVersions} (
          command_id, session_id, version, title, command_text, cwd, cron_expr,
          timezone, credential_names, timeout_ms, enabled, key_id, integrity_tag
        ) VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      `, [input.id, input.sessionId, input.definition.title, input.definition.command, input.definition.cwd ?? null,
        input.definition.cron, input.definition.timezone, [...input.definition.credentialNames], input.definition.timeoutMs,
        input.definition.enabled, input.definition.keyId, input.definition.integrityTag]);
      const record = await this.readCommand(client, input.id);
      await client.query("COMMIT");
      transaction = false;
      return record;
    } catch (error) {
      if (transaction) await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async replaceVersion(input: ReplaceScheduledCommandVersionInput): Promise<ScheduledCommandRecord> {
    const client = await this.pool.connect();
    let transaction = false;
    try {
      await client.query("BEGIN");
      transaction = true;
      const locked = await client.query(`
        SELECT active_version, blocked_at
        FROM ${this.tables.scheduledCommands}
        WHERE id = $1 AND session_id = $2
        FOR UPDATE
      `, [input.commandId, input.sessionId]);
      const row = locked.rows[0] as Record<string, unknown> | undefined;
      if (!row) throw missingCommand(input.commandId);
      if (row.blocked_at !== null && row.blocked_at !== undefined) {
        throw new Error(`Scheduled command ${input.commandId} is blocked and can only be deleted.`);
      }
      const currentVersion = integer(row.active_version, "active version");
      if (currentVersion !== input.expectedVersion) {
        throw new ScheduledCommandVersionConflictError(input.commandId, currentVersion);
      }
      const version = currentVersion + 1;
      await client.query(`
        INSERT INTO ${this.tables.scheduledCommandVersions} (
          command_id, session_id, version, title, command_text, cwd, cron_expr,
          timezone, credential_names, timeout_ms, enabled, key_id, integrity_tag
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      `, [input.commandId, input.sessionId, version, input.definition.title, input.definition.command,
        input.definition.cwd ?? null, input.definition.cron, input.definition.timezone,
        [...input.definition.credentialNames], input.definition.timeoutMs, input.definition.enabled,
        input.definition.keyId, input.definition.integrityTag]);
      await client.query(`
        UPDATE ${this.tables.scheduledCommands}
        SET active_version = $3,
            next_fire_at = $4,
            updated_at = NOW()
        WHERE id = $1 AND session_id = $2 AND active_version = $5
      `, [input.commandId, input.sessionId, version,
        input.nextFireAt === undefined ? null : new Date(input.nextFireAt), input.expectedVersion]);
      const record = await this.readCommand(client, input.commandId);
      await client.query("COMMIT");
      transaction = false;
      return record;
    } catch (error) {
      if (transaction) await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteCommand(input: {commandId: string; sessionId: string; expectedVersion: number}): Promise<boolean> {
    const client = await this.pool.connect();
    let transaction = false;
    try {
      await client.query("BEGIN");
      transaction = true;
      const locked = await client.query(`
        SELECT active_version
        FROM ${this.tables.scheduledCommands}
        WHERE id = $1 AND session_id = $2
        FOR UPDATE
      `, [input.commandId, input.sessionId]);
      const row = locked.rows[0] as Record<string, unknown> | undefined;
      if (!row) {
        await client.query("COMMIT");
        transaction = false;
        return false;
      }
      const currentVersion = integer(row.active_version, "active version");
      if (currentVersion !== input.expectedVersion) {
        throw new ScheduledCommandVersionConflictError(input.commandId, currentVersion);
      }
      await client.query(`
        DELETE FROM ${this.tables.scheduledCommands}
        WHERE id = $1 AND session_id = $2
      `, [input.commandId, input.sessionId]);
      await client.query("COMMIT");
      transaction = false;
      return true;
    } catch (error) {
      if (transaction) await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getCommand(commandId: string): Promise<ScheduledCommandRecord> {
    return this.readCommand(this.pool, requireString("id", commandId));
  }

  async listCommands(input: {sessionId: string; status?: ScheduledCommandListStatus; limit?: number}): Promise<readonly ScheduledCommandRecord[]> {
    const status = input.status ?? "active";
    const filter = status === "active"
      ? "AND version_row.enabled = TRUE AND command_row.blocked_at IS NULL"
      : status === "disabled"
        ? "AND version_row.enabled = FALSE AND command_row.blocked_at IS NULL"
        : status === "blocked"
          ? "AND command_row.blocked_at IS NOT NULL"
          : "";
    const result = await this.pool.query(`
      SELECT ${commandSelect("version_row")}
      FROM ${this.tables.scheduledCommands} AS command_row
      INNER JOIN ${this.tables.scheduledCommandVersions} AS version_row
        ON version_row.command_id = command_row.id
       AND version_row.version = command_row.active_version
      WHERE command_row.session_id = $1
        ${filter}
      ORDER BY command_row.next_fire_at ASC NULLS LAST, command_row.updated_at DESC, command_row.id ASC
      LIMIT $2
    `, [requireString("session id", input.sessionId), readLimit(input.limit)]);
    return result.rows.map((row) => parseCommand(row as Record<string, unknown>));
  }

  async listRuns(input: {commandId: string; sessionId: string; limit?: number}): Promise<readonly ScheduledCommandRunRecord[]> {
    const result = await this.pool.query(`
      SELECT run.id AS run_id, run.*
      FROM ${this.tables.scheduledCommandRuns} AS run
      WHERE run.command_id = $1 AND run.session_id = $2
      ORDER BY run.created_at DESC, run.id ASC
      LIMIT $3
    `, [input.commandId, input.sessionId, readLimit(input.limit)]);
    return result.rows.map((row) => parseRun(row as Record<string, unknown>));
  }

  async enqueueManualRun(input: {commandId: string; sessionId: string; expectedVersion: number}): Promise<ScheduledCommandRunRecord> {
    const result = await this.pool.query(`
      INSERT INTO ${this.tables.scheduledCommandRuns} (
        id, command_id, session_id, version, trigger, scheduled_for, status
      )
      SELECT $4, command_row.id, command_row.session_id, command_row.active_version, 'manual', NOW(), 'pending'
      FROM ${this.tables.scheduledCommands} AS command_row
      INNER JOIN ${this.sessions.sessions} AS session ON session.id = command_row.session_id
      WHERE command_row.id = $1
        AND command_row.session_id = $2
        AND command_row.active_version = $3
        AND command_row.blocked_at IS NULL
        AND session.archived_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM ${this.tables.scheduledCommandRuns} AS active
          WHERE active.command_id = command_row.id
            AND (active.status IN ('pending', 'claimed', 'running')
              OR (active.notification_kind IS NOT NULL AND active.notified_at IS NULL))
        )
      RETURNING id AS run_id, *
    `, [input.commandId, input.sessionId, input.expectedVersion, randomUUID()]);
    const row = result.rows[0];
    if (!row) {
      const current = await this.pool.query(`
        SELECT active_version
        FROM ${this.tables.scheduledCommands}
        WHERE id = $1 AND session_id = $2
      `, [input.commandId, input.sessionId]);
      const currentRow = current.rows[0] as Record<string, unknown> | undefined;
      if (currentRow) {
        const currentVersion = integer(currentRow.active_version, "active version");
        if (currentVersion !== input.expectedVersion) {
          throw new ScheduledCommandVersionConflictError(input.commandId, currentVersion);
        }
      }
      throw new Error(`Scheduled command ${input.commandId} could not enqueue a manual run; refresh it or wait for its active occurrence.`);
    }
    return parseRun(row as Record<string, unknown>);
  }

  async listDueCommands(input: {limit?: number} = {}): Promise<readonly ScheduledCommandRecord[]> {
    const result = await this.pool.query(`
      SELECT ${commandSelect("version_row")}
      FROM ${this.tables.scheduledCommands} AS command_row
      INNER JOIN ${this.tables.scheduledCommandVersions} AS version_row
        ON version_row.command_id = command_row.id AND version_row.version = command_row.active_version
      INNER JOIN ${this.sessions.sessions} AS session ON session.id = command_row.session_id
      WHERE version_row.enabled = TRUE
        AND command_row.blocked_at IS NULL
        AND command_row.next_fire_at IS NOT NULL
        AND command_row.next_fire_at <= NOW()
        AND session.archived_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM ${this.tables.scheduledCommandRuns} AS active
          WHERE active.command_id = command_row.id
            AND (active.status IN ('pending', 'claimed', 'running')
              OR (active.notification_kind IS NOT NULL AND active.notified_at IS NULL))
        )
      ORDER BY command_row.next_fire_at ASC, command_row.id ASC
      LIMIT $1
    `, [readLimit(input.limit)]);
    return result.rows.map((row) => parseCommand(row as Record<string, unknown>));
  }

  async materializeScheduledRun(input: {commandId: string; scheduledFor: number; nextFireAt: number}): Promise<ScheduledCommandRunRecord | null> {
    const result = await this.pool.query(`
      WITH eligible AS MATERIALIZED (
        SELECT command_row.id, command_row.session_id, command_row.active_version
        FROM ${this.tables.scheduledCommands} AS command_row
        INNER JOIN ${this.tables.scheduledCommandVersions} AS version_row
          ON version_row.command_id = command_row.id AND version_row.version = command_row.active_version
        INNER JOIN ${this.sessions.sessions} AS session ON session.id = command_row.session_id
        WHERE command_row.id = $1
          AND command_row.next_fire_at = $2
          AND command_row.next_fire_at <= NOW()
          AND command_row.blocked_at IS NULL
          AND version_row.enabled = TRUE
          AND session.archived_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM ${this.tables.scheduledCommandRuns} AS active
            WHERE active.command_id = command_row.id
              AND (active.status IN ('pending', 'claimed', 'running')
                OR (active.notification_kind IS NOT NULL AND active.notified_at IS NULL))
          )
        FOR UPDATE OF command_row SKIP LOCKED
      ), inserted AS (
        INSERT INTO ${this.tables.scheduledCommandRuns} (
          id, command_id, session_id, version, trigger, scheduled_for, status
        )
        SELECT $4, id, session_id, active_version, 'schedule', $2, 'pending'
        FROM eligible
        ON CONFLICT DO NOTHING
        RETURNING *
      ), advanced AS (
        UPDATE ${this.tables.scheduledCommands} AS command_row
        SET next_fire_at = $3, updated_at = NOW()
        FROM inserted
        WHERE command_row.id = inserted.command_id AND command_row.next_fire_at = $2
        RETURNING command_row.id
      )
      SELECT inserted.id AS run_id, inserted.*
      FROM inserted INNER JOIN advanced ON advanced.id = inserted.command_id
    `, [input.commandId, new Date(input.scheduledFor), new Date(input.nextFireAt), randomUUID()]);
    const row = result.rows[0];
    return row ? parseRun(row as Record<string, unknown>) : null;
  }

  async claimRun(input: {claimedBy: string; claimTtlMs: number}): Promise<ClaimedScheduledCommand | null> {
    if (!Number.isFinite(input.claimTtlMs) || input.claimTtlMs <= 0) {
      throw new Error("Scheduled command claim TTL must be positive.");
    }
    const result = await this.pool.query(`
      WITH stale_candidate AS (
        SELECT run.id
        FROM ${this.tables.scheduledCommandRuns} AS run
        INNER JOIN ${this.tables.scheduledCommands} AS command_row ON command_row.id = run.command_id
        WHERE run.status IN ('pending', 'claimed', 'running')
          AND (run.claim_token IS NULL OR run.claim_expires_at IS NULL OR run.claim_expires_at <= NOW())
          AND (
            run.version <> command_row.active_version
            OR EXISTS (
              SELECT 1
              FROM ${this.tables.scheduledCommandVersions} AS newer_version
              WHERE newer_version.command_id = command_row.id
                AND newer_version.version > command_row.active_version
            )
          )
        ORDER BY run.scheduled_for ASC, run.id ASC
        FOR UPDATE OF run SKIP LOCKED
        LIMIT 1
      ), stale_reclaimable AS (
        UPDATE ${this.tables.scheduledCommandRuns} AS run
        SET status = 'cancelled',
            claim_token = NULL,
            claim_expires_at = NULL,
            failure_code = 'superseded_version',
            error = 'Scheduled command occurrence references a superseded definition version.',
            notification_kind = NULL,
            notified_at = NULL,
            finished_at = COALESCE(run.finished_at, NOW())
        FROM stale_candidate
        WHERE run.id = stale_candidate.id
        RETURNING run.id
      ), candidate AS (
        SELECT run.id
        FROM ${this.tables.scheduledCommandRuns} AS run
        INNER JOIN ${this.tables.scheduledCommands} AS command_row ON command_row.id = run.command_id
        INNER JOIN ${this.sessions.sessions} AS session ON session.id = run.session_id
        WHERE session.archived_at IS NULL
          AND (
            (
              run.status IN ('pending', 'claimed', 'running')
              AND run.version = command_row.active_version
              AND NOT EXISTS (
                SELECT 1
                FROM ${this.tables.scheduledCommandVersions} AS newer_version
                WHERE newer_version.command_id = command_row.id
                  AND newer_version.version > command_row.active_version
              )
            )
            OR (run.status IN ('succeeded', 'failed') AND run.notification_kind IS NOT NULL AND run.notified_at IS NULL)
          )
          AND (run.status <> 'pending' OR command_row.blocked_at IS NULL)
          AND (run.claim_token IS NULL OR run.claim_expires_at IS NULL OR run.claim_expires_at <= NOW())
          AND NOT EXISTS (SELECT 1 FROM stale_reclaimable WHERE stale_reclaimable.id = run.id)
        ORDER BY run.scheduled_for ASC, run.id ASC
        FOR UPDATE OF run SKIP LOCKED
        LIMIT 1
      ), claimed AS (
        UPDATE ${this.tables.scheduledCommandRuns} AS run
        SET status = CASE WHEN run.status = 'pending' THEN 'claimed' ELSE run.status END,
            claim_token = $1,
            claimed_at = NOW(),
            claimed_by = $2,
            claim_expires_at = NOW() + ($3 * INTERVAL '1 millisecond')
        FROM candidate
        WHERE run.id = candidate.id
        RETURNING run.*
      )
      SELECT
        claimed.id AS run_id,
        claimed.command_id,
        claimed.session_id,
        claimed.version,
        claimed.trigger,
        claimed.scheduled_for,
        claimed.status,
        claimed.claim_token,
        claimed.claimed_at,
        claimed.claimed_by,
        claimed.claim_expires_at,
        claimed.resolved_environment_id,
        claimed.resolved_cwd,
        claimed.exit_code,
        claimed.timed_out,
        claimed.stdout_preview,
        claimed.stderr_preview,
        claimed.stdout_truncated,
        claimed.stderr_truncated,
        claimed.failure_code,
        claimed.error,
        claimed.notification_kind,
        claimed.notified_at,
        claimed.created_at,
        claimed.started_at,
        claimed.finished_at,
        ${commandSelect("version_row")}
      FROM claimed
      INNER JOIN ${this.tables.scheduledCommands} AS command_row ON command_row.id = claimed.command_id
      INNER JOIN ${this.tables.scheduledCommandVersions} AS version_row
        ON version_row.command_id = claimed.command_id AND version_row.version = claimed.version
    `, [randomUUID(), requireString("claim owner", input.claimedBy), input.claimTtlMs]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    const run = parseRun(row);
    if (!run.claimToken || run.claimedAt === undefined || !run.claimedBy || run.claimExpiresAt === undefined) {
      throw new Error(`Scheduled command run ${run.id} returned an incomplete claim.`);
    }
    return {command: parseCommand(row), run: run as ClaimedScheduledCommandRun};
  }

  async renewRunClaim(input: {runId: string; claimToken: string; claimTtlMs: number}): Promise<ScheduledCommandRunRecord | null> {
    const result = await this.pool.query(`
      UPDATE ${this.tables.scheduledCommandRuns} AS run
      SET claim_expires_at = NOW() + ($3 * INTERVAL '1 millisecond')
      WHERE run.id = $1 AND run.claim_token = $2 AND run.claim_expires_at > NOW()
        AND (run.status IN ('claimed', 'running')
          OR (run.status IN ('succeeded', 'failed') AND run.notification_kind IS NOT NULL AND run.notified_at IS NULL))
        AND EXISTS (
          SELECT 1 FROM ${this.sessions.sessions} AS session
          WHERE session.id = run.session_id AND session.archived_at IS NULL
        )
      RETURNING run.id AS run_id, run.*
    `, [input.runId, input.claimToken, input.claimTtlMs]);
    const row = result.rows[0];
    return row ? parseRun(row as Record<string, unknown>) : null;
  }

  async startRun(input: {runId: string; claimToken: string; environmentId: string; cwd: string}): Promise<ScheduledCommandRunRecord> {
    const result = await this.pool.query(`
      UPDATE ${this.tables.scheduledCommandRuns}
      SET status = 'running',
          resolved_environment_id = $3,
          resolved_cwd = $4,
          started_at = COALESCE(started_at, NOW())
      WHERE id = $1 AND claim_token = $2 AND status IN ('claimed', 'running') AND claim_expires_at > NOW()
      RETURNING id AS run_id, *
    `, [input.runId, input.claimToken, input.environmentId, input.cwd]);
    const row = result.rows[0];
    if (!row) throw rejectedMutation(input.runId, "start");
    return parseRun(row as Record<string, unknown>);
  }

  async settleRun(input: SettleScheduledCommandRunInput): Promise<ScheduledCommandRunRecord> {
    const client = await this.pool.connect();
    let transaction = false;
    try {
      await client.query("BEGIN");
      transaction = true;
      const locked = await client.query(`
        SELECT run.*, command_row.consecutive_failures, command_row.last_notified_failure_code
        FROM ${this.tables.scheduledCommandRuns} AS run
        INNER JOIN ${this.tables.scheduledCommands} AS command_row ON command_row.id = run.command_id
        WHERE run.id = $1 AND run.claim_token = $2 AND run.status IN ('claimed', 'running') AND run.claim_expires_at > NOW()
        FOR UPDATE OF run, command_row
      `, [input.runId, input.claimToken]);
      const lockedRow = locked.rows[0] as Record<string, unknown> | undefined;
      if (!lockedRow) throw rejectedMutation(input.runId, "settle");
      const previousFailures = integer(lockedRow.consecutive_failures, "consecutive failures");
      const previousNotifiedCode = optionalString(lockedRow.last_notified_failure_code);
      const failureCode = input.status === "failed"
        ? requireString("failure code", input.failureCode ?? "command_failed")
        : undefined;
      const notificationKind = input.status === "failed"
        ? (previousNotifiedCode !== failureCode ? "failure" : null)
        : (previousFailures > 0 && previousNotifiedCode ? "recovery" : null);

      if (input.status === "failed") {
        await client.query(`
          UPDATE ${this.tables.scheduledCommands}
          SET consecutive_failures = consecutive_failures + 1,
              last_failure_code = $2,
              last_notified_failure_code = CASE WHEN $3::text IS NULL THEN last_notified_failure_code ELSE $2 END,
              updated_at = NOW()
          WHERE id = $1
        `, [lockedRow.command_id, failureCode, notificationKind]);
      } else {
        await client.query(`
          UPDATE ${this.tables.scheduledCommands}
          SET consecutive_failures = 0,
              last_failure_code = NULL,
              last_notified_failure_code = NULL,
              updated_at = NOW()
          WHERE id = $1
        `, [lockedRow.command_id]);
      }

      const result = input.result;
      const settled = await client.query(`
        UPDATE ${this.tables.scheduledCommandRuns}
        SET status = $3,
            exit_code = $4,
            timed_out = $5,
            stdout_preview = $6,
            stderr_preview = $7,
            stdout_truncated = $8,
            stderr_truncated = $9,
            failure_code = $10,
            error = $11,
            notification_kind = $12,
            finished_at = NOW(),
            claim_token = CASE WHEN $12::text IS NULL THEN NULL ELSE claim_token END,
            claim_expires_at = CASE WHEN $12::text IS NULL THEN NULL ELSE claim_expires_at END
        WHERE id = $1 AND claim_token = $2
        RETURNING id AS run_id, *
      `, [input.runId, input.claimToken, input.status, result?.exitCode ?? null,
        result?.timedOut ?? false, result?.stdout ?? "", result?.stderr ?? "",
        result?.stdoutTruncated ?? false, result?.stderrTruncated ?? false,
        failureCode ?? null, input.status === "failed" ? requireString("error", input.error ?? "Scheduled command failed.") : null,
        notificationKind]);
      const row = settled.rows[0];
      if (!row) throw rejectedMutation(input.runId, "settle");
      await client.query("COMMIT");
      transaction = false;
      return parseRun(row as Record<string, unknown>);
    } catch (error) {
      if (transaction) await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async markIntegrityViolation(input: {runId: string; claimToken: string; reason: string}): Promise<ScheduledCommandRunRecord> {
    const result = await this.pool.query(`
      WITH blocked AS (
        UPDATE ${this.tables.scheduledCommands} AS command_row
        SET blocked_at = COALESCE(blocked_at, NOW()),
            blocked_reason = $3,
            next_fire_at = NULL,
            consecutive_failures = consecutive_failures + 1,
            last_failure_code = 'integrity_violation',
            last_notified_failure_code = 'integrity_violation',
            updated_at = NOW()
        FROM ${this.tables.scheduledCommandRuns} AS run
        WHERE run.id = $1 AND run.claim_token = $2 AND run.command_id = command_row.id
          AND (run.status IN ('claimed', 'running')
            OR (run.status IN ('succeeded', 'failed') AND run.notification_kind IS NOT NULL AND run.notified_at IS NULL))
          AND run.claim_expires_at > NOW()
        RETURNING command_row.id
      )
      UPDATE ${this.tables.scheduledCommandRuns} AS run
      SET status = 'failed', failure_code = 'integrity_violation', error = $3,
          notification_kind = 'failure', finished_at = NOW()
      FROM blocked
      WHERE run.id = $1 AND run.command_id = blocked.id AND run.claim_token = $2
      RETURNING run.id AS run_id, run.*
    `, [input.runId, input.claimToken, requireString("integrity failure", input.reason)]);
    const row = result.rows[0];
    if (!row) throw rejectedMutation(input.runId, "record its integrity violation");
    return parseRun(row as Record<string, unknown>);
  }

  async completeNotification(input: {runId: string; claimToken: string}): Promise<ScheduledCommandRunRecord> {
    const result = await this.pool.query(`
      UPDATE ${this.tables.scheduledCommandRuns}
      SET notified_at = NOW(), claim_token = NULL, claim_expires_at = NULL
      WHERE id = $1 AND claim_token = $2 AND claim_expires_at > NOW()
        AND status IN ('succeeded', 'failed') AND notification_kind IS NOT NULL AND notified_at IS NULL
      RETURNING id AS run_id, *
    `, [input.runId, input.claimToken]);
    const row = result.rows[0];
    if (!row) throw rejectedMutation(input.runId, "complete its notification");
    return parseRun(row as Record<string, unknown>);
  }

  private async readCommand(queryable: Pick<PgClientLike, "query"> | PgPoolLike, commandId: string): Promise<ScheduledCommandRecord> {
    const result = await queryable.query(`
      SELECT ${commandSelect("version_row")}
      FROM ${this.tables.scheduledCommands} AS command_row
      INNER JOIN ${this.tables.scheduledCommandVersions} AS version_row
        ON version_row.command_id = command_row.id AND version_row.version = command_row.active_version
      WHERE command_row.id = $1
    `, [commandId]);
    const row = result.rows[0];
    if (!row) throw missingCommand(commandId);
    return parseCommand(row as Record<string, unknown>);
  }
}
