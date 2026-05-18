import {quoteIdentifier, CREATE_RUNTIME_SCHEMA_SQL} from "../../lib/postgres-relations.js";

import {type PgQueryable} from "../../lib/postgres-query.js";
import {buildAgentTableNames} from "../agents/postgres-shared.js";
import {buildIdentityTableNames} from "../identity/postgres-shared.js";
import {buildSessionTableNames} from "../sessions/postgres-shared.js";
import {buildAgentAppAuthTableNames} from "./auth-shared.js";

export async function ensurePostgresAgentAppAuthSchema(pool: PgQueryable): Promise<void> {
  const tables = buildAgentAppAuthTableNames();
  const agentTables = buildAgentTableNames();
  const identityTables = buildIdentityTableNames();
  const sessionTables = buildSessionTableNames();
  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.launchTokens} (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      agent_key TEXT NOT NULL REFERENCES ${agentTables.agents}(agent_key) ON DELETE CASCADE,
      app_slug TEXT NOT NULL,
      identity_id TEXT NOT NULL REFERENCES ${identityTables.identities}(id) ON DELETE CASCADE,
      session_id TEXT REFERENCES ${sessionTables.sessions}(id) ON DELETE SET NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_app_launch_tokens_lookup_idx`)}
    ON ${tables.launchTokens} (agent_key, app_slug, identity_id, expires_at DESC)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.sessions} (
      id TEXT PRIMARY KEY,
      session_token_hash TEXT NOT NULL UNIQUE,
      csrf_token_hash TEXT NOT NULL,
      agent_key TEXT NOT NULL REFERENCES ${agentTables.agents}(agent_key) ON DELETE CASCADE,
      app_slug TEXT NOT NULL,
      identity_id TEXT NOT NULL REFERENCES ${identityTables.identities}(id) ON DELETE CASCADE,
      session_id TEXT REFERENCES ${sessionTables.sessions}(id) ON DELETE SET NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_app_sessions_lookup_idx`)}
    ON ${tables.sessions} (agent_key, app_slug, identity_id, expires_at DESC)
    WHERE revoked_at IS NULL
  `);
}
