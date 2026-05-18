import {quoteIdentifier, CREATE_RUNTIME_SCHEMA_SQL} from "../../lib/postgres-relations.js";

import {type PgQueryable} from "../../lib/postgres-query.js";

export const POSTGRES_CONNECTOR_LEASE_TABLE = `"runtime"."connector_leases"`;

export async function ensurePostgresConnectorLeaseSchema(pool: PgQueryable): Promise<void> {
  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${POSTGRES_CONNECTOR_LEASE_TABLE} (
      source TEXT NOT NULL,
      connector_key TEXT NOT NULL,
      holder_id TEXT NOT NULL,
      leased_until TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (source, connector_key)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier("runtime_connector_leases_expiry_idx")}
    ON ${POSTGRES_CONNECTOR_LEASE_TABLE} (leased_until)
  `);
}
