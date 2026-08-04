import {quoteIdentifier, CREATE_RUNTIME_SCHEMA_SQL} from "../../../lib/postgres-relations.js";

import {type PgQueryable} from "../../../lib/postgres-query.js";
import {buildRuntimeRequestTableNames} from "./postgres-shared.js";

export async function ensurePostgresRuntimeRequestSchema(pool: PgQueryable): Promise<void> {
  const tables = buildRuntimeRequestTableNames();
  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.runtimeRequests} (
      id UUID PRIMARY KEY,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      payload JSONB NOT NULL,
      idempotency_key TEXT,
      result JSONB,
      error TEXT,
      claimed_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE ${tables.runtimeRequests} ADD COLUMN IF NOT EXISTS idempotency_key TEXT`);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_runtime_requests_idempotency_idx`)}
    ON ${tables.runtimeRequests} (idempotency_key)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_runtime_requests_pending_idx`)}
    ON ${tables.runtimeRequests} (status, created_at, id)
  `);
}
