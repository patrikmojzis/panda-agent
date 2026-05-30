import {CREATE_RUNTIME_SCHEMA_SQL, quoteIdentifier} from "../../lib/postgres-relations.js";
import type {PgQueryable} from "../../lib/postgres-query.js";
import {buildAgentTableNames} from "../agents/postgres-shared.js";
import {buildIdentityTableNames} from "../identity/postgres-shared.js";
import {buildControlTableNames} from "./postgres-shared.js";

export async function ensurePostgresControlSchema(pool: PgQueryable): Promise<void> {
  const tables = buildControlTableNames();
  const identityTables = buildIdentityTableNames();
  const agentTables = buildAgentTableNames();
  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.grants} (
      id UUID PRIMARY KEY,
      identity_id TEXT NOT NULL REFERENCES ${identityTables.identities}(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('admin', 'scoped')),
      agent_key TEXT REFERENCES ${agentTables.agents}(agent_key) ON DELETE CASCADE,
      label TEXT,
      login_token_hash TEXT NOT NULL UNIQUE,
      login_token_expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '15 minutes'),
      login_token_consumed_at TIMESTAMPTZ,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK ((role = 'admin' AND agent_key IS NULL) OR (role = 'scoped' AND agent_key IS NOT NULL))
    )
  `);
  await pool.query(`
    ALTER TABLE ${tables.grants}
    ADD COLUMN IF NOT EXISTS login_token_expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '15 minutes')
  `);
  await pool.query(`
    ALTER TABLE ${tables.grants}
    ADD COLUMN IF NOT EXISTS login_token_consumed_at TIMESTAMPTZ
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_control_grants_identity_idx`)}
    ON ${tables.grants} (identity_id, active)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.sessions} (
      id UUID PRIMARY KEY,
      session_token_hash TEXT NOT NULL UNIQUE,
      csrf_token_hash TEXT NOT NULL,
      identity_id TEXT NOT NULL REFERENCES ${identityTables.identities}(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('admin', 'scoped')),
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_control_sessions_identity_idx`)}
    ON ${tables.sessions} (identity_id, revoked_at, expires_at)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.auditEvents} (
      id UUID PRIMARY KEY,
      identity_id TEXT,
      session_id UUID,
      event_type TEXT NOT NULL,
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}
