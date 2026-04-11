import {randomUUID} from "node:crypto";

import type {Pool, PoolClient} from "pg";

import {buildAgentTableNames} from "../agents/postgres-shared.js";
import {buildIdentityTableNames} from "../identity/postgres-shared.js";
import {quoteIdentifier, toMillis} from "../threads/runtime/postgres-shared.js";
import {buildCredentialTableNames, type CredentialTableNames} from "./postgres-shared.js";
import {
    type CredentialListFilter,
    type CredentialRecord,
    type CredentialResolutionContext,
    normalizeCredentialEnvKey,
    normalizeCredentialScopeInput,
    type SetCredentialInput,
} from "./types.js";

interface PgQueryable {
  query: Pool["query"];
}

interface PgPoolLike extends PgQueryable {
  connect(): Promise<PoolClient>;
}

export interface PostgresCredentialStoreOptions {
  pool: PgPoolLike;
  tablePrefix?: string;
}

function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) {
    return value;
  }

  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }

  if (typeof value === "string") {
    if (value.startsWith("\\x")) {
      return Buffer.from(value.slice(2), "hex");
    }

    return Buffer.from(value, "utf8");
  }

  throw new Error("Credential row is missing a binary field.");
}

function parseCredentialRow(row: Record<string, unknown>): CredentialRecord {
  return {
    id: String(row.id),
    envKey: String(row.env_key),
    scope: String(row.scope) as CredentialRecord["scope"],
    agentKey: typeof row.agent_key === "string" ? row.agent_key : undefined,
    identityId: typeof row.identity_id === "string" ? row.identity_id : undefined,
    valueCiphertext: toBuffer(row.value_ciphertext),
    valueIv: toBuffer(row.value_iv),
    valueTag: toBuffer(row.value_tag),
    keyVersion: Number(row.key_version),
    createdAt: toMillis(row.created_at),
    updatedAt: toMillis(row.updated_at),
  };
}

function buildExactScopeWhere(
  envKey: string,
  scopeInput: CredentialRecord | SetCredentialInput | CredentialListFilter,
  startIndex = 1,
): {
  sql: string;
  values: unknown[];
} {
  const normalizedEnvKey = normalizeCredentialEnvKey(envKey);
  const normalizedScope = normalizeCredentialScopeInput({
    scope: scopeInput.scope!,
    agentKey: scopeInput.agentKey,
    identityId: scopeInput.identityId,
  });

  const values: unknown[] = [normalizedEnvKey, normalizedScope.scope];
  const parts = [`env_key = $${startIndex}`, `scope = $${startIndex + 1}`];

  if (normalizedScope.scope === "relationship") {
    values.push(normalizedScope.agentKey, normalizedScope.identityId);
    parts.push(
      `agent_key = $${startIndex + 2}`,
      `identity_id = $${startIndex + 3}`,
    );
  } else if (normalizedScope.scope === "agent") {
    values.push(normalizedScope.agentKey);
    parts.push(`agent_key = $${startIndex + 2}`, "identity_id IS NULL");
  } else {
    values.push(normalizedScope.identityId);
    parts.push("agent_key IS NULL", `identity_id = $${startIndex + 2}`);
  }

  return {
    sql: parts.join(" AND "),
    values,
  };
}

export class PostgresCredentialStore {
  private readonly pool: PgPoolLike;
  private readonly tables: CredentialTableNames;
  private readonly agentTables: ReturnType<typeof buildAgentTableNames>;
  private readonly identityTables: ReturnType<typeof buildIdentityTableNames>;

  constructor(options: PostgresCredentialStoreOptions) {
    this.pool = options.pool;
    const tablePrefix = options.tablePrefix ?? "thread_runtime";
    this.tables = buildCredentialTableNames(tablePrefix);
    this.agentTables = buildAgentTableNames(tablePrefix);
    this.identityTables = buildIdentityTableNames(tablePrefix);
  }

  async ensureSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.credentials} (
        id UUID PRIMARY KEY,
        env_key TEXT NOT NULL,
        scope TEXT NOT NULL,
        agent_key TEXT REFERENCES ${this.agentTables.agents}(agent_key) ON DELETE CASCADE,
        identity_id TEXT REFERENCES ${this.identityTables.identities}(id) ON DELETE CASCADE,
        value_ciphertext BYTEA NOT NULL,
        value_iv BYTEA NOT NULL,
        value_tag BYTEA NOT NULL,
        key_version SMALLINT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (scope IN ('relationship', 'agent', 'identity')),
        CHECK (
          (scope = 'relationship' AND agent_key IS NOT NULL AND identity_id IS NOT NULL)
          OR (scope = 'agent' AND agent_key IS NOT NULL AND identity_id IS NULL)
          OR (scope = 'identity' AND agent_key IS NULL AND identity_id IS NOT NULL)
        )
      )
    `);
    await this.pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_credentials_relationship_unique_idx`)}
      ON ${this.tables.credentials} (identity_id, agent_key, env_key)
      WHERE scope = 'relationship'
    `);
    await this.pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_credentials_agent_unique_idx`)}
      ON ${this.tables.credentials} (agent_key, env_key)
      WHERE scope = 'agent'
    `);
    await this.pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_credentials_identity_unique_idx`)}
      ON ${this.tables.credentials} (identity_id, env_key)
      WHERE scope = 'identity'
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_credentials_lookup_idx`)}
      ON ${this.tables.credentials} (env_key, scope, agent_key, identity_id)
    `);
  }

  async listCredentials(filter: CredentialListFilter = {}): Promise<readonly CredentialRecord[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (filter.envKey !== undefined) {
      values.push(normalizeCredentialEnvKey(filter.envKey));
      conditions.push(`env_key = $${values.length}`);
    }

    if (filter.scope !== undefined) {
      values.push(filter.scope);
      conditions.push(`scope = $${values.length}`);
    }

    if (filter.agentKey !== undefined) {
      values.push(filter.agentKey.trim());
      conditions.push(`agent_key = $${values.length}`);
    }

    if (filter.identityId !== undefined) {
      values.push(filter.identityId.trim());
      conditions.push(`identity_id = $${values.length}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.credentials}
      ${where}
      ORDER BY env_key ASC, scope ASC, updated_at DESC
    `, values);

    return result.rows.map((row) => parseCredentialRow(row as Record<string, unknown>));
  }

  async getCredentialExact(
    envKey: string,
    scopeInput: SetCredentialInput | CredentialRecord | CredentialListFilter,
    queryable: PgQueryable = this.pool,
  ): Promise<CredentialRecord | null> {
    const where = buildExactScopeWhere(envKey, scopeInput);
    const result = await queryable.query(`
      SELECT *
      FROM ${this.tables.credentials}
      WHERE ${where.sql}
      LIMIT 1
    `, where.values);

    const row = result.rows[0];
    return row ? parseCredentialRow(row as Record<string, unknown>) : null;
  }

  async setCredential(input: SetCredentialInput): Promise<CredentialRecord> {
    const normalizedScope = normalizeCredentialScopeInput(input);
    const normalizedEnvKey = normalizeCredentialEnvKey(input.envKey);
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      const existing = await this.getCredentialExact(normalizedEnvKey, normalizedScope, client);

      if (existing) {
        const updated = await client.query(`
          UPDATE ${this.tables.credentials}
          SET
            value_ciphertext = $2,
            value_iv = $3,
            value_tag = $4,
            key_version = $5,
            updated_at = NOW()
          WHERE id = $1
          RETURNING *
        `, [
          existing.id,
          input.encryptedValue.ciphertext,
          input.encryptedValue.iv,
          input.encryptedValue.tag,
          input.encryptedValue.keyVersion,
        ]);

        await client.query("COMMIT");
        return parseCredentialRow(updated.rows[0] as Record<string, unknown>);
      }

      const inserted = await client.query(`
        INSERT INTO ${this.tables.credentials} (
          id,
          env_key,
          scope,
          agent_key,
          identity_id,
          value_ciphertext,
          value_iv,
          value_tag,
          key_version
        ) VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9
        )
        RETURNING *
      `, [
        randomUUID(),
        normalizedEnvKey,
        normalizedScope.scope,
        normalizedScope.agentKey ?? null,
        normalizedScope.identityId ?? null,
        input.encryptedValue.ciphertext,
        input.encryptedValue.iv,
        input.encryptedValue.tag,
        input.encryptedValue.keyVersion,
      ]);

      await client.query("COMMIT");
      return parseCredentialRow(inserted.rows[0] as Record<string, unknown>);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteCredential(
    envKey: string,
    scopeInput: CredentialRecord | SetCredentialInput | CredentialListFilter,
  ): Promise<boolean> {
    const where = buildExactScopeWhere(envKey, scopeInput);
    const result = await this.pool.query(`
      DELETE FROM ${this.tables.credentials}
      WHERE ${where.sql}
    `, where.values);

    return Number(result.rowCount ?? 0) > 0;
  }

  async listResolvableCredentials(context: CredentialResolutionContext): Promise<readonly CredentialRecord[]> {
    const agentKey = context.agentKey?.trim();
    const identityId = context.identityId?.trim();
    const values: unknown[] = [];
    const parts: string[] = [];

    if (agentKey && identityId) {
      values.push(agentKey, identityId, agentKey, identityId);
      parts.push(
        `(scope = 'relationship' AND agent_key = $1 AND identity_id = $2)`,
        `(scope = 'agent' AND agent_key = $3)`,
        `(scope = 'identity' AND identity_id = $4)`,
      );
    } else if (agentKey) {
      values.push(agentKey);
      parts.push(`(scope = 'agent' AND agent_key = $1)`);
    } else if (identityId) {
      values.push(identityId);
      parts.push(`(scope = 'identity' AND identity_id = $1)`);
    } else {
      return [];
    }

    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.credentials}
      WHERE ${parts.join(" OR ")}
      ORDER BY
        env_key ASC,
        CASE scope
          WHEN 'relationship' THEN 0
          WHEN 'agent' THEN 1
          ELSE 2
        END ASC,
        updated_at DESC
    `, values);

    return result.rows.map((row) => parseCredentialRow(row as Record<string, unknown>));
  }

  async resolveCredential(
    envKey: string,
    context: CredentialResolutionContext,
  ): Promise<CredentialRecord | null> {
    const normalizedEnvKey = normalizeCredentialEnvKey(envKey);
    const agentKey = context.agentKey?.trim();
    const identityId = context.identityId?.trim();
    const values: unknown[] = [normalizedEnvKey];
    const parts: string[] = [];

    if (agentKey && identityId) {
      values.push(agentKey, identityId, agentKey, identityId);
      parts.push(
        `(scope = 'relationship' AND agent_key = $2 AND identity_id = $3)`,
        `(scope = 'agent' AND agent_key = $4)`,
        `(scope = 'identity' AND identity_id = $5)`,
      );
    } else if (agentKey) {
      values.push(agentKey);
      parts.push(`(scope = 'agent' AND agent_key = $2)`);
    } else if (identityId) {
      values.push(identityId);
      parts.push(`(scope = 'identity' AND identity_id = $2)`);
    } else {
      return null;
    }

    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.credentials}
      WHERE env_key = $1
        AND (${parts.join(" OR ")})
      ORDER BY
        CASE scope
          WHEN 'relationship' THEN 0
          WHEN 'agent' THEN 1
          ELSE 2
        END ASC,
        updated_at DESC
      LIMIT 1
    `, values);

    const row = result.rows[0];
    return row ? parseCredentialRow(row as Record<string, unknown>) : null;
  }
}
