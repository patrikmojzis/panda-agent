INSERT INTO runtime.agent_sessions (
  id,
  agent_key,
  kind,
  current_thread_id,
  created_by_identity_id,
  metadata
) VALUES (
  'ci-legacy-session',
  'panda',
  'main',
  'ci-legacy-thread',
  'ci-smoke-identity',
  '{}'::jsonb
);

-- Simulate databases created before runtime.threads.context was dropped.
ALTER TABLE runtime.threads
ADD COLUMN context JSONB;

INSERT INTO runtime.threads (
  id,
  session_id,
  context,
  runtime_state
) VALUES (
  'ci-legacy-thread',
  'ci-legacy-session',
  '{}'::jsonb,
  '{}'::jsonb
);

CREATE TABLE runtime.session_routes (
  session_id TEXT NOT NULL,
  identity_id TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL,
  connector_key TEXT NOT NULL,
  external_conversation_id TEXT NOT NULL,
  external_actor_id TEXT,
  external_message_id TEXT,
  captured_at_ms BIGINT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO runtime.session_routes (
  session_id,
  identity_id,
  channel,
  connector_key,
  external_conversation_id,
  external_actor_id,
  external_message_id,
  captured_at_ms,
  metadata
) VALUES (
  'ci-legacy-session',
  '',
  'tui',
  'local',
  'ci-legacy-conversation',
  'ci-smoke-actor',
  'ci-smoke-message',
  1779196398000,
  '{"fixture":"legacy-minimal"}'::jsonb
);

CREATE TABLE runtime.credentials (
  id UUID PRIMARY KEY,
  env_key TEXT NOT NULL,
  scope TEXT,
  agent_key TEXT,
  identity_id TEXT,
  value_ciphertext BYTEA NOT NULL,
  value_iv BYTEA NOT NULL,
  value_tag BYTEA NOT NULL,
  key_version SMALLINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX runtime_credentials_agent_unique_idx
ON runtime.credentials (agent_key, env_key)
WHERE scope = 'agent';

INSERT INTO runtime.credentials (
  id,
  env_key,
  scope,
  agent_key,
  identity_id,
  value_ciphertext,
  value_iv,
  value_tag,
  key_version
) VALUES (
  '00000000-0000-4000-8000-000000000001',
  'CI_FAKE_SECRET',
  'relationship',
  'panda',
  'ci-smoke-identity',
  decode('00', 'hex'),
  decode('00', 'hex'),
  decode('00', 'hex'),
  1
);
