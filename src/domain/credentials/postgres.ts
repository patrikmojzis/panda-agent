import {randomUUID} from "node:crypto";

import type {Pool, PoolClient} from "pg";

import {buildAgentTableNames} from "../agents/postgres-shared.js";
import {
  CREATE_RUNTIME_SCHEMA_SQL,
  quoteIdentifier,
  quoteQualifiedIdentifier,
  RUNTIME_SCHEMA,
  toMillis,
} from "../threads/runtime/postgres-shared.js";
import {buildCredentialTableNames, type CredentialTableNames} from "./postgres-shared.js";
import {
  type CredentialListFilter,
  type CredentialRecord,
  type CredentialResolutionContext,
  normalizeCredentialAgentKey,
  normalizeCredentialEnvKey,
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
}

const OLD_CREDENTIAL_INDEXES = [
  "runtime_credentials_relationship_unique_idx",
  "runtime_credentials_agent_unique_idx",
  "runtime_credentials_identity_unique_idx",
  "runtime_credentials_lookup_idx",
] as const;

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
    agentKey: String(row.agent_key),
    valueCiphertext: toBuffer(row.value_ciphertext),
    valueIv: toBuffer(row.value_iv),
    valueTag: toBuffer(row.value_tag),
    keyVersion: Number(row.key_version),
    createdAt: toMillis(row.created_at),
    updatedAt: toMillis(row.updated_at),
  };
}

function isDuplicateTableError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && (
      (error as {code?: unknown}).code === "42P07"
      || /relation ".+" already exists/i.test(String((error as {message?: unknown}).message ?? error))
    );
}

function isMissingRelationOrColumnError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && (
      (error as {code?: unknown}).code === "42P01"
      || (error as {code?: unknown}).code === "42703"
      || /relation ".+" does not exist/i.test(String((error as {message?: unknown}).message ?? error))
      || /column ".+" does not exist/i.test(String((error as {message?: unknown}).message ?? error))
    );
}

function buildCredentialWhere(
  envKey: string,
  input: {agentKey: string},
  startIndex = 1,
): {
  sql: string;
  values: unknown[];
} {
  const normalizedEnvKey = normalizeCredentialEnvKey(envKey);
  const normalizedAgentKey = normalizeCredentialAgentKey(input.agentKey);

  return {
    sql: `env_key = $${startIndex} AND agent_key = $${startIndex + 1}`,
    values: [normalizedEnvKey, normalizedAgentKey],
  };
}

export class PostgresCredentialStore {
  private readonly pool: PgPoolLike;
  private readonly tables: CredentialTableNames;
  private readonly agentTables: ReturnType<typeof buildAgentTableNames>;

  constructor(options: PostgresCredentialStoreOptions) {
    this.pool = options.pool;
    this.tables = buildCredentialTableNames();
    this.agentTables = buildAgentTableNames();
  }

  async ensureSchema(): Promise<void> {
    await this.pool.query(CREATE_RUNTIME_SCHEMA_SQL);
    if (!(await this.credentialTableExists())) {
      try {
        await this.pool.query(`
          CREATE TABLE ${this.tables.credentials} (
            id UUID PRIMARY KEY,
            env_key TEXT NOT NULL,
            agent_key TEXT NOT NULL REFERENCES ${this.agentTables.agents}(agent_key) ON DELETE CASCADE,
            value_ciphertext BYTEA NOT NULL,
            value_iv BYTEA NOT NULL,
            value_tag BYTEA NOT NULL,
            key_version SMALLINT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
      } catch (error) {
        if (!isDuplicateTableError(error)) {
          throw error;
        }
      }
    }
    await this.migrateAgentOnlySchema();
    await this.pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_credentials_agent_env_unique_idx`)}
      ON ${this.tables.credentials} (agent_key, env_key)
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_credentials_lookup_idx`)}
      ON ${this.tables.credentials} (env_key, agent_key)
    `);
  }

  private async credentialTableExists(): Promise<boolean> {
    try {
      await this.pool.query(`SELECT 1 FROM ${this.tables.credentials} LIMIT 0`);
      return true;
    } catch (error) {
      if (isMissingRelationOrColumnError(error)) {
        return false;
      }

      throw error;
    }
  }

  private async credentialColumnExists(columnName: string): Promise<boolean> {
    try {
      await this.pool.query(`SELECT ${quoteIdentifier(columnName)} FROM ${this.tables.credentials} LIMIT 0`);
      return true;
    } catch (error) {
      if (isMissingRelationOrColumnError(error)) {
        return false;
      }

      throw error;
    }
  }

  private async migrateAgentOnlySchema(): Promise<void> {
    const hasScopeColumn = await this.credentialColumnExists("scope");

    if (hasScopeColumn) {
      for (const indexName of OLD_CREDENTIAL_INDEXES) {
        await this.pool.query(`DROP INDEX IF EXISTS ${quoteQualifiedIdentifier(RUNTIME_SCHEMA, indexName)}`);
      }

      await this.pool.query(`
        DELETE FROM ${this.tables.credentials}
        WHERE agent_key IS NULL OR agent_key = ''
      `);
      await this.pool.query(`
        DELETE FROM ${this.tables.credentials}
        WHERE (scope <> 'agent' OR scope IS NULL)
          AND CONCAT(agent_key, ':', env_key) IN (
            SELECT CONCAT(agent_key, ':', env_key)
            FROM ${this.tables.credentials}
            WHERE scope = 'agent'
          )
      `);
      await this.pool.query(`
        DELETE FROM ${this.tables.credentials}
        WHERE id IN (
          SELECT duplicate.id
          FROM ${this.tables.credentials} duplicate, ${this.tables.credentials} keeper
          WHERE (duplicate.scope <> 'agent' OR duplicate.scope IS NULL)
            AND (keeper.scope <> 'agent' OR keeper.scope IS NULL)
            AND duplicate.agent_key = keeper.agent_key
            AND duplicate.env_key = keeper.env_key
            AND duplicate.id < keeper.id
        )
      `);
      await this.pool.query(`
        UPDATE ${this.tables.credentials}
        SET scope = 'agent',
            identity_id = NULL
        WHERE scope <> 'agent' OR scope IS NULL
      `);
    }
    await this.pool.query(`
      DELETE FROM ${this.tables.credentials}
      WHERE agent_key IS NULL OR agent_key = ''
    `);

    await this.pool.query(`
      ALTER TABLE ${this.tables.credentials}
      DROP COLUMN IF EXISTS scope
    `);
    await this.pool.query(`
      ALTER TABLE ${this.tables.credentials}
      DROP COLUMN IF EXISTS identity_id
    `);
    await this.pool.query(`
      ALTER TABLE ${this.tables.credentials}
      ALTER COLUMN agent_key SET NOT NULL
    `);
  }

  async listCredentials(filter: CredentialListFilter = {}): Promise<readonly CredentialRecord[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (filter.envKey !== undefined) {
      values.push(normalizeCredentialEnvKey(filter.envKey));
      conditions.push(`env_key = $${values.length}`);
    }

    if (filter.agentKey !== undefined) {
      values.push(normalizeCredentialAgentKey(filter.agentKey));
      conditions.push(`agent_key = $${values.length}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.credentials}
      ${where}
      ORDER BY env_key ASC, agent_key ASC
    `, values);

    return result.rows.map((row) => parseCredentialRow(row as Record<string, unknown>));
  }

  async getCredential(
    envKey: string,
    input: {agentKey: string},
    queryable: PgQueryable = this.pool,
  ): Promise<CredentialRecord | null> {
    const where = buildCredentialWhere(envKey, input);
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
    const normalizedAgentKey = normalizeCredentialAgentKey(input.agentKey);
    const normalizedEnvKey = normalizeCredentialEnvKey(input.envKey);
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      const existing = await this.getCredential(normalizedEnvKey, {agentKey: normalizedAgentKey}, client);

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
          agent_key,
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
          $7
        )
        RETURNING *
      `, [
        randomUUID(),
        normalizedEnvKey,
        normalizedAgentKey,
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
    input: {agentKey: string},
  ): Promise<boolean> {
    const where = buildCredentialWhere(envKey, input);
    const result = await this.pool.query(`
      DELETE FROM ${this.tables.credentials}
      WHERE ${where.sql}
    `, where.values);

    return Number(result.rowCount ?? 0) > 0;
  }

  async listResolvableCredentials(context: CredentialResolutionContext): Promise<readonly CredentialRecord[]> {
    const agentKey = context.agentKey?.trim();
    if (!agentKey) {
      return [];
    }

    return this.listCredentials({agentKey});
  }

  async resolveCredential(
    envKey: string,
    context: CredentialResolutionContext,
  ): Promise<CredentialRecord | null> {
    const normalizedEnvKey = normalizeCredentialEnvKey(envKey);
    const agentKey = context.agentKey?.trim();
    if (!agentKey) {
      return null;
    }

    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.credentials}
      WHERE env_key = $1
        AND agent_key = $2
      LIMIT 1
    `, [normalizedEnvKey, normalizeCredentialAgentKey(agentKey)]);

    const row = result.rows[0];
    return row ? parseCredentialRow(row as Record<string, unknown>) : null;
  }
}
