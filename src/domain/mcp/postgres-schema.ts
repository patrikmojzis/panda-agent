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
      version BIGINT NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    ALTER TABLE ${tables.configs}
    ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.oauthConnections} (
      agent_key TEXT NOT NULL REFERENCES ${agents.agents}(agent_key) ON DELETE CASCADE,
      server_name TEXT NOT NULL,
      resource_url TEXT,
      authorization_server_url TEXT,
      state_ciphertext BYTEA NOT NULL,
      state_iv BYTEA NOT NULL,
      state_tag BYTEA NOT NULL,
      key_version SMALLINT NOT NULL,
      version BIGINT NOT NULL DEFAULT 1,
      authorized_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (agent_key, server_name),
      CHECK (server_name <> ''),
      CHECK (version > 0)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.oauthAttempts} (
      state_hash TEXT PRIMARY KEY,
      agent_key TEXT NOT NULL,
      server_name TEXT NOT NULL,
      verifier_ciphertext BYTEA NOT NULL,
      verifier_iv BYTEA NOT NULL,
      verifier_tag BYTEA NOT NULL,
      key_version SMALLINT NOT NULL,
      initiator_kind TEXT NOT NULL DEFAULT 'control' CHECK (initiator_kind IN ('control', 'agent')),
      initiated_identity_id TEXT,
      initiated_session_id TEXT NOT NULL,
      initiated_thread_id TEXT,
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      FOREIGN KEY (agent_key, server_name)
        REFERENCES ${tables.oauthConnections}(agent_key, server_name)
        ON DELETE CASCADE,
      CHECK (server_name <> ''),
      CHECK (state_hash <> '')
    )
  `);
  await pool.query(`
    ALTER TABLE ${tables.oauthAttempts}
    ADD COLUMN IF NOT EXISTS initiator_kind TEXT NOT NULL DEFAULT 'control'
  `);
  await pool.query(`
    ALTER TABLE ${tables.oauthAttempts}
    ADD COLUMN IF NOT EXISTS initiated_thread_id TEXT
  `);
  await pool.query(`
    ALTER TABLE ${tables.oauthAttempts}
    ALTER COLUMN initiated_identity_id DROP NOT NULL
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS agent_mcp_oauth_attempts_server_idx
    ON ${tables.oauthAttempts} (agent_key, server_name, expires_at DESC)
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS agent_mcp_oauth_attempts_owner_idx
    ON ${tables.oauthAttempts} (agent_key, server_name)
  `);
}
