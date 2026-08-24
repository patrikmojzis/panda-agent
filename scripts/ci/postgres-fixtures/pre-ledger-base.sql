-- Immutable minimal database shape supported by the pre-ledger cutover.
-- Do not update this from current schema installers. Add another historical
-- fixture when a distinct deployed shape needs upgrade coverage.
CREATE SCHEMA runtime;

CREATE TABLE runtime.identities (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE runtime.agents (
  agent_key TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE runtime.agent_sessions (
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
);

CREATE TABLE runtime.threads (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  runtime_state JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO runtime.identities (id, handle, display_name)
VALUES ('ci-smoke-identity', 'ci-smoke', 'CI Smoke');

INSERT INTO runtime.agents (agent_key, display_name)
VALUES ('panda', 'Panda');
