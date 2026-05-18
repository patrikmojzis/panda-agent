import {randomUUID} from "node:crypto";

import {isJsonObject, readOptionalJsonValue, stringifyOptionalJsonValue, type JsonObject} from "../../lib/json.js";
import type {PgPoolLike} from "../../lib/postgres-query.js";
import {requireTimestampMillis} from "../../lib/postgres-values.js";
import {requireNonEmptyString, trimToUndefined} from "../../lib/strings.js";
import type {CredentialCrypto} from "../credentials/crypto.js";
import {ensurePostgresConnectorAccountSchema} from "./postgres-schema.js";
import {buildConnectorAccountTableNames, type ConnectorAccountTableNames} from "./postgres-shared.js";
import {
  type ConnectorAccountListFilter,
  type ConnectorAccountRecord,
  type ConnectorAccountSecretSummary,
  type ConnectorAccountStatus,
  normalizeConnectorAccountKey,
  normalizeConnectorAccountStatus,
  normalizeConnectorKey,
  normalizeConnectorOwnerInput,
  normalizeConnectorOwnerKind,
  normalizeConnectorSecretKey,
  normalizeConnectorSource,
  type UpsertConnectorAccountInput,
} from "./types.js";

export interface PostgresConnectorAccountStoreOptions {
  pool: PgPoolLike;
}

interface ConnectorAccountSecretValueRecord extends ConnectorAccountSecretSummary {
  valueCiphertext: Buffer;
  valueIv: Buffer;
  valueTag: Buffer;
  keyVersion: number;
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

  throw new Error("Connector account secret row is missing a binary field.");
}

function parseKeyVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error("Connector account secret key version must be a positive integer.");
  }

  return value;
}

function parseOptionalString(field: string, value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Connector account ${field} must be a string.`);
  }

  return trimToUndefined(value);
}

function parseJsonObject(value: unknown, label: string): JsonObject {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!isJsonObject(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }

  return parsed;
}

function stringifyJsonObject(value: JsonObject | undefined, label: string): string {
  const normalized = value ?? {};
  if (!isJsonObject(normalized)) {
    throw new Error(`${label} must be a JSON object.`);
  }

  return JSON.stringify(normalized);
}

function parseAccountRow(row: Record<string, unknown>): ConnectorAccountRecord {
  const owner = normalizeConnectorOwnerInput({
    ownerKind: row.owner_kind as ConnectorAccountRecord["ownerKind"],
    ownerIdentityId: parseOptionalString("owner identity id", row.owner_identity_id),
    ownerAgentKey: parseOptionalString("owner agent key", row.owner_agent_key),
  });

  return {
    id: requireNonEmptyString(row.id, "Connector account row is missing id."),
    source: normalizeConnectorSource(
      requireNonEmptyString(row.source, "Connector account row is missing source."),
    ),
    accountKey: normalizeConnectorAccountKey(
      requireNonEmptyString(row.account_key, "Connector account row is missing account key."),
    ),
    connectorKey: normalizeConnectorKey(
      requireNonEmptyString(row.connector_key, "Connector account row is missing connector key."),
    ),
    ...owner,
    displayName: parseOptionalString("display name", row.display_name),
    externalAccountId: parseOptionalString("external account id", row.external_account_id),
    externalUsername: parseOptionalString("external username", row.external_username),
    status: normalizeConnectorAccountStatus(row.status as ConnectorAccountStatus),
    config: parseJsonObject(row.config, "Connector account config"),
    metadata: readOptionalJsonValue(row.metadata, "Connector account metadata"),
    createdAt: requireTimestampMillis(row.created_at, "Connector account created_at must be a valid timestamp."),
    updatedAt: requireTimestampMillis(row.updated_at, "Connector account updated_at must be a valid timestamp."),
  };
}

function parseSecretSummaryRow(row: Record<string, unknown>): ConnectorAccountSecretSummary {
  return {
    accountId: requireNonEmptyString(row.account_id, "Connector account secret row is missing account id."),
    secretKey: normalizeConnectorSecretKey(
      requireNonEmptyString(row.secret_key, "Connector account secret row is missing secret key."),
    ),
    createdAt: requireTimestampMillis(row.created_at, "Connector account secret created_at must be a valid timestamp."),
    updatedAt: requireTimestampMillis(row.updated_at, "Connector account secret updated_at must be a valid timestamp."),
  };
}

function parseSecretValueRow(row: Record<string, unknown>): ConnectorAccountSecretValueRecord {
  return {
    ...parseSecretSummaryRow(row),
    valueCiphertext: toBuffer(row.value_ciphertext),
    valueIv: toBuffer(row.value_iv),
    valueTag: toBuffer(row.value_tag),
    keyVersion: parseKeyVersion(row.key_version),
  };
}

function requireConnectorAccountId(accountId: string): string {
  return requireNonEmptyString(accountId, "Connector account id must not be empty.");
}

function requireSecretPlaintext(value: string): string {
  return requireNonEmptyString(value, "Connector account secret value must not be empty.");
}

function requireCredentialCrypto(crypto: CredentialCrypto | null | undefined): CredentialCrypto {
  if (!crypto) {
    throw new Error("CredentialCrypto is required to access connector account secrets.");
  }

  return crypto;
}

export class PostgresConnectorAccountStore {
  private readonly pool: PgPoolLike;
  private readonly tables: ConnectorAccountTableNames;

  constructor(options: PostgresConnectorAccountStoreOptions) {
    this.pool = options.pool;
    this.tables = buildConnectorAccountTableNames();
  }

  async ensureSchema(): Promise<void> {
    await ensurePostgresConnectorAccountSchema(this.pool);
  }

  async upsertAccount(input: UpsertConnectorAccountInput): Promise<ConnectorAccountRecord> {
    const owner = normalizeConnectorOwnerInput(input);
    const result = await this.pool.query(`
      INSERT INTO ${this.tables.connectorAccounts} (
        id,
        source,
        account_key,
        connector_key,
        owner_kind,
        owner_identity_id,
        owner_agent_key,
        display_name,
        external_account_id,
        external_username,
        status,
        config,
        metadata
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
        $10,
        $11,
        $12::jsonb,
        $13::jsonb
      )
      ON CONFLICT (source, account_key)
      DO UPDATE SET
        connector_key = EXCLUDED.connector_key,
        owner_kind = EXCLUDED.owner_kind,
        owner_identity_id = EXCLUDED.owner_identity_id,
        owner_agent_key = EXCLUDED.owner_agent_key,
        display_name = EXCLUDED.display_name,
        external_account_id = EXCLUDED.external_account_id,
        external_username = EXCLUDED.external_username,
        status = EXCLUDED.status,
        config = EXCLUDED.config,
        metadata = EXCLUDED.metadata,
        updated_at = NOW()
      RETURNING *
    `, [
      input.id ?? randomUUID(),
      normalizeConnectorSource(input.source),
      normalizeConnectorAccountKey(input.accountKey),
      normalizeConnectorKey(input.connectorKey),
      owner.ownerKind,
      owner.ownerIdentityId,
      owner.ownerAgentKey,
      trimToUndefined(input.displayName) ?? null,
      trimToUndefined(input.externalAccountId) ?? null,
      trimToUndefined(input.externalUsername) ?? null,
      normalizeConnectorAccountStatus(input.status ?? "enabled"),
      stringifyJsonObject(input.config, "Connector account config"),
      stringifyOptionalJsonValue(input.metadata, "Connector account metadata"),
    ]);

    return parseAccountRow(result.rows[0] as Record<string, unknown>);
  }

  async getAccountByKey(source: string, accountKey: string): Promise<ConnectorAccountRecord | null> {
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.connectorAccounts}
      WHERE source = $1
        AND account_key = $2
      LIMIT 1
    `, [
      normalizeConnectorSource(source),
      normalizeConnectorAccountKey(accountKey),
    ]);

    const row = result.rows[0];
    return row ? parseAccountRow(row as Record<string, unknown>) : null;
  }

  async getAccountByConnectorKey(source: string, connectorKey: string): Promise<ConnectorAccountRecord | null> {
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.connectorAccounts}
      WHERE source = $1
        AND connector_key = $2
      LIMIT 1
    `, [
      normalizeConnectorSource(source),
      normalizeConnectorKey(connectorKey),
    ]);

    const row = result.rows[0];
    return row ? parseAccountRow(row as Record<string, unknown>) : null;
  }

  async listAccounts(filter: ConnectorAccountListFilter = {}): Promise<readonly ConnectorAccountRecord[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (filter.source !== undefined) {
      values.push(normalizeConnectorSource(filter.source));
      conditions.push(`source = $${values.length}`);
    }
    if (filter.status !== undefined) {
      values.push(normalizeConnectorAccountStatus(filter.status));
      conditions.push(`status = $${values.length}`);
    }
    if (filter.ownerKind !== undefined) {
      values.push(normalizeConnectorOwnerKind(filter.ownerKind));
      conditions.push(`owner_kind = $${values.length}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.connectorAccounts}
      ${where}
      ORDER BY source ASC, account_key ASC
    `, values);

    return result.rows.map((row) => parseAccountRow(row as Record<string, unknown>));
  }

  async enableAccount(source: string, accountKey: string): Promise<ConnectorAccountRecord> {
    return this.updateAccountStatus(source, accountKey, "enabled");
  }

  async disableAccount(source: string, accountKey: string): Promise<ConnectorAccountRecord> {
    return this.updateAccountStatus(source, accountKey, "disabled");
  }

  async setSecret(
    accountId: string,
    secretKey: string,
    plaintext: string,
    crypto: CredentialCrypto | null | undefined,
  ): Promise<ConnectorAccountSecretSummary> {
    const encryptedValue = requireCredentialCrypto(crypto).encrypt(requireSecretPlaintext(plaintext));
    const result = await this.pool.query(`
      INSERT INTO ${this.tables.connectorAccountSecrets} (
        account_id,
        secret_key,
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
        $6
      )
      ON CONFLICT (account_id, secret_key)
      DO UPDATE SET
        value_ciphertext = EXCLUDED.value_ciphertext,
        value_iv = EXCLUDED.value_iv,
        value_tag = EXCLUDED.value_tag,
        key_version = EXCLUDED.key_version,
        updated_at = NOW()
      RETURNING account_id, secret_key, created_at, updated_at
    `, [
      requireConnectorAccountId(accountId),
      normalizeConnectorSecretKey(secretKey),
      encryptedValue.ciphertext,
      encryptedValue.iv,
      encryptedValue.tag,
      encryptedValue.keyVersion,
    ]);

    return parseSecretSummaryRow(result.rows[0] as Record<string, unknown>);
  }

  async getSecret(
    accountId: string,
    secretKey: string,
    crypto: CredentialCrypto | null | undefined,
  ): Promise<string | null> {
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.connectorAccountSecrets}
      WHERE account_id = $1
        AND secret_key = $2
      LIMIT 1
    `, [
      requireConnectorAccountId(accountId),
      normalizeConnectorSecretKey(secretKey),
    ]);

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    const secret = parseSecretValueRow(row as Record<string, unknown>);
    return requireCredentialCrypto(crypto).decrypt(secret);
  }

  async listSecretKeys(accountId: string): Promise<readonly ConnectorAccountSecretSummary[]> {
    const result = await this.pool.query(`
      SELECT account_id, secret_key, created_at, updated_at
      FROM ${this.tables.connectorAccountSecrets}
      WHERE account_id = $1
      ORDER BY secret_key ASC
    `, [requireConnectorAccountId(accountId)]);

    return result.rows.map((row) => parseSecretSummaryRow(row as Record<string, unknown>));
  }

  private async updateAccountStatus(
    source: string,
    accountKey: string,
    status: ConnectorAccountStatus,
  ): Promise<ConnectorAccountRecord> {
    const result = await this.pool.query(`
      UPDATE ${this.tables.connectorAccounts}
      SET status = $3,
          updated_at = NOW()
      WHERE source = $1
        AND account_key = $2
      RETURNING *
    `, [
      normalizeConnectorSource(source),
      normalizeConnectorAccountKey(accountKey),
      normalizeConnectorAccountStatus(status),
    ]);

    const row = result.rows[0];
    if (!row) {
      throw new Error(`Unknown connector account ${source}/${accountKey}.`);
    }

    return parseAccountRow(row as Record<string, unknown>);
  }
}
