import type {PgQueryable} from "../../lib/postgres-query.js";
import {buildAgentTableNames} from "../agents/postgres-shared.js";
import {CREATE_RUNTIME_SCHEMA_SQL} from "../../lib/postgres-relations.js";
import {buildWikiBindingTableNames} from "./postgres-shared.js";

export async function ensurePostgresWikiBindingSchema(pool: PgQueryable): Promise<void> {
  const tables = buildWikiBindingTableNames();
  const agentTables = buildAgentTableNames();
  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.wikiBindings} (
      agent_key TEXT PRIMARY KEY REFERENCES ${agentTables.agents}(agent_key) ON DELETE CASCADE,
      wiki_group_id INTEGER NOT NULL,
      namespace_path TEXT NOT NULL,
      api_token_ciphertext BYTEA NOT NULL,
      api_token_iv BYTEA NOT NULL,
      api_token_tag BYTEA NOT NULL,
      key_version SMALLINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (wiki_group_id > 0),
      CHECK (namespace_path <> '')
    )
  `);
}
