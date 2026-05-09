import type {Pool} from "pg";

import {buildAgentTableNames} from "../agents/postgres-shared.js";
import {buildSessionTableNames} from "../sessions/postgres-shared.js";
import {CREATE_RUNTIME_SCHEMA_SQL, quoteIdentifier, toJson, toMillis,} from "../threads/runtime/postgres-shared.js";
import {buildExecutionEnvironmentTableNames, type ExecutionEnvironmentTableNames} from "./postgres-shared.js";
import type {ExecutionEnvironmentStore} from "./store.js";
import type {
    BindSessionEnvironmentInput,
    CreateExecutionEnvironmentInput,
    ExecutionCredentialPolicy,
    ExecutionEnvironmentKind,
    ExecutionEnvironmentRecord,
    ExecutionEnvironmentState,
    ExecutionSkillPolicy,
    ExecutionToolPolicy,
    SessionEnvironmentBindingRecord,
} from "./types.js";

interface PgQueryable {
  query: Pool["query"];
}

interface PgPoolLike extends PgQueryable {}

export interface PostgresExecutionEnvironmentStoreOptions {
  pool: PgPoolLike;
}

function requireTrimmed(field: string, value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${field} must not be empty.`);
  }
  return trimmed;
}

function optionalTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function parseCredentialPolicy(value: unknown): ExecutionCredentialPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {mode: "none"};
  }
  const record = value as Record<string, unknown>;
  if (record.mode === "all_agent") {
    return {mode: "all_agent"};
  }
  if (record.mode === "allowlist") {
    const envKeys = Array.isArray(record.envKeys)
      ? record.envKeys.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      : [];
    return {mode: "allowlist", envKeys};
  }
  return {mode: "none"};
}

function parseSkillPolicy(value: unknown): ExecutionSkillPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {mode: "none"};
  }
  const record = value as Record<string, unknown>;
  if (record.mode === "all_agent") {
    return {mode: "all_agent"};
  }
  if (record.mode === "allowlist") {
    const skillKeys = Array.isArray(record.skillKeys)
      ? record.skillKeys.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      : [];
    return {mode: "allowlist", skillKeys};
  }
  return {mode: "none"};
}

function parseToolPolicy(value: unknown): ExecutionToolPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const record = value as Record<string, unknown>;
  const policy: ExecutionToolPolicy = {};
  if (Array.isArray(record.allowedTools)) {
    const allowedTools = record.allowedTools
      .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
    if (allowedTools.length > 0) {
      policy.allowedTools = allowedTools;
    }
  }
  if (record.bash && typeof record.bash === "object" && !Array.isArray(record.bash)) {
    const bash = record.bash as Record<string, unknown>;
    if (typeof bash.allowed === "boolean") {
      policy.bash = {allowed: bash.allowed};
    }
  }
  if (
    record.postgresReadonly
    && typeof record.postgresReadonly === "object"
    && !Array.isArray(record.postgresReadonly)
  ) {
    const postgresReadonly = record.postgresReadonly as Record<string, unknown>;
    if (typeof postgresReadonly.allowed === "boolean") {
      policy.postgresReadonly = {allowed: postgresReadonly.allowed};
    }
  }
  return policy;
}

function parseEnvironmentRow(row: Record<string, unknown>): ExecutionEnvironmentRecord {
  return {
    id: String(row.id),
    agentKey: String(row.agent_key),
    kind: String(row.kind) as ExecutionEnvironmentKind,
    state: String(row.state) as ExecutionEnvironmentState,
    runnerUrl: row.runner_url === null ? undefined : String(row.runner_url),
    runnerCwd: row.runner_cwd === null ? undefined : String(row.runner_cwd),
    rootPath: row.root_path === null ? undefined : String(row.root_path),
    createdBySessionId: row.created_by_session_id === null ? undefined : String(row.created_by_session_id),
    createdForSessionId: row.created_for_session_id === null ? undefined : String(row.created_for_session_id),
    expiresAt: row.expires_at === null || row.expires_at === undefined ? undefined : toMillis(row.expires_at),
    metadata: row.metadata === null ? undefined : row.metadata as ExecutionEnvironmentRecord["metadata"],
    createdAt: toMillis(row.created_at),
    updatedAt: toMillis(row.updated_at),
  };
}

function parseBindingRow(row: Record<string, unknown>): SessionEnvironmentBindingRecord {
  return {
    sessionId: String(row.session_id),
    environmentId: String(row.environment_id),
    alias: String(row.alias),
    isDefault: Boolean(row.is_default),
    credentialPolicy: parseCredentialPolicy(row.credential_policy),
    skillPolicy: parseSkillPolicy(row.skill_policy),
    toolPolicy: parseToolPolicy(row.tool_policy),
    createdAt: toMillis(row.created_at),
    updatedAt: toMillis(row.updated_at),
  };
}

export class PostgresExecutionEnvironmentStore implements ExecutionEnvironmentStore {
  private readonly pool: PgPoolLike;
  private readonly tables: ExecutionEnvironmentTableNames;
  private readonly agentTables: ReturnType<typeof buildAgentTableNames>;
  private readonly sessionTables: ReturnType<typeof buildSessionTableNames>;

  constructor(options: PostgresExecutionEnvironmentStoreOptions) {
    this.pool = options.pool;
    this.tables = buildExecutionEnvironmentTableNames();
    this.agentTables = buildAgentTableNames();
    this.sessionTables = buildSessionTableNames();
  }

  async ensureSchema(): Promise<void> {
    await this.pool.query(CREATE_RUNTIME_SCHEMA_SQL);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.executionEnvironments} (
        id TEXT PRIMARY KEY,
        agent_key TEXT NOT NULL REFERENCES ${this.agentTables.agents}(agent_key) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'ready',
        runner_url TEXT,
        runner_cwd TEXT,
        root_path TEXT,
        created_by_session_id TEXT REFERENCES ${this.sessionTables.sessions}(id) ON DELETE SET NULL,
        created_for_session_id TEXT REFERENCES ${this.sessionTables.sessions}(id) ON DELETE SET NULL,
        expires_at TIMESTAMPTZ,
        metadata JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.sessionEnvironmentBindings} (
        session_id TEXT NOT NULL REFERENCES ${this.sessionTables.sessions}(id) ON DELETE CASCADE,
        environment_id TEXT NOT NULL REFERENCES ${this.tables.executionEnvironments}(id) ON DELETE CASCADE,
        alias TEXT NOT NULL,
        is_default BOOLEAN NOT NULL DEFAULT FALSE,
        allow_override BOOLEAN NOT NULL DEFAULT FALSE,
        credential_policy JSONB NOT NULL DEFAULT '{"mode":"none"}'::jsonb,
        skill_policy JSONB NOT NULL DEFAULT '{"mode":"none"}'::jsonb,
        tool_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (session_id, environment_id)
      )
    `);
    await this.pool.query(`
      ALTER TABLE ${this.tables.sessionEnvironmentBindings}
      ADD COLUMN IF NOT EXISTS skill_policy JSONB NOT NULL DEFAULT '{"mode":"none"}'::jsonb
    `);
    await this.pool.query(`
      ALTER TABLE ${this.tables.sessionEnvironmentBindings}
      ALTER COLUMN skill_policy SET DEFAULT '{"mode":"none"}'::jsonb
    `);
    await this.pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_session_environment_default_idx`)}
      ON ${this.tables.sessionEnvironmentBindings} (session_id)
      WHERE is_default
    `);
  }

  async createEnvironment(input: CreateExecutionEnvironmentInput): Promise<ExecutionEnvironmentRecord> {
    const result = await this.pool.query(`
      INSERT INTO ${this.tables.executionEnvironments} (
        id,
        agent_key,
        kind,
        state,
        runner_url,
        runner_cwd,
        root_path,
        created_by_session_id,
        created_for_session_id,
        expires_at,
        metadata
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb
      )
      ON CONFLICT (id) DO UPDATE SET
        agent_key = EXCLUDED.agent_key,
        kind = EXCLUDED.kind,
        state = EXCLUDED.state,
        runner_url = EXCLUDED.runner_url,
        runner_cwd = EXCLUDED.runner_cwd,
        root_path = EXCLUDED.root_path,
        created_by_session_id = EXCLUDED.created_by_session_id,
        created_for_session_id = EXCLUDED.created_for_session_id,
        expires_at = EXCLUDED.expires_at,
        metadata = EXCLUDED.metadata,
        updated_at = NOW()
      RETURNING *
    `, [
      requireTrimmed("environment id", input.id),
      requireTrimmed("agent key", input.agentKey),
      requireTrimmed("environment kind", input.kind),
      input.state ?? "ready",
      optionalTrimmed(input.runnerUrl) ?? null,
      optionalTrimmed(input.runnerCwd) ?? null,
      optionalTrimmed(input.rootPath) ?? null,
      optionalTrimmed(input.createdBySessionId) ?? null,
      optionalTrimmed(input.createdForSessionId) ?? null,
      input.expiresAt === undefined ? null : new Date(input.expiresAt),
      toJson(input.metadata),
    ]);

    return parseEnvironmentRow(result.rows[0] as Record<string, unknown>);
  }

  async bindSession(input: BindSessionEnvironmentInput): Promise<SessionEnvironmentBindingRecord> {
    const credentialPolicy = input.credentialPolicy ?? {mode: "none"};
    const skillPolicy = input.skillPolicy ?? {mode: "none"};
    const toolPolicy = input.toolPolicy ?? {};
    const result = await this.pool.query(`
      INSERT INTO ${this.tables.sessionEnvironmentBindings} (
        session_id,
        environment_id,
        alias,
        is_default,
        allow_override,
        credential_policy,
        skill_policy,
        tool_policy
      ) VALUES (
        $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb
      )
      ON CONFLICT (session_id, environment_id) DO UPDATE SET
        alias = EXCLUDED.alias,
        is_default = EXCLUDED.is_default,
        allow_override = EXCLUDED.allow_override,
        credential_policy = EXCLUDED.credential_policy,
        skill_policy = EXCLUDED.skill_policy,
        tool_policy = EXCLUDED.tool_policy,
        updated_at = NOW()
      RETURNING *
    `, [
      requireTrimmed("session id", input.sessionId),
      requireTrimmed("environment id", input.environmentId),
      requireTrimmed("environment alias", input.alias),
      input.isDefault ?? false,
      false,
      toJson(credentialPolicy),
      toJson(skillPolicy),
      toJson(toolPolicy),
    ]);

    return parseBindingRow(result.rows[0] as Record<string, unknown>);
  }

  async getEnvironment(environmentId: string): Promise<ExecutionEnvironmentRecord> {
    const result = await this.pool.query(
      `SELECT * FROM ${this.tables.executionEnvironments} WHERE id = $1`,
      [requireTrimmed("environment id", environmentId)],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error(`Unknown execution environment ${environmentId}.`);
    }
    return parseEnvironmentRow(row as Record<string, unknown>);
  }

  async getDefaultBinding(sessionId: string): Promise<SessionEnvironmentBindingRecord | null> {
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.sessionEnvironmentBindings}
      WHERE session_id = $1
        AND is_default
      LIMIT 1
    `, [requireTrimmed("session id", sessionId)]);
    const row = result.rows[0];
    return row ? parseBindingRow(row as Record<string, unknown>) : null;
  }

  async listExpiredDisposableEnvironments(now: number, limit: number): Promise<readonly ExecutionEnvironmentRecord[]> {
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.executionEnvironments}
      WHERE kind = 'disposable_container'
        AND state = 'ready'
        AND expires_at IS NOT NULL
        AND expires_at <= $1
      ORDER BY expires_at ASC, created_at ASC
      LIMIT $2
    `, [
      new Date(now),
      Math.max(1, limit),
    ]);

    return result.rows.map((row) => parseEnvironmentRow(row as Record<string, unknown>));
  }
}
