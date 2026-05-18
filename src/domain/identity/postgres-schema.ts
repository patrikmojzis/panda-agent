import {quoteIdentifier, CREATE_RUNTIME_SCHEMA_SQL} from "../../lib/postgres-relations.js";

import {type PgQueryable} from "../../lib/postgres-query.js";
import {buildIdentityTableNames} from "./postgres-shared.js";

export async function ensurePostgresIdentitySchema(pool: PgQueryable): Promise<void> {
  const tables = buildIdentityTableNames();
  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.identities} (
      id TEXT PRIMARY KEY,
      handle TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.identityBindings} (
      id UUID PRIMARY KEY,
      identity_id TEXT NOT NULL REFERENCES ${tables.identities}(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      connector_key TEXT NOT NULL,
      external_actor_id TEXT NOT NULL,
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_identity_bindings_lookup_idx`)}
    ON ${tables.identityBindings} (source, connector_key, external_actor_id)
  `);
}
