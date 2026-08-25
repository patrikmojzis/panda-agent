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

-- Pre-global-ledger deployments kept subsystem-local migration markers.
-- Migration 0001 may consult them while upgrading, then must remove them.
CREATE TABLE runtime.thread_runtime_migrations (
  migration_key TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE runtime.whatsapp_migrations (
  migration_key TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

-- Pre-lineage input/message storage retained two copies of the payload and had
-- no durable link between them. Migration 0001 must prove the canonical match
-- before turning the input into a compact idempotency tombstone.
CREATE TABLE runtime.inputs (
  id UUID PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES runtime.threads(id) ON DELETE CASCADE,
  input_order BIGSERIAL NOT NULL,
  delivery_mode TEXT NOT NULL DEFAULT 'wake',
  source TEXT NOT NULL,
  channel_id TEXT,
  external_message_id TEXT,
  actor_id TEXT,
  identity_id TEXT REFERENCES runtime.identities(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL,
  applied_at TIMESTAMPTZ,
  metadata JSONB,
  message JSONB NOT NULL
);

CREATE TABLE runtime.messages (
  id UUID PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES runtime.threads(id) ON DELETE CASCADE,
  sequence BIGSERIAL NOT NULL,
  origin TEXT NOT NULL,
  source TEXT NOT NULL,
  channel_id TEXT,
  external_message_id TEXT,
  actor_id TEXT,
  identity_id TEXT REFERENCES runtime.identities(id) ON DELETE SET NULL,
  run_id UUID,
  created_at TIMESTAMPTZ NOT NULL,
  metadata JSONB,
  message JSONB NOT NULL
);

INSERT INTO runtime.inputs (
  id, thread_id, source, channel_id, external_message_id, actor_id,
  identity_id, created_at, applied_at, metadata, message
) VALUES (
  '00000000-0000-4000-8000-000000000010',
  'ci-legacy-thread',
  'tui',
  'ci-legacy-channel',
  'ci-legacy-input-message',
  'ci-smoke-actor',
  'ci-smoke-identity',
  '2026-05-20T10:00:00Z',
  '2026-05-20T10:00:01Z',
  '{"fixture":"legacy-input"}'::jsonb,
  '{"role":"user","content":"hello from legacy"}'::jsonb
);

INSERT INTO runtime.messages (
  id, thread_id, origin, source, channel_id, external_message_id, actor_id,
  identity_id, created_at, metadata, message
) VALUES (
  '00000000-0000-4000-8000-000000000011',
  'ci-legacy-thread',
  'input',
  'tui',
  'ci-legacy-channel',
  'ci-legacy-input-message',
  'ci-smoke-actor',
  'ci-smoke-identity',
  '2026-05-20T10:00:00Z',
  '{"fixture":"legacy-input"}'::jsonb,
  '{"role":"user","content":"hello from legacy"}'::jsonb
);

INSERT INTO runtime.messages (
  id, thread_id, origin, source, created_at, metadata, message
) VALUES (
  '00000000-0000-4000-8000-000000000013',
  'ci-legacy-thread',
  'runtime',
  'compact',
  '2026-05-20T10:00:02Z',
  '{"kind":"compact_boundary","trigger":"auto","preservedTailUserTurns":3,"compactedUpToSequence":1,"fixture":"legacy-checkpoint"}'::jsonb,
  '{"role":"system","content":"legacy compact checkpoint"}'::jsonb
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
  decode('6c2b3552723038657569714a5277564c7967773d', 'hex'),
  decode('41414543417751464267634943516f4c', 'hex'),
  decode('55506f7a4c552f73796b474566722f6a2f69393150773d3d', 'hex'),
  1
);

-- Runtime requests originally had neither stable target ids nor a causal FIFO
-- key. These rows exercise both migration-only repairs before the new NOT NULL
-- and key constraints are installed.
CREATE TABLE runtime.live_voice_sessions (
  id UUID PRIMARY KEY,
  source TEXT NOT NULL,
  connector_key TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  room_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  agent_key TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  state TEXT NOT NULL,
  transport_context JSONB,
  last_error TEXT,
  health_state TEXT,
  health_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  health_observed_at TIMESTAMPTZ,
  diagnostics JSONB,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE runtime.live_voice_turns (
  id UUID PRIMARY KEY,
  live_voice_session_id UUID NOT NULL REFERENCES runtime.live_voice_sessions(id),
  provider_delegation_id TEXT NOT NULL,
  source_utterance_id UUID NOT NULL,
  session_id TEXT NOT NULL,
  agent_key TEXT NOT NULL,
  external_actor_id TEXT,
  identity_id TEXT,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL,
  thread_id UUID,
  run_id UUID,
  result_text TEXT,
  final_control_id UUID,
  final_text TEXT,
  error TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (live_voice_session_id, provider_delegation_id),
  UNIQUE (live_voice_session_id, source_utterance_id)
);

INSERT INTO runtime.live_voice_sessions (
  id, source, connector_key, scope_key, room_key, session_id, agent_key,
  provider, model, state
) VALUES (
  '00000000-0000-4000-8000-000000000020',
  'discord',
  'ci-legacy-discord',
  'ci-legacy-guild',
  'ci-legacy-room',
  'ci-legacy-session',
  'panda',
  'openai-live',
  'gpt-live-1-codex',
  'connected'
);

INSERT INTO runtime.live_voice_turns (
  id, live_voice_session_id, provider_delegation_id, source_utterance_id,
  session_id, agent_key, prompt, status
) VALUES (
  '00000000-0000-4000-8000-000000000021',
  '00000000-0000-4000-8000-000000000020',
  'ci-legacy-delegation',
  '00000000-0000-4000-8000-000000000022',
  'ci-legacy-session',
  'panda',
  'legacy voice request',
  'pending'
);

CREATE TABLE runtime.runtime_requests (
  id UUID PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  payload JSONB NOT NULL,
  result JSONB,
  error TEXT,
  claimed_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO runtime.runtime_requests (id, kind, status, payload, created_at)
VALUES
  (
    '00000000-0000-4000-8000-000000000023',
    'create_branch_session',
    'pending',
    '{"agentKey":"panda"}'::jsonb,
    '2026-05-20T10:00:03Z'
  ),
  (
    '00000000-0000-4000-8000-000000000024',
    'live_voice_delegation',
    'pending',
    '{"liveVoiceTurnId":"00000000-0000-4000-8000-000000000021"}'::jsonb,
    '2026-05-20T10:00:04Z'
  ),
  (
    '00000000-0000-4000-8000-000000000025',
    'reset_session',
    'running',
    '{"source":"telegram","sessionId":"ci-legacy-session"}'::jsonb,
    '2026-05-20T10:00:05Z'
  );
