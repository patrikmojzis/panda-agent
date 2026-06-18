import {quoteIdentifier, CREATE_RUNTIME_SCHEMA_SQL} from "../../lib/postgres-relations.js";

import {type PgQueryable} from "../../lib/postgres-query.js";
import {buildIdentityTableNames} from "../identity/postgres-shared.js";
import {buildAgentTableNames} from "./postgres-shared.js";

export async function ensurePostgresAgentTableSchema(pool: PgQueryable): Promise<void> {
  const tables = buildAgentTableNames();
  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.agents} (
      agent_key TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function ensurePostgresAgentSchema(pool: PgQueryable): Promise<void> {
  const tables = buildAgentTableNames();
  const identityTables = buildIdentityTableNames();

  await ensurePostgresAgentTableSchema(pool);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.agentPairings} (
      agent_key TEXT NOT NULL REFERENCES ${tables.agents}(agent_key) ON DELETE CASCADE,
      identity_id TEXT NOT NULL REFERENCES ${identityTables.identities}(id) ON DELETE CASCADE,
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (agent_key, identity_id)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_agent_pairings_identity_idx`)}
    ON ${tables.agentPairings} (identity_id, agent_key)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.agentSkills} (
      agent_key TEXT NOT NULL REFERENCES ${tables.agents}(agent_key) ON DELETE CASCADE,
      skill_key TEXT NOT NULL,
      description TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT[] NOT NULL DEFAULT '{}',
      agent_editable BOOLEAN NOT NULL DEFAULT TRUE,
      last_loaded_at TIMESTAMPTZ,
      load_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (agent_key, skill_key)
    )
  `);
  await pool.query(`
    ALTER TABLE ${tables.agentSkills}
    ADD COLUMN IF NOT EXISTS last_loaded_at TIMESTAMPTZ
  `);
  await pool.query(`
    ALTER TABLE ${tables.agentSkills}
    ADD COLUMN IF NOT EXISTS load_count INTEGER NOT NULL DEFAULT 0
  `);
  await pool.query(`
    ALTER TABLE ${tables.agentSkills}
    ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}'
  `);
  await pool.query(`
    ALTER TABLE ${tables.agentSkills}
    ADD COLUMN IF NOT EXISTS agent_editable BOOLEAN NOT NULL DEFAULT TRUE
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.agentPrompts} (
      agent_key TEXT NOT NULL REFERENCES ${tables.agents}(agent_key) ON DELETE CASCADE,
      slug TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (agent_key, slug)
    )
  `);
}
