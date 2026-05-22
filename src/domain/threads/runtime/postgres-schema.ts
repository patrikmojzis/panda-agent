import {addConstraint, alterIfSupported, assertIntegrityChecks} from "../../../lib/postgres-integrity.js";
import {buildIdentityTableNames} from "../../identity/postgres-shared.js";
import {buildSessionTableNames} from "../../sessions/postgres-shared.js";
import type {PgPoolLike} from "../../../lib/postgres-query.js";
import {CREATE_RUNTIME_SCHEMA_SQL, quoteIdentifier, RUNTIME_SCHEMA} from "../../../lib/postgres-relations.js";
import {buildThreadRuntimeTableNames, type ThreadRuntimeTableNames} from "./postgres-shared.js";

const REDACTED_SET_ENV_VALUE = "[redacted]";
const THREAD_RUNTIME_MIGRATIONS_TABLE =
  `${quoteIdentifier(RUNTIME_SCHEMA)}.${quoteIdentifier("thread_runtime_migrations")}`;
const SET_ENV_VALUE_ARGUMENT_REDACTION_MIGRATION =
  "set_env_value_tool_call_argument_redaction_2026_05_22";

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactSetEnvValueToolCallsInMessage(message: unknown): {
  message: unknown;
  redacted: boolean;
} {
  if (!isJsonRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
    return {message, redacted: false};
  }

  let redacted = false;
  const content = message.content.map((block) => {
    if (!isJsonRecord(block) || block.type !== "toolCall" || block.name !== "set_env_value") {
      return block;
    }

    const args = block.arguments;
    if (
      !isJsonRecord(args)
      || !Object.prototype.hasOwnProperty.call(args, "value")
      || args.value === REDACTED_SET_ENV_VALUE
    ) {
      return block;
    }

    redacted = true;
    return {
      ...block,
      arguments: {
        ...args,
        value: REDACTED_SET_ENV_VALUE,
      },
    };
  });

  if (!redacted) {
    return {message, redacted: false};
  }

  return {
    message: {
      ...message,
      content,
    },
    redacted: true,
  };
}

async function ensureThreadRuntimeMigrationTable(pool: PgPoolLike): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${THREAD_RUNTIME_MIGRATIONS_TABLE} (
      migration_key TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function hasThreadRuntimeMigration(pool: PgPoolLike, migrationKey: string): Promise<boolean> {
  const result = await pool.query(`
    SELECT 1
    FROM ${THREAD_RUNTIME_MIGRATIONS_TABLE}
    WHERE migration_key = $1
    LIMIT 1
  `, [migrationKey]);
  return result.rows.length > 0;
}

async function markThreadRuntimeMigration(pool: PgPoolLike, migrationKey: string): Promise<void> {
  await pool.query(`
    INSERT INTO ${THREAD_RUNTIME_MIGRATIONS_TABLE} (migration_key)
    VALUES ($1)
    ON CONFLICT (migration_key) DO NOTHING
  `, [migrationKey]);
}

async function redactLegacySetEnvValueToolCallArguments(
  pool: PgPoolLike,
  tables: ThreadRuntimeTableNames,
): Promise<void> {
  await ensureThreadRuntimeMigrationTable(pool);

  if (await hasThreadRuntimeMigration(pool, SET_ENV_VALUE_ARGUMENT_REDACTION_MIGRATION)) {
    return;
  }

  const result = await pool.query(`
    SELECT id, message
    FROM ${tables.messages}
    WHERE message->>'role' = 'assistant'
      AND message->>'content' LIKE '%set_env_value%'
      AND message->>'content' LIKE '%value%'
  `);

  for (const row of result.rows) {
    if (!isJsonRecord(row) || typeof row.id !== "string") {
      continue;
    }

    const redacted = redactSetEnvValueToolCallsInMessage(row.message);
    if (!redacted.redacted) {
      continue;
    }

    await pool.query(`
      UPDATE ${tables.messages}
      SET message = $2::jsonb
      WHERE id = $1
    `, [
      row.id,
      JSON.stringify(redacted.message),
    ]);
  }

  await markThreadRuntimeMigration(pool, SET_ENV_VALUE_ARGUMENT_REDACTION_MIGRATION);
}

export function buildThreadRuntimeSchemaSql(
  tables: ThreadRuntimeTableNames,
  sessionTableName: string,
  identityTableName: string,
): string {
  return `
    ${CREATE_RUNTIME_SCHEMA_SQL}

    CREATE TABLE IF NOT EXISTS ${tables.threads} (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES ${sessionTableName}(id) ON DELETE CASCADE,
      system_prompt JSONB,
      max_turns INTEGER,
      context JSONB,
      runtime_state JSONB,
      inference_projection JSONB,
      prompt_cache_key TEXT,
      model TEXT,
      temperature DOUBLE PRECISION,
      thinking TEXT,
      pending_wake_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE ${tables.threads}
    ADD COLUMN IF NOT EXISTS runtime_state JSONB;

    ALTER TABLE ${tables.threads}
    ADD COLUMN IF NOT EXISTS inference_projection JSONB;

    ALTER TABLE ${tables.threads}
    ADD COLUMN IF NOT EXISTS pending_wake_at TIMESTAMPTZ;

    ALTER TABLE ${tables.threads}
    DROP COLUMN IF EXISTS max_input_tokens;

    ALTER TABLE ${tables.threads}
    DROP COLUMN IF EXISTS provider;

    CREATE TABLE IF NOT EXISTS ${tables.messages} (
      id UUID PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES ${tables.threads}(id) ON DELETE CASCADE,
      sequence BIGSERIAL NOT NULL,
      origin TEXT NOT NULL,
      source TEXT NOT NULL,
      channel_id TEXT,
      external_message_id TEXT,
      actor_id TEXT,
      identity_id TEXT REFERENCES ${identityTableName}(id) ON DELETE SET NULL,
      run_id UUID,
      run_thread_id TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      metadata JSONB,
      message JSONB NOT NULL
    );

    ALTER TABLE ${tables.messages}
    ADD COLUMN IF NOT EXISTS metadata JSONB;

    ALTER TABLE ${tables.messages}
    ADD COLUMN IF NOT EXISTS run_thread_id TEXT;

    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_messages_thread_sequence_idx`)}
    ON ${tables.messages} (thread_id, sequence);

    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_threads_session_updated_idx`)}
    ON ${tables.threads} (session_id, updated_at DESC);

    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_threads_session_id_id_idx`)}
    ON ${tables.threads} (session_id, id);

    CREATE TABLE IF NOT EXISTS ${tables.inputs} (
      id UUID PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES ${tables.threads}(id) ON DELETE CASCADE,
      input_order BIGSERIAL NOT NULL,
      delivery_mode TEXT NOT NULL DEFAULT 'wake',
      source TEXT NOT NULL,
      channel_id TEXT,
      external_message_id TEXT,
      actor_id TEXT,
      identity_id TEXT REFERENCES ${identityTableName}(id) ON DELETE SET NULL,
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

    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_runs_thread_id_id_idx`)}
    ON ${tables.runs} (thread_id, id);

    CREATE TABLE IF NOT EXISTS ${tables.toolJobs} (
      id UUID PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES ${tables.threads}(id) ON DELETE CASCADE,
      run_id UUID REFERENCES ${tables.runs}(id) ON DELETE SET NULL,
      run_thread_id TEXT,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      started_at TIMESTAMPTZ NOT NULL,
      finished_at TIMESTAMPTZ,
      duration_ms BIGINT,
      result JSONB,
      error TEXT,
      status_reason TEXT,
      progress JSONB
    );

    ALTER TABLE ${tables.toolJobs}
    ADD COLUMN IF NOT EXISTS run_thread_id TEXT;

    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_tool_jobs_thread_started_idx`)}
    ON ${tables.toolJobs} (thread_id, started_at);

    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_tool_jobs_status_idx`)}
    ON ${tables.toolJobs} (status, started_at);

    CREATE TABLE IF NOT EXISTS ${tables.bashJobs} (
      id UUID PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES ${tables.threads}(id) ON DELETE CASCADE,
      run_id UUID REFERENCES ${tables.runs}(id) ON DELETE SET NULL,
      run_thread_id TEXT,
      status TEXT NOT NULL,
      command TEXT NOT NULL,
      mode TEXT NOT NULL,
      initial_cwd TEXT NOT NULL,
      final_cwd TEXT,
      started_at TIMESTAMPTZ NOT NULL,
      finished_at TIMESTAMPTZ,
      duration_ms BIGINT,
      exit_code INTEGER,
      signal TEXT,
      timed_out BOOLEAN NOT NULL DEFAULT FALSE,
      stdout TEXT NOT NULL DEFAULT '',
      stderr TEXT NOT NULL DEFAULT '',
      stdout_chars BIGINT NOT NULL DEFAULT 0,
      stderr_chars BIGINT NOT NULL DEFAULT 0,
      stdout_truncated BOOLEAN NOT NULL DEFAULT FALSE,
      stderr_truncated BOOLEAN NOT NULL DEFAULT FALSE,
      stdout_persisted BOOLEAN NOT NULL DEFAULT FALSE,
      stderr_persisted BOOLEAN NOT NULL DEFAULT FALSE,
      stdout_path TEXT,
      stderr_path TEXT,
      tracked_env_keys JSONB NOT NULL DEFAULT '[]'::jsonb,
      status_reason TEXT
    );

    ALTER TABLE ${tables.bashJobs}
    ADD COLUMN IF NOT EXISTS run_thread_id TEXT;

    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_bash_jobs_thread_started_idx`)}
    ON ${tables.bashJobs} (thread_id, started_at);

    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_bash_jobs_status_idx`)}
    ON ${tables.bashJobs} (status, started_at);
  `;
}

/** Ensures thread runtime storage schema, migrations, and cross-table integrity constraints. */
export async function ensurePostgresThreadRuntimeSchema(pool: PgPoolLike): Promise<void> {
  const tables = buildThreadRuntimeTableNames();
  const identityTableName = buildIdentityTableNames().identities;
  const sessionTableName = buildSessionTableNames().sessions;

  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await pool.query(buildThreadRuntimeSchemaSql(tables, sessionTableName, identityTableName));
  await redactLegacySetEnvValueToolCallArguments(pool, tables);
  await assertIntegrityChecks(pool, "Thread runtime schema", [
    {
      label: "agent_sessions.current_thread_id orphaned from threads.id",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${sessionTableName} AS session
        LEFT JOIN ${tables.threads} AS thread
          ON thread.id = session.current_thread_id
        WHERE thread.id IS NULL
      `,
    },
    {
      label: "agent_sessions.current_thread_id bound to a thread from another session",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${sessionTableName} AS session
        INNER JOIN ${tables.threads} AS thread
          ON thread.id = session.current_thread_id
        WHERE thread.session_id <> session.id
      `,
    },
    {
      label: "messages.run_id orphaned from runs.id",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.messages} AS message
        LEFT JOIN ${tables.runs} AS run
          ON run.id = message.run_id
        WHERE message.run_id IS NOT NULL
          AND run.id IS NULL
      `,
    },
    {
      label: "messages.run_id bound to a run from another thread",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.messages} AS message
        INNER JOIN ${tables.runs} AS run
          ON run.id = message.run_id
        WHERE message.run_id IS NOT NULL
          AND run.thread_id <> message.thread_id
      `,
    },
    {
      label: "tool_jobs.run_id bound to a run from another thread",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.toolJobs} AS job
        INNER JOIN ${tables.runs} AS run
          ON run.id = job.run_id
        WHERE job.run_id IS NOT NULL
          AND run.thread_id <> job.thread_id
      `,
    },
    {
      label: "bash_jobs.run_id bound to a run from another thread",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.bashJobs} AS job
        INNER JOIN ${tables.runs} AS run
          ON run.id = job.run_id
        WHERE job.run_id IS NOT NULL
          AND run.thread_id <> job.thread_id
      `,
    },
  ]);
  await pool.query(`
    UPDATE ${tables.messages}
    SET run_thread_id = NULL
    WHERE run_id IS NULL
      AND run_thread_id IS NOT NULL
  `);
  await pool.query(`
    UPDATE ${tables.messages}
    SET run_thread_id = run.thread_id
    FROM ${tables.runs} AS run
    WHERE ${tables.messages}.run_id IS NOT NULL
      AND run.id = ${tables.messages}.run_id
      AND (
        ${tables.messages}.run_thread_id IS NULL
        OR ${tables.messages}.run_thread_id <> run.thread_id
      )
  `);
  await pool.query(`
    UPDATE ${tables.toolJobs}
    SET run_thread_id = NULL
    WHERE run_id IS NULL
      AND run_thread_id IS NOT NULL
  `);
  await pool.query(`
    UPDATE ${tables.toolJobs}
    SET run_thread_id = run.thread_id
    FROM ${tables.runs} AS run
    WHERE ${tables.toolJobs}.run_id IS NOT NULL
      AND run.id = ${tables.toolJobs}.run_id
      AND (
        ${tables.toolJobs}.run_thread_id IS NULL
        OR ${tables.toolJobs}.run_thread_id <> run.thread_id
      )
  `);
  await pool.query(`
    UPDATE ${tables.bashJobs}
    SET run_thread_id = NULL
    WHERE run_id IS NULL
      AND run_thread_id IS NOT NULL
  `);
  await pool.query(`
    UPDATE ${tables.bashJobs}
    SET run_thread_id = run.thread_id
    FROM ${tables.runs} AS run
    WHERE ${tables.bashJobs}.run_id IS NOT NULL
      AND run.id = ${tables.bashJobs}.run_id
      AND (
        ${tables.bashJobs}.run_thread_id IS NULL
        OR ${tables.bashJobs}.run_thread_id <> run.thread_id
      )
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.messages}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_messages_run_fk`)}
    FOREIGN KEY (run_id)
    REFERENCES ${tables.runs}(id)
    ON DELETE SET NULL
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.messages}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_messages_run_scope_check`)}
    CHECK (
      (
        run_id IS NULL
        AND run_thread_id IS NULL
      ) OR (
        run_id IS NOT NULL
        AND run_thread_id = thread_id
      )
    )
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.messages}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_messages_run_scope_fk`)}
    FOREIGN KEY (run_thread_id, run_id)
    REFERENCES ${tables.runs}(thread_id, id)
    ON DELETE SET NULL
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.toolJobs}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_tool_jobs_run_scope_check`)}
    CHECK (
      (
        run_id IS NULL
        AND run_thread_id IS NULL
      ) OR (
        run_id IS NOT NULL
        AND run_thread_id = thread_id
      )
    )
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.toolJobs}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_tool_jobs_run_scope_fk`)}
    FOREIGN KEY (run_thread_id, run_id)
    REFERENCES ${tables.runs}(thread_id, id)
    ON DELETE SET NULL
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.bashJobs}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_bash_jobs_run_scope_check`)}
    CHECK (
      (
        run_id IS NULL
        AND run_thread_id IS NULL
      ) OR (
        run_id IS NOT NULL
        AND run_thread_id = thread_id
      )
    )
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.bashJobs}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_bash_jobs_run_scope_fk`)}
    FOREIGN KEY (run_thread_id, run_id)
    REFERENCES ${tables.runs}(thread_id, id)
    ON DELETE SET NULL
  `);
  await alterIfSupported(pool, `
    ALTER TABLE ${sessionTableName}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_agent_sessions_current_thread_fk`)}
    FOREIGN KEY (id, current_thread_id)
    REFERENCES ${tables.threads}(session_id, id)
    DEFERRABLE INITIALLY DEFERRED
  `);
}
