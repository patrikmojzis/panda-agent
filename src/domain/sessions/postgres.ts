import {optionalTimestampMillis, requireTimestampMillis} from "../../lib/postgres-values.js";
import {buildThreadRuntimeTableNames} from "../threads/runtime/postgres-shared.js";
import {requireBoolean} from "../../lib/booleans.js";
import {readOptionalJsonValue, stringifyOptionalJsonValue} from "../../lib/json.js";
import type {PgPoolLike, PgQueryable} from "../../lib/postgres-query.js";
import {withTransaction} from "../../lib/postgres-transaction.js";
import {optionalNonEmptyString, requireNonEmptyString} from "../../lib/strings.js";
import {buildSessionTableNames, type SessionTableNames} from "./postgres-shared.js";
import {ensurePostgresSessionSchema} from "./postgres-schema.js";
import type {SessionStore} from "./store.js";
import type {
    ClaimSessionHeartbeatInput,
    CreateSessionInput,
    ListDueSessionHeartbeatsInput,
    RecordSessionHeartbeatResultInput,
    SessionHeartbeatRecord,
    SessionRecord,
    UpdateSessionCurrentThreadInput,
    UpdateSessionHeartbeatConfigInput,
} from "./types.js";

export interface PostgresSessionStoreOptions {
  pool: PgPoolLike;
}

function requireSessionString(field: string, value: unknown): string {
  return requireNonEmptyString(value, `Session ${field} must not be empty.`);
}

function optionalSessionString(field: string, value: unknown): string | undefined {
  return optionalNonEmptyString(value, `Session ${field} must not be empty.`);
}

function parseSessionKind(value: unknown): SessionRecord["kind"] {
  if (value === "main" || value === "branch" || value === "worker") {
    return value;
  }

  throw new Error(`Unsupported session kind ${String(value)}.`);
}

function parseHeartbeatEveryMinutes(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error("Session heartbeat interval must be a positive integer.");
  }

  return value;
}

function requireHeartbeatEveryMinutes(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("Session heartbeat interval must be a positive integer.");
  }

  return value;
}

function parseSessionRow(row: Record<string, unknown>): SessionRecord {
  return {
    id: requireSessionString("id", row.id),
    agentKey: requireSessionString("agent key", row.agent_key),
    kind: parseSessionKind(row.kind),
    currentThreadId: requireSessionString("current thread id", row.current_thread_id),
    createdByIdentityId: optionalSessionString("created identity id", row.created_by_identity_id),
    metadata: readOptionalJsonValue(row.metadata, "Session metadata"),
    createdAt: requireTimestampMillis(row.created_at, "Session created_at must be a valid timestamp."),
    updatedAt: requireTimestampMillis(row.updated_at, "Session updated_at must be a valid timestamp."),
  };
}

function parseHeartbeatRow(row: Record<string, unknown>): SessionHeartbeatRecord {
  const everyMinutes = parseHeartbeatEveryMinutes(row.every_minutes);
  return {
    sessionId: requireSessionString("id", row.session_id),
    enabled: requireBoolean(row.enabled, "Session heartbeat enabled flag must be a boolean."),
    everyMinutes,
    nextFireAt: requireTimestampMillis(row.next_fire_at, "Session next_fire_at must be a valid timestamp."),
    lastFireAt: optionalTimestampMillis(row.last_fire_at, "Session last_fire_at must be a valid timestamp."),
    lastSkipReason: optionalSessionString("last skip reason", row.last_skip_reason),
    claimedAt: optionalTimestampMillis(row.claimed_at, "Session claimed_at must be a valid timestamp."),
    claimedBy: optionalSessionString("claim owner", row.claimed_by),
    claimExpiresAt: optionalTimestampMillis(row.claim_expires_at, "Session claim_expires_at must be a valid timestamp."),
    createdAt: requireTimestampMillis(row.created_at, "Session created_at must be a valid timestamp."),
    updatedAt: requireTimestampMillis(row.updated_at, "Session updated_at must be a valid timestamp."),
  };
}

function missingSessionError(sessionId: string): Error {
  return new Error(`Unknown session ${sessionId}`);
}

function missingHeartbeatError(sessionId: string): Error {
  return new Error(`Unknown heartbeat for session ${sessionId}`);
}

export class PostgresSessionStore implements SessionStore {
  private readonly pool: PgPoolLike;
  private readonly tables: SessionTableNames;
  private readonly threadTableName: string;

  constructor(options: PostgresSessionStoreOptions) {
    this.pool = options.pool;
    this.tables = buildSessionTableNames();
    this.threadTableName = buildThreadRuntimeTableNames().threads;
  }

  private async hasThreadTable(queryable: PgQueryable = this.pool): Promise<boolean> {
    const result = await queryable.query(`
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'runtime'
        AND table_name = 'threads'
      LIMIT 1
    `);
    return result.rows.length > 0;
  }

  async ensureSchema(): Promise<void> {
    await ensurePostgresSessionSchema(this.pool);
  }

  async createSessionRecord(input: CreateSessionInput, queryable: PgQueryable = this.pool): Promise<SessionRecord> {
    const result = await queryable.query(`
      INSERT INTO ${this.tables.sessions} (
        id,
        agent_key,
        kind,
        current_thread_id,
        created_by_identity_id,
        metadata
      ) VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6::jsonb
      )
      RETURNING *
    `, [
      requireSessionString("id", input.id),
      requireSessionString("agent key", input.agentKey),
      parseSessionKind(input.kind),
      requireSessionString("current thread id", input.currentThreadId),
      input.createdByIdentityId?.trim() || null,
      stringifyOptionalJsonValue(input.metadata, "Session metadata"),
    ]);

    const session = parseSessionRow(result.rows[0] as Record<string, unknown>);
    await queryable.query(`
      INSERT INTO ${this.tables.sessionHeartbeats} (
        session_id,
        enabled
      ) VALUES (
        $1,
        $2
      )
      ON CONFLICT (session_id) DO NOTHING
    `, [
      session.id,
      session.kind === "main",
    ]);

    return session;
  }

  async createSession(input: CreateSessionInput): Promise<SessionRecord> {
    return withTransaction(this.pool, async (client) => {
      const session = await this.createSessionRecord(input, client);
      if (await this.hasThreadTable(client)) {
        await client.query(`
          INSERT INTO ${this.threadTableName} (
            id,
            session_id
          ) VALUES (
            $1,
            $2
          )
        `, [
          session.currentThreadId,
          session.id,
        ]);
      }
      return session;
    });
  }

  async getSession(sessionId: string): Promise<SessionRecord> {
    const result = await this.pool.query(
      `SELECT * FROM ${this.tables.sessions} WHERE id = $1`,
      [requireSessionString("id", sessionId)],
    );
    const row = result.rows[0];
    if (!row) {
      throw missingSessionError(sessionId);
    }

    return parseSessionRow(row as Record<string, unknown>);
  }

  async getMainSession(agentKey: string): Promise<SessionRecord | null> {
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.sessions}
      WHERE agent_key = $1
        AND kind = 'main'
      LIMIT 1
    `, [requireSessionString("agent key", agentKey)]);

    const row = result.rows[0];
    return row ? parseSessionRow(row as Record<string, unknown>) : null;
  }

  async listAgentSessions(agentKey: string): Promise<readonly SessionRecord[]> {
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.sessions}
      WHERE agent_key = $1
      ORDER BY CASE WHEN kind = 'main' THEN 0 ELSE 1 END, created_at ASC
    `, [requireSessionString("agent key", agentKey)]);

    return result.rows.map((row) => parseSessionRow(row as Record<string, unknown>));
  }

  async updateCurrentThreadRecord(
    input: UpdateSessionCurrentThreadInput,
    queryable: PgQueryable = this.pool,
  ): Promise<SessionRecord> {
    const sessionId = requireSessionString("id", input.sessionId);
    const currentThreadId = requireSessionString("current thread id", input.currentThreadId);
    const threadResult = await queryable.query(`
      SELECT 1
      FROM ${this.threadTableName}
      WHERE session_id = $1
        AND id = $2
      LIMIT 1
    `, [
      sessionId,
      currentThreadId,
    ]);
    if (threadResult.rows.length === 0) {
      throw new Error(`Thread ${currentThreadId} does not belong to session ${sessionId}.`);
    }

    const result = await queryable.query(`
      UPDATE ${this.tables.sessions}
      SET current_thread_id = $2,
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [
      sessionId,
      currentThreadId,
    ]);
    const row = result.rows[0];
    if (!row) {
      throw missingSessionError(input.sessionId);
    }

    return parseSessionRow(row as Record<string, unknown>);
  }

  async updateCurrentThread(input: UpdateSessionCurrentThreadInput): Promise<SessionRecord> {
    return this.updateCurrentThreadRecord(input);
  }

  async getHeartbeat(sessionId: string): Promise<SessionHeartbeatRecord | null> {
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.sessionHeartbeats}
      WHERE session_id = $1
    `, [requireSessionString("id", sessionId)]);
    const row = result.rows[0];
    return row ? parseHeartbeatRow(row as Record<string, unknown>) : null;
  }

  async listDueHeartbeats(input: ListDueSessionHeartbeatsInput = {}): Promise<readonly SessionHeartbeatRecord[]> {
    const asOf = new Date(input.asOf ?? Date.now());
    const limit = input.limit ?? 100;
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.sessionHeartbeats}
      WHERE enabled = TRUE
        AND next_fire_at IS NOT NULL
        AND next_fire_at <= $1
        AND (claim_expires_at IS NULL OR claim_expires_at <= $1)
      ORDER BY next_fire_at ASC, session_id ASC
      LIMIT $2
    `, [asOf, limit]);

    return result.rows.map((row) => parseHeartbeatRow(row as Record<string, unknown>));
  }

  async claimHeartbeat(input: ClaimSessionHeartbeatInput): Promise<SessionHeartbeatRecord | null> {
    const asOf = new Date(input.asOf ?? Date.now());
    const result = await this.pool.query(`
      UPDATE ${this.tables.sessionHeartbeats}
      SET claimed_at = NOW(),
          claimed_by = $2,
          claim_expires_at = $3,
          updated_at = NOW()
      WHERE session_id = $1
        AND enabled = TRUE
        AND next_fire_at IS NOT NULL
        AND next_fire_at <= $4
        AND (claim_expires_at IS NULL OR claim_expires_at <= $4)
      RETURNING *
    `, [
      requireSessionString("id", input.sessionId),
      requireSessionString("claim owner", input.claimedBy),
      new Date(input.claimExpiresAt),
      asOf,
    ]);

    const row = result.rows[0];
    return row ? parseHeartbeatRow(row as Record<string, unknown>) : null;
  }

  async recordHeartbeatResult(input: RecordSessionHeartbeatResultInput): Promise<SessionHeartbeatRecord> {
    const result = await this.pool.query(`
      UPDATE ${this.tables.sessionHeartbeats}
      SET next_fire_at = $3,
          last_fire_at = COALESCE($4, last_fire_at),
          last_skip_reason = $5,
          claimed_at = NULL,
          claimed_by = NULL,
          claim_expires_at = NULL,
          updated_at = NOW()
      WHERE session_id = $1
        AND claimed_by = $2
      RETURNING *
    `, [
      requireSessionString("id", input.sessionId),
      requireSessionString("claim owner", input.claimedBy),
      new Date(input.nextFireAt),
      input.lastFireAt === undefined ? null : new Date(input.lastFireAt),
      input.lastSkipReason ?? null,
    ]);
    const row = result.rows[0];
    if (!row) {
      throw missingHeartbeatError(input.sessionId);
    }

    return parseHeartbeatRow(row as Record<string, unknown>);
  }

  async updateHeartbeatConfig(input: UpdateSessionHeartbeatConfigInput): Promise<SessionHeartbeatRecord> {
    const existing = await this.getHeartbeat(input.sessionId);
    if (!existing) {
      throw missingHeartbeatError(input.sessionId);
    }

    const enabled = input.enabled ?? existing.enabled;
    const everyMinutes = input.everyMinutes === undefined
      ? existing.everyMinutes
      : requireHeartbeatEveryMinutes(input.everyMinutes);
    const asOf = input.asOf ?? Date.now();
    const nextFireAt = enabled
      ? asOf + everyMinutes * 60_000
      : existing.nextFireAt;

    const result = await this.pool.query(`
      UPDATE ${this.tables.sessionHeartbeats}
      SET enabled = $2,
          every_minutes = $3,
          next_fire_at = $4,
          claimed_at = NULL,
          claimed_by = NULL,
          claim_expires_at = NULL,
          updated_at = NOW()
      WHERE session_id = $1
      RETURNING *
    `, [
      requireSessionString("id", input.sessionId),
      enabled,
      everyMinutes,
      new Date(nextFireAt),
    ]);
    return parseHeartbeatRow(result.rows[0] as Record<string, unknown>);
  }
}
