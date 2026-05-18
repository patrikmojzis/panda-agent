import {CREATE_RUNTIME_SCHEMA_SQL, quoteIdentifier, buildRuntimeRelationNames} from "../../../lib/postgres-relations.js";
import type {PgQueryable} from "../../../lib/postgres-query.js";

interface WhatsAppAuthTableNames {
  prefix: string;
  authCreds: string;
  authKeys: string;
}

export function buildWhatsAppAuthTableNames(): WhatsAppAuthTableNames {
  return buildRuntimeRelationNames({
    authCreds: "whatsapp_auth_creds",
    authKeys: "whatsapp_auth_keys",
  });
}

export async function ensurePostgresWhatsAppAuthSchema(pool: PgQueryable): Promise<void> {
  const tables = buildWhatsAppAuthTableNames();
  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.authCreds} (
      connector_key TEXT PRIMARY KEY,
      creds JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.authKeys} (
      connector_key TEXT NOT NULL,
      category TEXT NOT NULL,
      key_id TEXT NOT NULL,
      value JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (connector_key, category, key_id)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_whatsapp_auth_keys_updated_idx`)}
    ON ${tables.authKeys} (updated_at DESC)
  `);
}
