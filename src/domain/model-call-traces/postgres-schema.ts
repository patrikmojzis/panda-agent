import {CREATE_RUNTIME_SCHEMA_SQL, quoteIdentifier} from "../../lib/postgres-relations.js";
import type {PgQueryable} from "../../lib/postgres-query.js";
import {buildModelCallTraceTableNames} from "./postgres-shared.js";

export async function ensurePostgresModelCallTraceSchema(pool: PgQueryable): Promise<void> {
  const tables = buildModelCallTraceTableNames();
  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.attempts} (
      id UUID PRIMARY KEY,
      run_id UUID,
      thread_id TEXT,
      session_id TEXT,
      agent_key TEXT,
      turn INTEGER,
      attempt_ordinal INTEGER NOT NULL CHECK (attempt_ordinal >= 1),
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('complete', 'stream')),
      status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
      started_at TIMESTAMPTZ NOT NULL,
      finished_at TIMESTAMPTZ NOT NULL,
      duration_ms BIGINT NOT NULL,
      prompt_cache_key TEXT,
      usage_captured BOOLEAN NOT NULL DEFAULT FALSE,
      input_tokens BIGINT,
      output_tokens BIGINT,
      cache_read_tokens BIGINT,
      cache_write_tokens BIGINT,
      total_tokens BIGINT,
      input_cost DOUBLE PRECISION,
      output_cost DOUBLE PRECISION,
      cache_read_cost DOUBLE PRECISION,
      cache_write_cost DOUBLE PRECISION,
      total_cost DOUBLE PRECISION,
      error_category TEXT,
      error_message TEXT,
      error_provider TEXT,
      error_model TEXT,
      error_status INTEGER,
      error_retryable BOOLEAN,
      error_timed_out BOOLEAN,
      error_stop_reason TEXT,
      system_prompt_chars INTEGER NOT NULL,
      message_count INTEGER NOT NULL,
      tool_count INTEGER NOT NULL,
      context_section_count INTEGER NOT NULL,
      context_chars INTEGER NOT NULL,
      snapshot_status TEXT NOT NULL CHECK (snapshot_status IN ('not_captured', 'captured', 'truncated', 'dropped')),
      expires_at TIMESTAMPTZ NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.snapshots} (
      attempt_id UUID PRIMARY KEY REFERENCES ${tables.attempts}(id) ON DELETE CASCADE,
      request_json JSONB NOT NULL,
      response_json JSONB,
      snapshot_bytes BIGINT NOT NULL CHECK (snapshot_bytes >= 0),
      truncated BOOLEAN NOT NULL,
      redaction_version INTEGER NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_model_call_attempts_started_idx`)}
    ON ${tables.attempts} (started_at DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_model_call_attempts_expires_idx`)}
    ON ${tables.attempts} (expires_at)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_model_call_attempts_run_idx`)}
    ON ${tables.attempts} (run_id, started_at DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_model_call_attempts_session_started_idx`)}
    ON ${tables.attempts} (session_id, started_at DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_model_call_attempts_agent_started_idx`)}
    ON ${tables.attempts} (agent_key, started_at DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_model_call_attempts_failure_idx`)}
    ON ${tables.attempts} (provider, model, mode, error_category, started_at DESC)
    WHERE status = 'failed'
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_model_call_snapshots_expires_idx`)}
    ON ${tables.snapshots} (expires_at)
  `);

  // Trace payloads expire quickly. Carrying their legacy table forever would
  // create more operational and code complexity than preserving them is worth.
  await pool.query(`DROP TABLE IF EXISTS ${tables.legacyTraces}`);
}
