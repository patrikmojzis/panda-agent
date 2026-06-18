import {quoteIdentifier, CREATE_RUNTIME_SCHEMA_SQL} from "../../lib/postgres-relations.js";

import {buildAgentTableNames} from "../agents/postgres-shared.js";
import type {PgQueryable} from "../../lib/postgres-query.js";
import {buildSessionTableNames} from "../sessions/postgres-shared.js";
import {buildExecutionEnvironmentTableNames} from "./postgres-shared.js";

export async function ensurePostgresExecutionEnvironmentSchema(pool: PgQueryable): Promise<void> {
  const tables = buildExecutionEnvironmentTableNames();
  const agentTables = buildAgentTableNames();
  const sessionTables = buildSessionTableNames();
  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.executionEnvironments} (
      id TEXT PRIMARY KEY,
      agent_key TEXT NOT NULL REFERENCES ${agentTables.agents}(agent_key) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'ready',
      runner_url TEXT,
      runner_cwd TEXT,
      root_path TEXT,
      created_by_session_id TEXT REFERENCES ${sessionTables.sessions}(id) ON DELETE SET NULL,
      created_for_session_id TEXT REFERENCES ${sessionTables.sessions}(id) ON DELETE SET NULL,
      expires_at TIMESTAMPTZ,
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.sessionEnvironmentBindings} (
      session_id TEXT NOT NULL REFERENCES ${sessionTables.sessions}(id) ON DELETE CASCADE,
      environment_id TEXT NOT NULL REFERENCES ${tables.executionEnvironments}(id) ON DELETE CASCADE,
      alias TEXT NOT NULL,
      is_default BOOLEAN NOT NULL DEFAULT FALSE,
      allow_override BOOLEAN NOT NULL DEFAULT FALSE,
      credential_policy JSONB NOT NULL DEFAULT '{"mode":"none"}'::jsonb,
      skill_policy JSONB NOT NULL DEFAULT '{"mode":"none"}'::jsonb,
      tool_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (session_id, environment_id)
    )
  `);
  await pool.query(`
    ALTER TABLE ${tables.sessionEnvironmentBindings}
    ADD COLUMN IF NOT EXISTS skill_policy JSONB NOT NULL DEFAULT '{"mode":"none"}'::jsonb
  `);
  await pool.query(`
    ALTER TABLE ${tables.sessionEnvironmentBindings}
    ALTER COLUMN skill_policy SET DEFAULT '{"mode":"none"}'::jsonb
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_session_environment_alias_idx`)}
    ON ${tables.sessionEnvironmentBindings} (session_id, alias)
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_session_environment_default_idx`)}
    ON ${tables.sessionEnvironmentBindings} (session_id)
    WHERE is_default
  `);
}
