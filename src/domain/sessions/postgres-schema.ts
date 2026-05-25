import {quoteIdentifier, CREATE_RUNTIME_SCHEMA_SQL} from "../../lib/postgres-relations.js";

import {buildAgentTableNames} from "../agents/postgres-shared.js";
import {buildIdentityTableNames} from "../identity/postgres-shared.js";
import type {PgQueryable} from "../../lib/postgres-query.js";
import {addConstraint, assertIntegrityChecks} from "../../lib/postgres-integrity.js";
import {buildSessionTableNames} from "./postgres-shared.js";
import {DEFAULT_SESSION_HEARTBEAT_EVERY_MINUTES} from "./types.js";

export async function ensurePostgresSessionSchema(pool: PgQueryable): Promise<void> {
  const tables = buildSessionTableNames();
  const agentTableName = buildAgentTableNames().agents;
  const identityTableName = buildIdentityTableNames().identities;

  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.sessions} (
      id TEXT PRIMARY KEY,
      agent_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      current_thread_id TEXT NOT NULL,
      created_by_identity_id TEXT,
      alias TEXT,
      display_name TEXT,
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    ALTER TABLE ${tables.sessions}
    ADD COLUMN IF NOT EXISTS alias TEXT
  `);
  await pool.query(`
    ALTER TABLE ${tables.sessions}
    ADD COLUMN IF NOT EXISTS display_name TEXT
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_agent_sessions_main_idx`)}
    ON ${tables.sessions} (agent_key)
    WHERE kind = 'main'
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_agent_sessions_agent_alias_idx`)}
    ON ${tables.sessions} (agent_key, alias)
    WHERE alias IS NOT NULL
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_agent_sessions_agent_idx`)}
    ON ${tables.sessions} (agent_key, created_at DESC)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.sessionRuntimeConfig} (
      session_id TEXT NOT NULL,
      model TEXT,
      thinking TEXT,
      thinking_configured BOOLEAN NOT NULL DEFAULT FALSE,
      inference_projection JSONB,
      pending_wake_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_session_runtime_config_session_idx`)}
    ON ${tables.sessionRuntimeConfig} (session_id)
  `);
  await pool.query(`
    ALTER TABLE ${tables.sessionRuntimeConfig}
    ADD COLUMN IF NOT EXISTS thinking_configured BOOLEAN NOT NULL DEFAULT FALSE
  `);
  await pool.query(`
    ALTER TABLE ${tables.sessionRuntimeConfig}
    ADD COLUMN IF NOT EXISTS inference_projection JSONB
  `);
  await pool.query(`
    ALTER TABLE ${tables.sessionRuntimeConfig}
    ADD COLUMN IF NOT EXISTS pending_wake_at TIMESTAMPTZ
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.sessionHeartbeats} (
      session_id TEXT PRIMARY KEY REFERENCES ${tables.sessions}(id) ON DELETE CASCADE,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      every_minutes INTEGER NOT NULL DEFAULT ${DEFAULT_SESSION_HEARTBEAT_EVERY_MINUTES},
      next_fire_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '${DEFAULT_SESSION_HEARTBEAT_EVERY_MINUTES} minutes',
      last_fire_at TIMESTAMPTZ,
      last_skip_reason TEXT,
      claimed_at TIMESTAMPTZ,
      claimed_by TEXT,
      claim_expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_session_heartbeats_due_idx`)}
    ON ${tables.sessionHeartbeats} (enabled, next_fire_at, claim_expires_at, session_id)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.sessionPrompts} (
      session_id TEXT NOT NULL REFERENCES ${tables.sessions}(id) ON DELETE CASCADE,
      slug TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (session_id, slug)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_session_prompts_session_idx`)}
      ON ${tables.sessionPrompts} (session_id)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.sessionTodos} (
      session_id TEXT PRIMARY KEY REFERENCES ${tables.sessions}(id) ON DELETE CASCADE,
      items JSONB NOT NULL,
      items_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await assertIntegrityChecks(pool, "Session schema", [
    {
      label: "agent_sessions.agent_key orphaned from agents.agent_key",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.sessions} AS session
        LEFT JOIN ${agentTableName} AS agent
          ON agent.agent_key = session.agent_key
        WHERE agent.agent_key IS NULL
      `,
    },
    {
      label: "agent_sessions.created_by_identity_id orphaned from identities.id",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.sessions} AS session
        LEFT JOIN ${identityTableName} AS identity
          ON identity.id = session.created_by_identity_id
        WHERE session.created_by_identity_id IS NOT NULL
          AND identity.id IS NULL
      `,
    },
    {
      label: "session_runtime_config.session_id orphaned from agent_sessions.id",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.sessionRuntimeConfig} AS config
        LEFT JOIN ${tables.sessions} AS session
          ON session.id = config.session_id
        WHERE session.id IS NULL
      `,
    },
  ]);
  await addConstraint(pool, `
    ALTER TABLE ${tables.sessions}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_agent_sessions_agent_fk`)}
    FOREIGN KEY (agent_key)
    REFERENCES ${agentTableName}(agent_key)
    ON DELETE CASCADE
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.sessions}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_agent_sessions_created_by_identity_fk`)}
    FOREIGN KEY (created_by_identity_id)
    REFERENCES ${identityTableName}(id)
    ON DELETE SET NULL
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.sessionRuntimeConfig}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_session_runtime_config_session_fk`)}
    FOREIGN KEY (session_id)
    REFERENCES ${tables.sessions}(id)
    ON DELETE CASCADE
  `);
}
