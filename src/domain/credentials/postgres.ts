import {randomUUID} from "node:crypto";

import type {PgPoolLike, PgQueryable} from "../../lib/postgres-query.js";
import {requireNonEmptyString} from "../../lib/strings.js";
import {requireTimestampMillis} from "../../lib/postgres-values.js";
import {ensurePostgresCredentialSchema} from "./postgres-schema.js";
import {buildCredentialTableNames, type CredentialTableNames} from "./postgres-shared.js";
import {
  type CredentialListFilter,
  type CredentialRecord,
  type CredentialResolutionContext,
  normalizeCredentialAgentKey,
  normalizeCredentialEnvKey,
  type SetCredentialInput,
} from "./types.js";

export interface PostgresCredentialStoreOptions {
  pool: PgPoolLike;
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

function parseKeyVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error("Credential key version must be a positive integer.");
  }

  return value;
}

function parseCredentialRow(row: Record<string, unknown>): CredentialRecord {
  return {
    id: requireNonEmptyString(row.id, "Credential row is missing id."),
    envKey: normalizeCredentialEnvKey(
      requireNonEmptyString(row.env_key, "Credential row is missing env key."),
    ),
    agentKey: normalizeCredentialAgentKey(
      requireNonEmptyString(row.agent_key, "Credential row is missing agent key."),
    ),
    valueCiphertext: toBuffer(row.value_ciphertext),
    valueIv: toBuffer(row.value_iv),
    valueTag: toBuffer(row.value_tag),
    keyVersion: parseKeyVersion(row.key_version),
    createdAt: requireTimestampMillis(row.created_at, "Credential created_at must be a valid timestamp."),
    updatedAt: requireTimestampMillis(row.updated_at, "Credential updated_at must be a valid timestamp."),
  };
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

  constructor(options: PostgresCredentialStoreOptions) {
    this.pool = options.pool;
    this.tables = buildCredentialTableNames();
  }

  async ensureSchema(): Promise<void> {
    await ensurePostgresCredentialSchema(this.pool);
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
