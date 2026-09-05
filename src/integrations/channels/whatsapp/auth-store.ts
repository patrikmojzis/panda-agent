import {
  type AuthenticationCreds,
  type AuthenticationState,
  BufferJSON,
  initAuthCreds,
  proto,
  type SignalDataSet,
  type SignalDataTypeMap,
} from "baileys";

import type {SecretCrypto, SecretContext} from "../../../domain/secrets/crypto.js";
import {buildConnectorAccountTableNames} from "../../../domain/connectors/postgres-shared.js";
import {normalizeConnectorAccountId} from "../../../domain/connectors/types.js";
import type {PgPoolLike, PgQueryable} from "../../../lib/postgres-query.js";
import {requireTimestampMillis} from "../../../lib/postgres-values.js";
import {isRecord} from "../../../lib/records.js";
import {requireNonEmptyString, uniqueTrimmedStrings} from "../../../lib/strings.js";
import {buildWhatsAppAuthTableNames} from "./auth-schema.js";

export interface PostgresWhatsAppAuthStoreOptions {
  pool: PgPoolLike;
  crypto: SecretCrypto;
}

export interface WhatsAppAuthStateHandle {
  state: AuthenticationState;
  saveCreds(): Promise<void>;
}

export interface TransientWhatsAppAuthStateHandle extends WhatsAppAuthStateHandle {
  promoteTo(accountId: string): Promise<void>;
}

export interface WhatsAppAuthCredsRecord {
  accountId: string;
  creds: AuthenticationCreds;
  createdAt: number;
  updatedAt: number;
}

function requireKeyPart(field: string, value: unknown): string {
  return requireNonEmptyString(value, `WhatsApp auth ${field} must not be empty.`);
}

function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string" && value.startsWith("\\x")) return Buffer.from(value.slice(2), "hex");
  if (typeof value === "string") return Buffer.from(value, "utf8");
  throw new Error("WhatsApp auth encrypted row is missing a binary field.");
}

function parseEnvelopeVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error("WhatsApp auth envelope version must be a positive integer.");
  }
  return value;
}

function serializeBaileysJson(value: unknown): string {
  return JSON.stringify(value, BufferJSON.replacer);
}

function parseEncryptedJson<T>(row: Record<string, unknown>, crypto: SecretCrypto, context: SecretContext): T {
  const plaintext = crypto.open({
    ciphertext: toBuffer(row.value_ciphertext),
    iv: toBuffer(row.value_iv),
    tag: toBuffer(row.value_tag),
    envelopeVersion: parseEnvelopeVersion(row.envelope_version),
  }, context);
  return JSON.parse(plaintext, BufferJSON.reviver) as T;
}

function reviveSignalValue<T extends keyof SignalDataTypeMap>(
  type: T,
  row: Record<string, unknown> | undefined,
  crypto: SecretCrypto,
  context: SecretContext,
): SignalDataTypeMap[T] | undefined {
  if (!row) return undefined;
  const revived = parseEncryptedJson<unknown>(row, crypto, context);
  if (type !== "app-state-sync-key") return revived as SignalDataTypeMap[T];
  if (!isRecord(revived)) throw new Error("WhatsApp auth app-state-sync-key value must be an object.");
  return proto.Message.AppStateSyncKeyData.fromObject(revived) as unknown as SignalDataTypeMap[T];
}

export class PostgresWhatsAppAuthStore {
  private readonly pool: PgPoolLike;
  private readonly crypto: SecretCrypto;
  private readonly tables = buildWhatsAppAuthTableNames();
  private readonly connectorTables = buildConnectorAccountTableNames();

  constructor(options: PostgresWhatsAppAuthStoreOptions) {
    this.pool = options.pool;
    this.crypto = options.crypto;
  }

  async hasAuthState(accountId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM ${this.tables.authCreds} WHERE account_id = $1 LIMIT 1`,
      [normalizeConnectorAccountId(accountId)],
    );
    return result.rows.length > 0;
  }

  async loadCreds(accountId: string): Promise<AuthenticationCreds> {
    const normalizedAccountId = normalizeConnectorAccountId(accountId);
    const result = await this.pool.query(
      `SELECT * FROM ${this.tables.authCreds} WHERE account_id = $1`,
      [normalizedAccountId],
    );
    const row = result.rows[0];
    if (!row) return initAuthCreds();
    return parseEncryptedJson<AuthenticationCreds>(
      row as Record<string, unknown>,
      this.crypto,
      {purpose: "whatsapp-auth-creds", identity: [normalizedAccountId]},
    );
  }

  async saveCreds(accountId: string, creds: AuthenticationCreds): Promise<WhatsAppAuthCredsRecord> {
    return this.writeCreds(this.pool, accountId, creds);
  }

  private async writeCreds(
    queryable: PgQueryable,
    accountId: string,
    creds: AuthenticationCreds,
  ): Promise<WhatsAppAuthCredsRecord> {
    const normalizedAccountId = normalizeConnectorAccountId(accountId);
    const encrypted = this.crypto.seal(
      serializeBaileysJson(creds),
      {purpose: "whatsapp-auth-creds", identity: [normalizedAccountId]},
    );
    const result = await queryable.query(`
      INSERT INTO ${this.tables.authCreds} (
        account_id, value_ciphertext, value_iv, value_tag, envelope_version
      ) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (account_id)
      DO UPDATE SET
        value_ciphertext = EXCLUDED.value_ciphertext,
        value_iv = EXCLUDED.value_iv,
        value_tag = EXCLUDED.value_tag,
        envelope_version = EXCLUDED.envelope_version,
        updated_at = NOW()
      RETURNING account_id::text AS account_id, created_at, updated_at
    `, [normalizedAccountId, encrypted.ciphertext, encrypted.iv, encrypted.tag, encrypted.envelopeVersion]);
    const row = result.rows[0] as Record<string, unknown>;
    return {
      accountId: normalizeConnectorAccountId(requireKeyPart("account id", row.account_id)),
      creds,
      createdAt: requireTimestampMillis(row.created_at, "WhatsApp auth created_at must be a valid timestamp."),
      updatedAt: requireTimestampMillis(row.updated_at, "WhatsApp auth updated_at must be a valid timestamp."),
    };
  }

  async loadSignalKeys<T extends keyof SignalDataTypeMap>(
    accountId: string,
    type: T,
    ids: readonly string[],
  ): Promise<{[id: string]: SignalDataTypeMap[T]}> {
    const normalizedAccountId = normalizeConnectorAccountId(accountId);
    const normalizedType = requireKeyPart("key category", type);
    const normalizedIds = uniqueTrimmedStrings(ids.map((id) => requireKeyPart("key id", id)));
    if (normalizedIds.length === 0) return {};
    const result = await this.pool.query(`
      SELECT key_id, value_ciphertext, value_iv, value_tag, envelope_version
      FROM ${this.tables.authKeys}
      WHERE account_id = $1 AND category = $2 AND key_id = ANY($3::text[])
    `, [normalizedAccountId, normalizedType, normalizedIds]);
    const rowsById = new Map<string, Record<string, unknown>>();
    for (const raw of result.rows) {
      const row = raw as Record<string, unknown>;
      rowsById.set(requireKeyPart("key id", row.key_id), row);
    }
    const data: Record<string, SignalDataTypeMap[T] | undefined> = {};
    for (const id of normalizedIds) {
      data[id] = reviveSignalValue(
        type,
        rowsById.get(id),
        this.crypto,
        {purpose: "whatsapp-auth-key", identity: [normalizedAccountId, normalizedType, id]},
      );
    }
    return data as {[id: string]: SignalDataTypeMap[T]};
  }

  async saveSignalKeys(accountId: string, data: SignalDataSet): Promise<void> {
    const normalizedAccountId = normalizeConnectorAccountId(accountId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.writeSignalKeys(client, normalizedAccountId, data);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async writeSignalKeys(
    queryable: PgQueryable,
    accountId: string,
    data: SignalDataSet,
  ): Promise<void> {
    const normalizedAccountId = normalizeConnectorAccountId(accountId);
    for (const [category, entries] of Object.entries(data) as Array<[keyof SignalDataTypeMap, SignalDataSet[keyof SignalDataTypeMap]]>) {
      if (!entries) continue;
      const normalizedCategory = requireKeyPart("key category", category);
      for (const [id, value] of Object.entries(entries)) {
        const normalizedId = requireKeyPart("key id", id);
        if (value === null) {
          await queryable.query(
            `DELETE FROM ${this.tables.authKeys} WHERE account_id = $1 AND category = $2 AND key_id = $3`,
            [normalizedAccountId, normalizedCategory, normalizedId],
          );
          continue;
        }
        const encrypted = this.crypto.seal(
          serializeBaileysJson(value),
          {purpose: "whatsapp-auth-key", identity: [normalizedAccountId, normalizedCategory, normalizedId]},
        );
        await queryable.query(`
          INSERT INTO ${this.tables.authKeys} (
            account_id, category, key_id, value_ciphertext, value_iv, value_tag, envelope_version
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (account_id, category, key_id)
          DO UPDATE SET
            value_ciphertext = EXCLUDED.value_ciphertext,
            value_iv = EXCLUDED.value_iv,
            value_tag = EXCLUDED.value_tag,
            envelope_version = EXCLUDED.envelope_version,
            updated_at = NOW()
        `, [
          normalizedAccountId,
          normalizedCategory,
          normalizedId,
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.tag,
          encrypted.envelopeVersion,
        ]);
      }
    }
  }

  async deleteAuthState(accountId: string): Promise<void> {
    const normalizedAccountId = normalizeConnectorAccountId(accountId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM ${this.tables.authKeys} WHERE account_id = $1`, [normalizedAccountId]);
      await client.query(`DELETE FROM ${this.tables.authCreds} WHERE account_id = $1`, [normalizedAccountId]);
      await client.query(`DELETE FROM ${this.tables.runtimeStatus} WHERE account_id = $1`, [normalizedAccountId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async writeForEnabledAccount(
    accountId: string,
    write: (client: PgQueryable) => Promise<void>,
  ): Promise<void> {
    const normalizedAccountId = normalizeConnectorAccountId(accountId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Disable/reset must wait for any accepted worker write, then future writes
      // see the disabled status and become no-ops.
      const enabled = await client.query(`
        SELECT 1
        FROM ${this.connectorTables.connectorAccounts}
        WHERE id = $1
          AND source = 'whatsapp'
          AND status = 'enabled'
        FOR UPDATE
      `, [normalizedAccountId]);
      if (enabled.rows.length === 0) {
        await client.query("COMMIT");
        return;
      }
      await write(client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async createAuthState(accountId: string): Promise<WhatsAppAuthStateHandle> {
    const normalizedAccountId = normalizeConnectorAccountId(accountId);
    const creds = await this.loadCreds(normalizedAccountId);
    return {
      state: {
        creds,
        keys: {
          get: async (type, ids) => this.loadSignalKeys(normalizedAccountId, type, ids),
          set: async (data) => this.writeForEnabledAccount(normalizedAccountId, async (client) => {
            await this.writeSignalKeys(client, normalizedAccountId, data);
          }),
        },
      },
      saveCreds: async () => {
        await this.writeForEnabledAccount(normalizedAccountId, async (client) => {
          await this.writeCreds(client, normalizedAccountId, creds);
        });
      },
    };
  }

  createTransientAuthState(): TransientWhatsAppAuthStateHandle {
    const creds = initAuthCreds();
    const keyStore = new Map<keyof SignalDataTypeMap, Map<string, SignalDataTypeMap[keyof SignalDataTypeMap]>>();
    return {
      state: {
        creds,
        keys: {
          get: async (type, ids) => {
            const values = keyStore.get(type);
            const result: Record<string, SignalDataTypeMap[typeof type] | undefined> = {};
            for (const id of ids) result[id] = values?.get(id) as SignalDataTypeMap[typeof type] | undefined;
            return result as {[id: string]: SignalDataTypeMap[typeof type]};
          },
          set: async (data) => {
            for (const [category, entries] of Object.entries(data) as Array<[keyof SignalDataTypeMap, SignalDataSet[keyof SignalDataTypeMap]]>) {
              if (!entries) continue;
              let values = keyStore.get(category);
              if (!values) {
                values = new Map();
                keyStore.set(category, values);
              }
              for (const [id, value] of Object.entries(entries)) {
                if (value === null) values.delete(id);
                else values.set(id, value as SignalDataTypeMap[keyof SignalDataTypeMap]);
              }
            }
          },
        },
      },
      saveCreds: async () => {},
      promoteTo: async (accountId) => {
        const normalizedAccountId = normalizeConnectorAccountId(accountId);
        const externalAccountId = creds.me?.id?.trim();
        if (!creds.registered || !externalAccountId) {
          throw new Error("WhatsApp linking completed without a registered account identity.");
        }
        const displayName = creds.me?.name?.trim() || creds.me?.notify?.trim() || null;
        const client = await this.pool.connect();
        try {
          await client.query("BEGIN");
          const target = await client.query(`
            SELECT 1
            FROM ${this.connectorTables.connectorAccounts}
            WHERE id = $1 AND source = 'whatsapp' AND owner_kind = 'agent'
            FOR UPDATE
          `, [normalizedAccountId]);
          if (target.rows.length !== 1) {
            throw new Error("WhatsApp auth can only be promoted to an agent-owned connector account.");
          }
          await this.writeCreds(client, normalizedAccountId, creds);
          for (const [category, values] of keyStore.entries()) {
            if (values.size === 0) continue;
            const entries: Record<string, SignalDataTypeMap[keyof SignalDataTypeMap]> = {};
            for (const [id, value] of values.entries()) entries[id] = value;
            await this.writeSignalKeys(client, normalizedAccountId, {[category]: entries});
          }
          const promoted = await client.query(`
            UPDATE ${this.connectorTables.connectorAccounts}
            SET external_account_id = $2,
                display_name = COALESCE(display_name, $3),
                status = 'enabled',
                updated_at = NOW()
            WHERE id = $1 AND source = 'whatsapp' AND owner_kind = 'agent'
            RETURNING id
          `, [normalizedAccountId, externalAccountId, displayName]);
          if (promoted.rows.length !== 1) {
            throw new Error("WhatsApp auth can only be promoted to an agent-owned connector account.");
          }
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      },
    };
  }
}
