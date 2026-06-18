import {CREATE_RUNTIME_SCHEMA_SQL, quoteIdentifier} from "../../lib/postgres-relations.js";
import type {PgQueryable} from "../../lib/postgres-query.js";
import {buildModelCallTraceTableNames} from "./postgres-shared.js";

export async function ensurePostgresModelCallTraceSchema(pool: PgQueryable): Promise<void> {
  const tables = buildModelCallTraceTableNames();
  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.traces} (
      id UUID PRIMARY KEY,
      run_id UUID,
      thread_id TEXT,
      session_id TEXT,
      agent_key TEXT,
      turn INTEGER,
      call_index INTEGER,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('complete', 'stream')),
      status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
      started_at TIMESTAMPTZ NOT NULL,
      finished_at TIMESTAMPTZ NOT NULL,
      duration_ms BIGINT NOT NULL,
      prompt_cache_key TEXT,
      request_json JSONB NOT NULL,
      response_json JSONB,
      error_json JSONB,
      usage_json JSONB,
      expires_at TIMESTAMPTZ NOT NULL
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_model_call_traces_started_idx`)}
    ON ${tables.traces} (started_at DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_model_call_traces_expires_idx`)}
    ON ${tables.traces} (expires_at)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_model_call_traces_run_idx`)}
    ON ${tables.traces} (run_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_model_call_traces_session_started_idx`)}
    ON ${tables.traces} (session_id, started_at DESC)
  `);
}
