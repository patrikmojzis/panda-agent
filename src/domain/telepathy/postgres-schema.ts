import {quoteIdentifier, CREATE_RUNTIME_SCHEMA_SQL} from "../../lib/postgres-relations.js";

import {type PgQueryable} from "../../lib/postgres-query.js";
import {buildAgentTableNames} from "../agents/postgres-shared.js";
import {buildTelepathyTableNames} from "./postgres-shared.js";

export async function ensurePostgresTelepathyDeviceSchema(pool: PgQueryable): Promise<void> {
  const tables = buildTelepathyTableNames();
  const agentTables = buildAgentTableNames();
  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.devices} (
      agent_key TEXT NOT NULL REFERENCES ${agentTables.agents}(agent_key) ON DELETE CASCADE,
      device_id TEXT NOT NULL,
      label TEXT,
      token_hash TEXT NOT NULL,
      connected BOOLEAN NOT NULL DEFAULT FALSE,
      connected_at TIMESTAMPTZ,
      last_seen_at TIMESTAMPTZ,
      last_disconnected_at TIMESTAMPTZ,
      disabled_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (agent_key, device_id)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_telepathy_devices_agent_idx`)}
    ON ${tables.devices} (agent_key, updated_at DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_telepathy_devices_connected_idx`)}
    ON ${tables.devices} (connected, agent_key)
  `);
}
