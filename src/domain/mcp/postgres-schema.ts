import type {PgPoolLike} from "../../lib/postgres-query.js";
import {CREATE_RUNTIME_SCHEMA_SQL} from "../../lib/postgres-relations.js";
import {buildAgentTableNames} from "../agents/postgres-shared.js";
import {buildMcpTableNames} from "./postgres-shared.js";

export async function ensurePostgresMcpSchema(pool: PgPoolLike): Promise<void> {
  const tables = buildMcpTableNames();
  const agents = buildAgentTableNames();
  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.configs} (
      agent_key TEXT PRIMARY KEY REFERENCES ${agents.agents}(agent_key) ON DELETE CASCADE,
      config JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}
