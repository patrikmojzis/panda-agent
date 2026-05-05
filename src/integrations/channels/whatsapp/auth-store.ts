import type {Pool, PoolClient} from "pg";

import {
    type AuthenticationCreds,
    type AuthenticationState,
    BufferJSON,
    initAuthCreds,
    proto,
    type SignalDataSet,
    type SignalDataTypeMap,
} from "baileys";

import {
    buildRuntimeRelationNames,
    CREATE_RUNTIME_SCHEMA_SQL,
    quoteIdentifier,
    toMillis,
} from "../../../domain/threads/runtime/postgres-shared.js";

interface PgQueryable {
  query: Pool["query"];
}

interface PgPoolLike extends PgQueryable {
  connect(): Promise<PoolClient>;
}

interface WhatsAppAuthTableNames {
  prefix: string;
  authCreds: string;
  authKeys: string;
}

export interface PostgresWhatsAppAuthStoreOptions {
  pool: PgPoolLike;
}

export interface WhatsAppAuthStateHandle {
  state: AuthenticationState;
  saveCreds(): Promise<void>;
}

export interface TransientWhatsAppAuthStateHandle extends WhatsAppAuthStateHandle {
  promoteTo(connectorKey: string): Promise<void>;
}

export interface WhatsAppAuthCredsRecord {
  connectorKey: string;
  creds: AuthenticationCreds;
  createdAt: number;
  updatedAt: number;
}

function buildWhatsAppAuthTableNames(): WhatsAppAuthTableNames {
  return buildRuntimeRelationNames({
    authCreds: "whatsapp_auth_creds",
    authKeys: "whatsapp_auth_keys",
  });
}

function requireTrimmedConnectorKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("WhatsApp auth connector key must not be empty.");
  }

  return trimmed;
}

function requireTrimmedKeyPart(field: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`WhatsApp auth ${field} must not be empty.`);
  }

  return trimmed;
}

function serializeBaileysJson(value: unknown): string {
  return JSON.stringify(value, BufferJSON.replacer);
}

function reviveBaileysJson<T>(value: unknown): T | null {
  if (value === null || value === undefined) {
    return null;
  }

  return JSON.parse(JSON.stringify(value), BufferJSON.reviver) as T;
}

function reviveSignalValue<T extends keyof SignalDataTypeMap>(
  type: T,
  value: unknown,
): SignalDataTypeMap[T] | undefined {
  const revived = reviveBaileysJson<SignalDataTypeMap[T]>(value);
  if (revived === null) {
    return undefined;
  }

  if (type === "app-state-sync-key") {
    return proto.Message.AppStateSyncKeyData.fromObject(revived as object) as unknown as SignalDataTypeMap[T];
  }

  return revived;
}

function parseCredsRow(row: Record<string, unknown>): WhatsAppAuthCredsRecord {
  const creds = reviveBaileysJson<AuthenticationCreds>(row.creds);
  if (!creds) {
    throw new Error("Invalid WhatsApp auth creds row.");
  }

  return {
    connectorKey: String(row.connector_key),
    creds,
    createdAt: toMillis(row.created_at),
    updatedAt: toMillis(row.updated_at),
  };
}

export class PostgresWhatsAppAuthStore {
  private readonly pool: PgPoolLike;
  private readonly tables: WhatsAppAuthTableNames;

  constructor(options: PostgresWhatsAppAuthStoreOptions) {
    this.pool = options.pool;
    this.tables = buildWhatsAppAuthTableNames();
  }

  async ensureSchema(): Promise<void> {
    await this.pool.query(CREATE_RUNTIME_SCHEMA_SQL);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.authCreds} (
        connector_key TEXT PRIMARY KEY,
        creds JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.authKeys} (
        connector_key TEXT NOT NULL,
        category TEXT NOT NULL,
        key_id TEXT NOT NULL,
        value JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (connector_key, category, key_id)
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_whatsapp_auth_keys_updated_idx`)}
      ON ${this.tables.authKeys} (updated_at DESC)
    `);
  }

  async loadCreds(connectorKey: string): Promise<AuthenticationCreds> {
    const normalizedConnectorKey = requireTrimmedConnectorKey(connectorKey);
    const result = await this.pool.query(
      `
        SELECT *
        FROM ${this.tables.authCreds}
        WHERE connector_key = $1
      `,
      [normalizedConnectorKey],
    );

    const row = result.rows[0];
    if (!row) {
      return initAuthCreds();
    }

    return parseCredsRow(row as Record<string, unknown>).creds;
  }

  async saveCreds(connectorKey: string, creds: AuthenticationCreds): Promise<WhatsAppAuthCredsRecord> {
    const normalizedConnectorKey = requireTrimmedConnectorKey(connectorKey);
    const result = await this.pool.query(
      `
        INSERT INTO ${this.tables.authCreds} (
          connector_key,
          creds
        ) VALUES (
          $1,
          $2::jsonb
        )
        ON CONFLICT (connector_key)
        DO UPDATE SET
          creds = EXCLUDED.creds,
          updated_at = NOW()
        RETURNING *
      `,
      [
        normalizedConnectorKey,
        serializeBaileysJson(creds),
      ],
    );

    return parseCredsRow(result.rows[0] as Record<string, unknown>);
  }

  async loadSignalKeys<T extends keyof SignalDataTypeMap>(
    connectorKey: string,
    type: T,
    ids: readonly string[],
  ): Promise<{ [id: string]: SignalDataTypeMap[T] }> {
    const normalizedConnectorKey = requireTrimmedConnectorKey(connectorKey);
    const normalizedType = requireTrimmedKeyPart("key category", type);
    const normalizedIds = [...new Set(ids.map((id) => requireTrimmedKeyPart("key id", id)))];

    if (normalizedIds.length === 0) {
      return {};
    }

    const result = await this.pool.query(
      `
        SELECT key_id, value
        FROM ${this.tables.authKeys}
        WHERE connector_key = $1
          AND category = $2
          AND key_id = ANY($3::text[])
      `,
      [
        normalizedConnectorKey,
        normalizedType,
        normalizedIds,
      ],
    );

    const valuesById = new Map<string, unknown>();
    for (const row of result.rows as Array<Record<string, unknown>>) {
      valuesById.set(String(row.key_id), row.value);
    }

    const data: Record<string, SignalDataTypeMap[T] | undefined> = {};
    for (const id of normalizedIds) {
      data[id] = reviveSignalValue(type, valuesById.get(id));
    }

    return data as { [id: string]: SignalDataTypeMap[T] };
  }

  async saveSignalKeys(connectorKey: string, data: SignalDataSet): Promise<void> {
    const normalizedConnectorKey = requireTrimmedConnectorKey(connectorKey);
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");

      for (const [category, entries] of Object.entries(data) as Array<[keyof SignalDataTypeMap, SignalDataSet[keyof SignalDataTypeMap]]>) {
        if (!entries) {
          continue;
        }

        const normalizedCategory = requireTrimmedKeyPart("key category", category);
        for (const [id, value] of Object.entries(entries)) {
          const normalizedId = requireTrimmedKeyPart("key id", id);
          if (value === null) {
            await client.query(
              `
                DELETE FROM ${this.tables.authKeys}
                WHERE connector_key = $1
                  AND category = $2
                  AND key_id = $3
              `,
              [
                normalizedConnectorKey,
                normalizedCategory,
                normalizedId,
              ],
            );
            continue;
          }

          await client.query(
            `
              INSERT INTO ${this.tables.authKeys} (
                connector_key,
                category,
                key_id,
                value
              ) VALUES (
                $1,
                $2,
                $3,
                $4::jsonb
              )
              ON CONFLICT (connector_key, category, key_id)
              DO UPDATE SET
                value = EXCLUDED.value,
                updated_at = NOW()
            `,
            [
              normalizedConnectorKey,
              normalizedCategory,
              normalizedId,
              serializeBaileysJson(value),
            ],
          );
        }
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async createAuthState(connectorKey: string): Promise<WhatsAppAuthStateHandle> {
    const normalizedConnectorKey = requireTrimmedConnectorKey(connectorKey);
    const creds = await this.loadCreds(normalizedConnectorKey);

    return {
      state: {
        creds,
        keys: {
          get: async (type, ids) => this.loadSignalKeys(normalizedConnectorKey, type, ids),
          set: async (data) => this.saveSignalKeys(normalizedConnectorKey, data),
        },
      },
      saveCreds: async () => {
        await this.saveCreds(normalizedConnectorKey, creds);
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
            for (const id of ids) {
              result[id] = values?.get(id) as SignalDataTypeMap[typeof type] | undefined;
            }

            return result as { [id: string]: SignalDataTypeMap[typeof type] };
          },
          set: async (data) => {
            for (const [category, entries] of Object.entries(data) as Array<[keyof SignalDataTypeMap, SignalDataSet[keyof SignalDataTypeMap]]>) {
              if (!entries) {
                continue;
              }

              let values = keyStore.get(category);
              if (!values) {
                values = new Map();
                keyStore.set(category, values);
              }

              for (const [id, value] of Object.entries(entries)) {
                if (value === null) {
                  values.delete(id);
                  continue;
                }

                values.set(id, value as SignalDataTypeMap[keyof SignalDataTypeMap]);
              }
            }
          },
        },
      },
      saveCreds: async () => {},
      promoteTo: async (connectorKey) => {
        const normalizedConnectorKey = requireTrimmedConnectorKey(connectorKey);
        await this.saveCreds(normalizedConnectorKey, creds);

        for (const [category, values] of keyStore.entries()) {
          if (values.size === 0) {
            continue;
          }

          const entries: Record<string, SignalDataTypeMap[keyof SignalDataTypeMap]> = {};
          for (const [id, value] of values.entries()) {
            entries[id] = value;
          }

          await this.saveSignalKeys(normalizedConnectorKey, {
            [category]: entries,
          } as SignalDataSet);
        }
      },
    };
  }
}
