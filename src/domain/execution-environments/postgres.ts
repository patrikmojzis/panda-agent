import {optionalTimestampMillis, requireTimestampMillis, toJson} from "../../lib/postgres-values.js";
import {requireBoolean} from "../../lib/booleans.js";
import {readOptionalJsonValue} from "../../lib/json.js";
import type {PgPoolLike} from "../../lib/postgres-query.js";
import {isRecord} from "../../lib/records.js";
import {optionalTrimmedString, requireNonEmptyString, uniqueTrimmedStrings} from "../../lib/strings.js";
import {ensurePostgresExecutionEnvironmentSchema} from "./postgres-schema.js";
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
  ListDisposableEnvironmentsByOwnerInput,
  SessionEnvironmentBindingRecord,
} from "./types.js";

export interface PostgresExecutionEnvironmentStoreOptions {
  pool: PgPoolLike;
}

function requireTrimmed(field: string, value: unknown): string {
  return requireNonEmptyString(value, `${field} must not be empty.`);
}

function optionalTrimmed(field: string, value: unknown): string | undefined {
  return optionalTrimmedString(value, `${field} must be a string.`);
}

function readTrimmedList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return uniqueTrimmedStrings(value.filter((entry): entry is string => typeof entry === "string"));
}

function parseCredentialPolicy(value: unknown): ExecutionCredentialPolicy {
  if (!isRecord(value)) {
    return {mode: "none"};
  }
  if (value.mode === "all_agent") {
    return {mode: "all_agent"};
  }
  if (value.mode === "allowlist") {
    return {mode: "allowlist", envKeys: readTrimmedList(value.envKeys)};
  }
  return {mode: "none"};
}

function parseSkillPolicy(value: unknown): ExecutionSkillPolicy {
  if (!isRecord(value)) {
    return {mode: "none"};
  }
  if (value.mode === "all_agent") {
    return {mode: "all_agent"};
  }
  if (value.mode === "allowlist") {
    return {mode: "allowlist", skillKeys: readTrimmedList(value.skillKeys)};
  }
  return {mode: "none"};
}

function parseToolPolicy(value: unknown): ExecutionToolPolicy {
  if (!isRecord(value)) {
    return {};
  }
  const policy: ExecutionToolPolicy = {};
  if (Array.isArray(value.allowedTools)) {
    const allowedTools = readTrimmedList(value.allowedTools);
    if (allowedTools.length > 0) {
      policy.allowedTools = allowedTools;
    }
  }
  if (isRecord(value.bash)) {
    if (typeof value.bash.allowed === "boolean") {
      policy.bash = {allowed: value.bash.allowed};
    }
  }
  if (isRecord(value.postgresReadonly)) {
    if (typeof value.postgresReadonly.allowed === "boolean") {
      policy.postgresReadonly = {allowed: value.postgresReadonly.allowed};
    }
  }
  return policy;
}

function parseEnvironmentKind(value: unknown): ExecutionEnvironmentKind {
  if (value === "persistent_agent_runner" || value === "disposable_container" || value === "local") {
    return value;
  }

  throw new Error(`Unsupported execution environment kind ${String(value)}.`);
}

function parseEnvironmentState(value: unknown): ExecutionEnvironmentState {
  if (
    value === "provisioning"
    || value === "ready"
    || value === "failed"
    || value === "stopping"
    || value === "stopped"
  ) {
    return value;
  }

  throw new Error(`Unsupported execution environment state ${String(value)}.`);
}

function parseEnvironmentRow(row: Record<string, unknown>): ExecutionEnvironmentRecord {
  return {
    id: requireTrimmed("environment id", row.id),
    agentKey: requireTrimmed("agent key", row.agent_key),
    kind: parseEnvironmentKind(row.kind),
    state: parseEnvironmentState(row.state),
    runnerUrl: optionalTrimmed("environment runner url", row.runner_url),
    runnerCwd: optionalTrimmed("environment runner cwd", row.runner_cwd),
    rootPath: optionalTrimmed("environment root path", row.root_path),
    createdBySessionId: optionalTrimmed("environment created_by_session_id", row.created_by_session_id),
    createdForSessionId: optionalTrimmed("environment created_for_session_id", row.created_for_session_id),
    expiresAt: optionalTimestampMillis(row.expires_at, "environment expires_at must be a valid timestamp."),
    metadata: readOptionalJsonValue(row.metadata, "Execution environment metadata"),
    createdAt: requireTimestampMillis(row.created_at, "environment created_at must be a valid timestamp."),
    updatedAt: requireTimestampMillis(row.updated_at, "environment updated_at must be a valid timestamp."),
  };
}

function parseBindingRow(row: Record<string, unknown>): SessionEnvironmentBindingRecord {
  return {
    sessionId: requireTrimmed("session id", row.session_id),
    environmentId: requireTrimmed("environment id", row.environment_id),
    alias: requireTrimmed("environment alias", row.alias),
    isDefault: requireBoolean(row.is_default, "environment binding is_default must be a boolean."),
    credentialPolicy: parseCredentialPolicy(row.credential_policy),
    skillPolicy: parseSkillPolicy(row.skill_policy),
    toolPolicy: parseToolPolicy(row.tool_policy),
    createdAt: requireTimestampMillis(row.created_at, "environment binding created_at must be a valid timestamp."),
    updatedAt: requireTimestampMillis(row.updated_at, "environment binding updated_at must be a valid timestamp."),
  };
}

export class PostgresExecutionEnvironmentStore implements ExecutionEnvironmentStore {
  private readonly pool: PgPoolLike;
  private readonly tables: ExecutionEnvironmentTableNames;

  constructor(options: PostgresExecutionEnvironmentStoreOptions) {
    this.pool = options.pool;
    this.tables = buildExecutionEnvironmentTableNames();
  }

  async ensureSchema(): Promise<void> {
    await ensurePostgresExecutionEnvironmentSchema(this.pool);
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
      parseEnvironmentKind(input.kind),
      parseEnvironmentState(input.state ?? "ready"),
      optionalTrimmed("environment runner url", input.runnerUrl) ?? null,
      optionalTrimmed("environment runner cwd", input.runnerCwd) ?? null,
      optionalTrimmed("environment root path", input.rootPath) ?? null,
      optionalTrimmed("environment created_by_session_id", input.createdBySessionId) ?? null,
      optionalTrimmed("environment created_for_session_id", input.createdForSessionId) ?? null,
      input.expiresAt === undefined ? null : new Date(input.expiresAt),
      toJson(readOptionalJsonValue(input.metadata, "Execution environment metadata")),
    ]);

    return parseEnvironmentRow(result.rows[0] as Record<string, unknown>);
  }

  async bindSession(input: BindSessionEnvironmentInput): Promise<SessionEnvironmentBindingRecord> {
    const credentialPolicy = parseCredentialPolicy(input.credentialPolicy);
    const skillPolicy = parseSkillPolicy(input.skillPolicy);
    const toolPolicy = parseToolPolicy(input.toolPolicy);
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

  async listDisposableEnvironmentsByOwner(
    input: ListDisposableEnvironmentsByOwnerInput,
  ): Promise<readonly ExecutionEnvironmentRecord[]> {
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.executionEnvironments}
      WHERE agent_key = $1
        AND kind = 'disposable_container'
        AND created_by_session_id = $2
      ORDER BY created_at ASC, id ASC
    `, [
      requireTrimmed("agent key", input.agentKey),
      requireTrimmed("owner session id", input.createdBySessionId),
    ]);
    return result.rows.map((row) => parseEnvironmentRow(row as Record<string, unknown>));
  }

  async listBindingsForEnvironments(
    environmentIds: readonly string[],
  ): Promise<readonly SessionEnvironmentBindingRecord[]> {
    const ids = uniqueTrimmedStrings(environmentIds);
    if (ids.length === 0) {
      return [];
    }
    const placeholders = ids.map((_, index) => `$${index + 1}`).join(", ");
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.sessionEnvironmentBindings}
      WHERE environment_id IN (${placeholders})
      ORDER BY created_at ASC, session_id ASC
    `, ids);
    return result.rows.map((row) => parseBindingRow(row as Record<string, unknown>));
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
