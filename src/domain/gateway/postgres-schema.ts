import {quoteIdentifier, CREATE_RUNTIME_SCHEMA_SQL} from "../../lib/postgres-relations.js";

import {buildAgentTableNames} from "../agents/postgres-shared.js";
import {buildIdentityTableNames} from "../identity/postgres-shared.js";
import type {PgQueryable} from "../../lib/postgres-query.js";
import {buildSessionTableNames} from "../sessions/postgres-shared.js";
import {buildGatewayTableNames} from "./postgres-shared.js";

export async function ensurePostgresGatewaySchema(pool: PgQueryable): Promise<void> {
  const tables = buildGatewayTableNames();
  const agentTables = buildAgentTableNames();
  const identityTables = buildIdentityTableNames();
  const sessionTables = buildSessionTableNames();
  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.sources} (
      source_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      client_id TEXT NOT NULL UNIQUE,
      client_secret_hash TEXT NOT NULL,
      agent_key TEXT NOT NULL REFERENCES ${agentTables.agents}(agent_key) ON DELETE CASCADE,
      identity_id TEXT NOT NULL REFERENCES ${identityTables.identities}(id) ON DELETE CASCADE,
      session_id TEXT REFERENCES ${sessionTables.sessions}(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'active',
      suspended_at TIMESTAMPTZ,
      suspend_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.eventTypes} (
      source_id TEXT NOT NULL REFERENCES ${tables.sources}(source_id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      delivery TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (source_id, event_type)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.accessTokens} (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      source_id TEXT NOT NULL REFERENCES ${tables.sources}(source_id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_gateway_access_tokens_source_idx`)}
    ON ${tables.accessTokens} (source_id, expires_at DESC)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.events} (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES ${tables.sources}(source_id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      delivery_requested TEXT NOT NULL,
      delivery_effective TEXT NOT NULL,
      occurred_at TIMESTAMPTZ,
      idempotency_key TEXT NOT NULL,
      text TEXT NOT NULL,
      text_bytes INTEGER NOT NULL,
      text_sha256 TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      risk_score DOUBLE PRECISION,
      reason TEXT,
      thread_id TEXT,
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      claim_id TEXT,
      claimed_at TIMESTAMPTZ,
      processed_at TIMESTAMPTZ,
      delivered_at TIMESTAMPTZ,
      text_scrubbed_at TIMESTAMPTZ,
      UNIQUE (source_id, idempotency_key)
    )
  `);
  await pool.query(`
    ALTER TABLE ${tables.events}
    ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ
  `);
  await pool.query(`
    ALTER TABLE ${tables.events}
    ADD COLUMN IF NOT EXISTS claim_id TEXT
  `);
  await pool.query(`
    ALTER TABLE ${tables.events}
    ADD COLUMN IF NOT EXISTS metadata JSONB
  `);
  await pool.query(`
    ALTER TABLE ${tables.events}
    ADD COLUMN IF NOT EXISTS text_scrubbed_at TIMESTAMPTZ
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_gateway_events_pending_idx`)}
    ON ${tables.events} (status, created_at)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.rateLimits} (
      bucket_key TEXT PRIMARY KEY,
      window_start TIMESTAMPTZ NOT NULL,
      used BIGINT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_gateway_rate_limits_updated_idx`)}
    ON ${tables.rateLimits} (updated_at)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.strikes} (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES ${tables.sources}(source_id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      reason TEXT NOT NULL,
      event_id TEXT REFERENCES ${tables.events}(id) ON DELETE SET NULL,
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    ALTER TABLE ${tables.strikes}
    ADD COLUMN IF NOT EXISTS metadata JSONB
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_gateway_strikes_source_kind_idx`)}
    ON ${tables.strikes} (source_id, kind, created_at DESC)
  `);
}
