import type {Pool, PoolClient} from "pg";

import {
    buildThreadRuntimeTableNames,
    CREATE_RUNTIME_SCHEMA_SQL,
    quoteIdentifier,
    toJson,
    toMillis
} from "../threads/runtime/postgres-shared.js";
import {withTransaction} from "../threads/runtime/postgres-db.js";
import {buildAgentTableNames} from "../agents/postgres-shared.js";
import {buildIdentityTableNames} from "../identity/postgres-shared.js";
import {addConstraint, assertIntegrityChecks} from "../../lib/postgres-integrity.js";
import {buildSessionTableNames, type SessionTableNames} from "./postgres-shared.js";
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
import {DEFAULT_SESSION_HEARTBEAT_EVERY_MINUTES} from "./types.js";

interface PgQueryable {
  query: Pool["query"];
}

interface PgPoolLike extends PgQueryable {
  connect(): Promise<PoolClient>;
}

export interface PostgresSessionStoreOptions {
  pool: PgPoolLike;
}

function requireTrimmed(field: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Session ${field} must not be empty.`);
  }

  return trimmed;
}

function normalizeHeartbeatEveryMinutes(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_SESSION_HEARTBEAT_EVERY_MINUTES;
  }

  return Math.floor(parsed);
}

function requireHeartbeatEveryMinutes(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("Session heartbeat interval must be a positive integer.");
  }

  return value;
}

function parseSessionRow(row: Record<string, unknown>): SessionRecord {
  return {
    id: String(row.id),
    agentKey: String(row.agent_key),
    kind: String(row.kind) as SessionRecord["kind"],
    currentThreadId: String(row.current_thread_id),
    createdByIdentityId: row.created_by_identity_id === null ? undefined : String(row.created_by_identity_id),
    metadata: row.metadata === null ? undefined : row.metadata as SessionRecord["metadata"],
    createdAt: toMillis(row.created_at),
    updatedAt: toMillis(row.updated_at),
  };
}

function parseHeartbeatRow(row: Record<string, unknown>): SessionHeartbeatRecord {
  const everyMinutes = normalizeHeartbeatEveryMinutes(row.every_minutes);
  return {
    sessionId: String(row.session_id),
    enabled: Boolean(row.enabled),
    everyMinutes,
    nextFireAt: row.next_fire_at === null ? Date.now() + everyMinutes * 60_000 : toMillis(row.next_fire_at),
    lastFireAt: row.last_fire_at === null ? undefined : toMillis(row.last_fire_at),
    lastSkipReason: row.last_skip_reason === null ? undefined : String(row.last_skip_reason),
    claimedAt: row.claimed_at === null ? undefined : toMillis(row.claimed_at),
    claimedBy: row.claimed_by === null ? undefined : String(row.claimed_by),
    claimExpiresAt: row.claim_expires_at === null ? undefined : toMillis(row.claim_expires_at),
    createdAt: toMillis(row.created_at),
    updatedAt: toMillis(row.updated_at),
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
  private readonly agentTableName: string;
  private readonly identityTableName: string;
  private readonly threadTableName: string;

  constructor(options: PostgresSessionStoreOptions) {
    this.pool = options.pool;
    this.tables = buildSessionTableNames();
    this.agentTableName = buildAgentTableNames().agents;
    this.identityTableName = buildIdentityTableNames().identities;
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
    await this.pool.query(CREATE_RUNTIME_SCHEMA_SQL);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.sessions} (
        id TEXT PRIMARY KEY,
        agent_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        current_thread_id TEXT NOT NULL,
        created_by_identity_id TEXT,
        metadata JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_agent_sessions_main_idx`)}
      ON ${this.tables.sessions} (agent_key)
      WHERE kind = 'main'
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_agent_sessions_agent_idx`)}
      ON ${this.tables.sessions} (agent_key, created_at DESC)
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.sessionHeartbeats} (
        session_id TEXT PRIMARY KEY REFERENCES ${this.tables.sessions}(id) ON DELETE CASCADE,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        every_minutes INTEGER NOT NULL DEFAULT ${DEFAULT_SESSION_HEARTBEAT_EVERY_MINUTES},
        next_fire_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '${DEFAULT_SESSION_HEARTBEAT_EVERY_MINUTES} minutes',
        last_fire_at TIMESTAMPTZ,
        last_skip_reason TEXT,
        claimed_at TIMESTAMPTZ,
        claimed_by TEXT,
        claim_expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_session_heartbeats_due_idx`)}
      ON ${this.tables.sessionHeartbeats} (enabled, next_fire_at, claim_expires_at, session_id)
    `);
    await assertIntegrityChecks(this.pool, "Session schema", [
      {
        label: "agent_sessions.agent_key orphaned from agents.agent_key",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM ${this.tables.sessions} AS session
          LEFT JOIN ${this.agentTableName} AS agent
            ON agent.agent_key = session.agent_key
          WHERE agent.agent_key IS NULL
        `,
      },
      {
        label: "agent_sessions.created_by_identity_id orphaned from identities.id",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM ${this.tables.sessions} AS session
          LEFT JOIN ${this.identityTableName} AS identity
            ON identity.id = session.created_by_identity_id
          WHERE session.created_by_identity_id IS NOT NULL
            AND identity.id IS NULL
        `,
      },
    ]);
    await addConstraint(this.pool, `
      ALTER TABLE ${this.tables.sessions}
      ADD CONSTRAINT ${quoteIdentifier(`${this.tables.prefix}_agent_sessions_agent_fk`)}
      FOREIGN KEY (agent_key)
      REFERENCES ${this.agentTableName}(agent_key)
      ON DELETE CASCADE
    `);
    await addConstraint(this.pool, `
      ALTER TABLE ${this.tables.sessions}
      ADD CONSTRAINT ${quoteIdentifier(`${this.tables.prefix}_agent_sessions_created_by_identity_fk`)}
      FOREIGN KEY (created_by_identity_id)
      REFERENCES ${this.identityTableName}(id)
      ON DELETE SET NULL
    `);
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
      requireTrimmed("id", input.id),
      requireTrimmed("agent key", input.agentKey),
      requireTrimmed("kind", input.kind),
      requireTrimmed("current thread id", input.currentThreadId),
      input.createdByIdentityId?.trim() || null,
      toJson(input.metadata),
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
      [requireTrimmed("id", sessionId)],
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
    `, [requireTrimmed("agent key", agentKey)]);

    const row = result.rows[0];
    return row ? parseSessionRow(row as Record<string, unknown>) : null;
  }

  async listAgentSessions(agentKey: string): Promise<readonly SessionRecord[]> {
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.sessions}
      WHERE agent_key = $1
      ORDER BY CASE WHEN kind = 'main' THEN 0 ELSE 1 END, created_at ASC
    `, [requireTrimmed("agent key", agentKey)]);

    return result.rows.map((row) => parseSessionRow(row as Record<string, unknown>));
  }

  async updateCurrentThreadRecord(
    input: UpdateSessionCurrentThreadInput,
    queryable: PgQueryable = this.pool,
  ): Promise<SessionRecord> {
    const sessionId = requireTrimmed("id", input.sessionId);
    const currentThreadId = requireTrimmed("current thread id", input.currentThreadId);
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
    `, [requireTrimmed("id", sessionId)]);
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
      requireTrimmed("id", input.sessionId),
      requireTrimmed("claim owner", input.claimedBy),
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
      requireTrimmed("id", input.sessionId),
      requireTrimmed("claim owner", input.claimedBy),
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
      requireTrimmed("id", input.sessionId),
      enabled,
      everyMinutes,
      new Date(nextFireAt),
    ]);
    return parseHeartbeatRow(result.rows[0] as Record<string, unknown>);
  }
}
