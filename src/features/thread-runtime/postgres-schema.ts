import { quoteIdentifier, type ThreadRuntimeTableNames } from "./postgres-shared.js";

export function buildThreadRuntimeSchemaSql(
  tables: ThreadRuntimeTableNames,
  identityTableName: string,
): string {
  return `
    CREATE TABLE IF NOT EXISTS ${tables.threads} (
      id TEXT PRIMARY KEY,
      identity_id TEXT NOT NULL REFERENCES ${identityTableName}(id) ON DELETE RESTRICT,
      agent_key TEXT NOT NULL,
      system_prompt JSONB,
      max_turns INTEGER,
      context JSONB,
      runtime_state JSONB,
      max_input_tokens INTEGER,
      prompt_cache_key TEXT,
      provider TEXT,
      model TEXT,
      temperature DOUBLE PRECISION,
      thinking TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE ${tables.threads}
    ADD COLUMN IF NOT EXISTS runtime_state JSONB;

    CREATE TABLE IF NOT EXISTS ${tables.messages} (
      id UUID PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES ${tables.threads}(id) ON DELETE CASCADE,
      sequence BIGSERIAL NOT NULL,
      origin TEXT NOT NULL,
      source TEXT NOT NULL,
      channel_id TEXT,
      external_message_id TEXT,
      actor_id TEXT,
      run_id UUID,
      created_at TIMESTAMPTZ NOT NULL,
      metadata JSONB,
      message JSONB NOT NULL
    );

    ALTER TABLE ${tables.messages}
    ADD COLUMN IF NOT EXISTS metadata JSONB;

    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_messages_thread_sequence_idx`)}
    ON ${tables.messages} (thread_id, sequence);

    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_threads_identity_updated_idx`)}
    ON ${tables.threads} (identity_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS ${tables.inputs} (
      id UUID PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES ${tables.threads}(id) ON DELETE CASCADE,
      input_order BIGSERIAL NOT NULL,
      delivery_mode TEXT NOT NULL DEFAULT 'wake',
      source TEXT NOT NULL,
      channel_id TEXT,
      external_message_id TEXT,
      actor_id TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      applied_at TIMESTAMPTZ,
      metadata JSONB,
      message JSONB NOT NULL
    );

    ALTER TABLE ${tables.inputs}
    ADD COLUMN IF NOT EXISTS metadata JSONB;

    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_inputs_thread_order_idx`)}
    ON ${tables.inputs} (thread_id, applied_at, input_order);

    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_inputs_external_message_idx`)}
    ON ${tables.inputs} (thread_id, source, COALESCE(channel_id, ''), external_message_id)
    WHERE external_message_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS ${tables.runs} (
      id UUID PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES ${tables.threads}(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL,
      finished_at TIMESTAMPTZ,
      abort_requested_at TIMESTAMPTZ,
      abort_reason TEXT,
      error TEXT
    );

    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_runs_thread_started_idx`)}
    ON ${tables.runs} (thread_id, started_at);
  `;
}
