import {quoteIdentifier, CREATE_RUNTIME_SCHEMA_SQL} from "../../lib/postgres-relations.js";
import type {PgQueryable} from "../../lib/postgres-query.js";
import {buildAgentTableNames} from "../agents/postgres-shared.js";
import {MAX_SUBAGENT_PROFILE_DESCRIPTION_CHARS} from "./types.js";
import {buildSubagentTableNames} from "./postgres-shared.js";

export async function ensurePostgresSubagentSchema(pool: PgQueryable): Promise<void> {
  const tables = buildSubagentTableNames();
  const agentTables = buildAgentTableNames();

  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.subagentProfiles} (
      slug TEXT NOT NULL,
      agent_key TEXT REFERENCES ${agentTables.agents}(agent_key) ON DELETE CASCADE,
      description TEXT NOT NULL CHECK (length(description) <= ${MAX_SUBAGENT_PROFILE_DESCRIPTION_CHARS}),
      prompt TEXT NOT NULL,
      tool_groups JSONB NOT NULL,
      model TEXT,
      thinking TEXT,
      transcript_mode TEXT NOT NULL DEFAULT 'none' CHECK (transcript_mode = 'none'),
      source TEXT NOT NULL CHECK (source IN ('builtin', 'custom')),
      created_by_agent_key TEXT REFERENCES ${agentTables.agents}(agent_key) ON DELETE SET NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_subagent_profiles_global_slug_idx`)}
    ON ${tables.subagentProfiles} (slug)
    WHERE agent_key IS NULL
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_subagent_profiles_agent_slug_idx`)}
    ON ${tables.subagentProfiles} (agent_key, slug)
    WHERE agent_key IS NOT NULL
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_subagent_profiles_enabled_slug_idx`)}
    ON ${tables.subagentProfiles} (enabled, slug)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_subagent_profiles_agent_enabled_slug_idx`)}
    ON ${tables.subagentProfiles} (agent_key, enabled, slug)
  `);
}
