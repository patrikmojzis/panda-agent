import {addConstraint, alterIfSupported, assertIntegrityChecks, type IntegrityCheckGroup} from "../../../lib/postgres-integrity.js";
import {buildIdentityTableNames} from "../../identity/postgres-shared.js";
import {buildSessionTableNames} from "../../sessions/postgres-shared.js";
import type {PgQueryable} from "../../../lib/postgres-query.js";
import {
  CREATE_RUNTIME_SCHEMA_SQL,
  postgresRelationExists,
  quoteIdentifier,
  quoteQualifiedIdentifier,
  RUNTIME_SCHEMA,
  SESSION_SCHEMA,
} from "../../../lib/postgres-relations.js";
import {buildThreadRuntimeTableNames, type ThreadRuntimeTableNames} from "./postgres-shared.js";
import {ensurePostgresRuntimeOperationReceiptSchema} from "../requests/postgres-operation-schema.js";

const REDACTED_SET_ENV_VALUE = "[redacted]";
const THREAD_RUNTIME_MIGRATIONS_TABLE =
  `${quoteIdentifier(RUNTIME_SCHEMA)}.${quoteIdentifier("thread_runtime_migrations")}`;
const SET_ENV_VALUE_ARGUMENT_REDACTION_MIGRATION =
  "set_env_value_tool_call_argument_redaction_2026_05_22";
const TYPED_COMPACTION_CHECKPOINT_MIGRATION =
  "typed_compaction_checkpoints_2026_08_24";
const LEGACY_THREAD_CONTEXT_COLUMN = "context";
const LEGACY_THREAD_SCALAR_COLUMNS = ["system_prompt", "max_turns", "temperature"] as const;

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

async function ensureThreadRuntimeMigrationTable(pool: PgQueryable): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${THREAD_RUNTIME_MIGRATIONS_TABLE} (
      migration_key TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function hasThreadRuntimeMigration(pool: PgQueryable, migrationKey: string): Promise<boolean> {
  const result = await pool.query(`
    SELECT 1
    FROM ${THREAD_RUNTIME_MIGRATIONS_TABLE}
    WHERE migration_key = $1
    LIMIT 1
  `, [migrationKey]);
  return result.rows.length > 0;
}

async function markThreadRuntimeMigration(pool: PgQueryable, migrationKey: string): Promise<void> {
  await pool.query(`
    INSERT INTO ${THREAD_RUNTIME_MIGRATIONS_TABLE} (migration_key)
    VALUES ($1)
    ON CONFLICT (migration_key) DO NOTHING
  `, [migrationKey]);
}

async function redactLegacySetEnvValueToolCallArguments(
  pool: PgQueryable,
  tables: ThreadRuntimeTableNames,
): Promise<void> {
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

async function migrateTypedCompactionCheckpoints(
  pool: PgQueryable,
  tables: ThreadRuntimeTableNames,
): Promise<void> {
  if (await hasThreadRuntimeMigration(pool, TYPED_COMPACTION_CHECKPOINT_MIGRATION)) {
    return;
  }

  await pool.query(`
    UPDATE ${tables.messages}
    SET compacted_through_sequence = (metadata ->> 'compactedUpToSequence')::BIGINT,
        metadata = metadata - 'compactedUpToSequence'
    WHERE source = 'compact'
      AND metadata ->> 'kind' = 'compact_boundary'
      AND metadata ->> 'compactedUpToSequence' IS NOT NULL
  `);
  await markThreadRuntimeMigration(pool, TYPED_COMPACTION_CHECKPOINT_MIGRATION);
}

// This predicate is shared by the database constraint and integrity audit so a
// row accepted as an indexed checkpoint is always recognizable by the kernel.
function buildValidCompactionCheckpointSql(): string {
  return `
    compacted_through_sequence IS NOT NULL
    AND compacted_through_sequence >= 0
    AND compacted_through_sequence < sequence
    AND origin = 'runtime'
    AND source = 'compact'
    AND COALESCE(metadata ->> 'kind', '') = 'compact_boundary'
    AND (metadata -> 'compactedThroughSequence') IS NULL
    AND (metadata -> 'compactedUpToSequence') IS NULL
    AND COALESCE(metadata ->> 'trigger', '') IN ('manual', 'auto')
    AND CASE
      WHEN (metadata -> 'preservedTailUserTurns')::text IS NULL THEN FALSE
      WHEN (metadata -> 'preservedTailUserTurns')::text LIKE '"%' THEN FALSE
      WHEN (metadata -> 'preservedTailUserTurns')::text IN ('true', 'false', 'null') THEN FALSE
      WHEN (metadata -> 'preservedTailUserTurns')::text LIKE '{%' THEN FALSE
      WHEN (metadata -> 'preservedTailUserTurns')::text LIKE '[%' THEN FALSE
      ELSE
        (metadata ->> 'preservedTailUserTurns')::numeric BETWEEN 0 AND 9007199254740991
        AND (metadata -> 'preservedTailUserTurns')::text NOT LIKE '%.%'
        AND LOWER((metadata -> 'preservedTailUserTurns')::text) NOT LIKE '%e%'
    END
  `;
}

async function ensureSingleRunningRunPerThread(
  pool: PgQueryable,
  tables: ThreadRuntimeTableNames,
): Promise<void> {
  await pool.query(`
    UPDATE ${tables.runs}
    SET status = 'failed',
        finished_at = COALESCE(finished_at, NOW()),
        error = COALESCE(error, 'Legacy running run had no durable daemon owner during run-claim migration.')
    WHERE status = 'running'
      AND (owner_source IS NULL OR owner_key IS NULL OR owner_holder_id IS NULL)
  `);
  const runningRuns = await pool.query(`
    SELECT id, thread_id
    FROM ${tables.runs}
    WHERE status = 'running'
    ORDER BY thread_id, started_at DESC, id DESC
  `);
  const retainedThreads = new Set<string>();
  const staleRunIds = runningRuns.rows.flatMap((row) => {
    if (!isJsonRecord(row) || typeof row.id !== "string" || typeof row.thread_id !== "string") {
      return [];
    }
    if (!retainedThreads.has(row.thread_id)) {
      retainedThreads.add(row.thread_id);
      return [];
    }
    return [row.id];
  });
  if (staleRunIds.length > 0) {
    await pool.query(`
      UPDATE ${tables.runs}
      SET status = 'failed',
          finished_at = COALESCE(finished_at, NOW()),
          error = COALESCE(error, 'Superseded duplicate running run repaired by the durable run-claim migration.')
      WHERE id = ANY($1::UUID[])
    `, [staleRunIds]);
  }
  const versionResult = await pool.query("SHOW server_version");
  const serverVersion = isJsonRecord(versionResult.rows[0])
    ? versionResult.rows[0].server_version
    : undefined;
  // pg-mem parses partial indexes but enforces them as full-table indexes.
  // Real PostgreSQL is the authority for this concurrency invariant.
  if (typeof serverVersion === "string" && serverVersion.includes("pg-mem")) {
    return;
  }
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_runs_one_running_per_thread_idx`)}
    ON ${tables.runs} (thread_id)
    WHERE status = 'running'
  `);
}

async function readExistingThreadColumns(
  pool: PgQueryable,
  columns: readonly string[],
): Promise<ReadonlySet<string>> {
  if (columns.length === 0) {
    return new Set();
  }

  const result = await pool.query(`
    SELECT table_schema, column_name
    FROM information_schema.columns
    WHERE table_name = $1
      AND table_schema IN ($2, 'public')
  `, ["threads", RUNTIME_SCHEMA]);
  const requestedColumns = new Set(columns);
  const rows = result.rows.flatMap((row) => {
    if (!isJsonRecord(row) || typeof row.table_schema !== "string" || typeof row.column_name !== "string") {
      return [];
    }

    return [{
      tableSchema: row.table_schema,
      columnName: row.column_name,
    }];
  });
  const runtimeRows = rows.filter((row) => row.tableSchema === RUNTIME_SCHEMA);
  // pg-mem exposes explicitly schema-qualified tables as public in information_schema.
  const candidateRows = runtimeRows.length > 0 ? runtimeRows : rows.filter((row) => row.tableSchema === "public");

  return new Set(candidateRows
    .map((row) => row.columnName)
    .filter((column) => requestedColumns.has(column)));
}

async function dropReadonlyThreadsViewForColumnCleanup(
  pool: PgQueryable,
  existingCleanupColumns: ReadonlySet<string>,
): Promise<void> {
  if (existingCleanupColumns.size === 0) {
    return;
  }

  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(SESSION_SCHEMA)}`);
  try {
    await pool.query(`DROP VIEW IF EXISTS ${quoteQualifiedIdentifier(SESSION_SCHEMA, "threads")}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("pg-mem") && message.includes("Unexpected word token")) {
      return;
    }

    throw error;
  }
}

async function ensureThreadsTable(
  pool: PgQueryable,
  tables: ThreadRuntimeTableNames,
): Promise<void> {
  if (await postgresRelationExists(pool, RUNTIME_SCHEMA, "threads")) {
    return;
  }

  await pool.query(`
    CREATE TABLE ${tables.threads} (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      replaces_thread_id TEXT,
      runtime_state JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function backfillWorkerMetadataFromLegacyThreadContext(
  pool: PgQueryable,
  tables: ThreadRuntimeTableNames,
  existingContextColumns: ReadonlySet<string>,
): Promise<void> {
  if (!existingContextColumns.has(LEGACY_THREAD_CONTEXT_COLUMN)) {
    return;
  }

  const sessionTables = buildSessionTableNames();
  await pool.query(`
    UPDATE ${sessionTables.sessions}
    SET metadata = jsonb_set(COALESCE(${sessionTables.sessions}.metadata, '{}'::jsonb), '{worker}', thread.context->'worker'),
        updated_at = NOW()
    FROM ${tables.threads} AS thread
    WHERE ${sessionTables.sessions}.kind = 'worker'
      AND ${sessionTables.sessions}.current_thread_id = thread.id
      AND thread.session_id = ${sessionTables.sessions}.id
      AND thread.context->'worker' IS NOT NULL
      AND (${sessionTables.sessions}.metadata IS NULL OR ${sessionTables.sessions}.metadata->'worker' IS NULL)
  `);
}

export async function migrateSessionRuntimeConfigFromThreadRows(
  pool: PgQueryable,
  tables: ThreadRuntimeTableNames,
): Promise<void> {
  const sessionTables = buildSessionTableNames();
  const movedColumns = [
    "model",
    "thinking",
    "pending_wake_at",
    "prompt_cache_key",
    "inference_projection",
  ] as const;
  const existingColumns = await readExistingThreadColumns(pool, movedColumns);

  if (existingColumns.has("prompt_cache_key")) {
    const customPromptCacheKeys = await pool.query(`
      SELECT id, prompt_cache_key
      FROM ${tables.threads}
      WHERE prompt_cache_key IS NOT NULL
        AND prompt_cache_key <> ('thread:' || id)
      LIMIT 1
    `);
    if (customPromptCacheKeys.rows.length > 0) {
      const row = customPromptCacheKeys.rows[0] as Record<string, unknown>;
      throw new Error(
        `Cannot drop runtime.threads.prompt_cache_key while custom key exists on thread ${String(row.id)}.`,
      );
    }
  }

  const hasModel = existingColumns.has("model");
  const hasThinking = existingColumns.has("thinking");
  const hasPendingWake = existingColumns.has("pending_wake_at");
  const hasInferenceProjection = existingColumns.has("inference_projection");
  if (hasModel || hasThinking || hasPendingWake || hasInferenceProjection) {
    const modelExpression = hasModel ? "CASE WHEN t.model = '' THEN NULL ELSE t.model END" : "NULL::text";
    const thinkingExpression = hasThinking
      ? "CASE WHEN t.thinking IS NOT NULL AND NOT (s.kind = 'worker' AND t.thinking = 'xhigh') THEN t.thinking ELSE NULL END"
      : "NULL::text";
    const thinkingConfiguredExpression = hasThinking
      ? "CASE WHEN t.thinking IS NOT NULL AND NOT (s.kind = 'worker' AND t.thinking = 'xhigh') THEN TRUE ELSE FALSE END"
      : "FALSE";
    const inferenceProjectionExpression = hasInferenceProjection ? "t.inference_projection" : "NULL::jsonb";
    const pendingWakeExpression = hasPendingWake ? "t.pending_wake_at" : "NULL::timestamptz";
    const predicates = [
      ...(hasModel ? ["t.model IS NOT NULL AND t.model <> ''"] : []),
      ...(hasThinking ? ["t.thinking IS NOT NULL AND NOT (s.kind = 'worker' AND t.thinking = 'xhigh')"] : []),
      ...(hasInferenceProjection ? ["t.inference_projection IS NOT NULL"] : []),
      ...(hasPendingWake ? ["t.pending_wake_at IS NOT NULL"] : []),
    ];

    await pool.query(`
      INSERT INTO ${sessionTables.sessionRuntimeConfig} AS config (
        session_id,
        model,
        thinking,
        thinking_configured,
        inference_projection,
        pending_wake_at,
        pending_wake_generation
      )
      SELECT
        s.id,
        ${modelExpression},
        ${thinkingExpression},
        ${thinkingConfiguredExpression},
        ${inferenceProjectionExpression},
        ${pendingWakeExpression},
        CASE WHEN ${pendingWakeExpression} IS NULL THEN 0 ELSE 1 END
      FROM ${sessionTables.sessions} AS s
      INNER JOIN ${tables.threads} AS t
        ON t.id = s.current_thread_id
       AND t.session_id = s.id
      WHERE ${predicates.length > 0 ? predicates.map((predicate) => `(${predicate})`).join(" OR ") : "FALSE"}
      ON CONFLICT (session_id) DO UPDATE
      SET model = COALESCE(config.model, EXCLUDED.model),
          thinking = CASE
            WHEN config.thinking_configured THEN config.thinking
            ELSE EXCLUDED.thinking
          END,
          thinking_configured = config.thinking_configured OR EXCLUDED.thinking_configured,
          inference_projection = COALESCE(config.inference_projection, EXCLUDED.inference_projection),
          pending_wake_at = COALESCE(config.pending_wake_at, EXCLUDED.pending_wake_at),
          pending_wake_generation = CASE
            WHEN config.pending_wake_at IS NULL AND EXCLUDED.pending_wake_at IS NOT NULL
              THEN config.pending_wake_generation + 1
            ELSE config.pending_wake_generation
          END,
          updated_at = NOW()
      WHERE (config.model IS NULL AND EXCLUDED.model IS NOT NULL)
         OR (NOT config.thinking_configured AND EXCLUDED.thinking_configured)
         OR (config.inference_projection IS NULL AND EXCLUDED.inference_projection IS NOT NULL)
         OR (config.pending_wake_at IS NULL AND EXCLUDED.pending_wake_at IS NOT NULL)
    `);
  }

  for (const column of movedColumns) {
    await pool.query(`ALTER TABLE ${tables.threads} DROP COLUMN IF EXISTS ${quoteIdentifier(column)}`);
  }
}

export function buildThreadRuntimeSchemaSql(
  tables: ThreadRuntimeTableNames,
  identityTableName: string,
): string {
  return `
    ${CREATE_RUNTIME_SCHEMA_SQL}

    ALTER TABLE ${tables.threads}
    ADD COLUMN IF NOT EXISTS runtime_state JSONB;

    ALTER TABLE ${tables.threads}
    ADD COLUMN IF NOT EXISTS replaces_thread_id TEXT;

    ALTER TABLE ${tables.threads}
    ADD COLUMN IF NOT EXISTS run_claims_blocked_at TIMESTAMPTZ;

    ALTER TABLE ${tables.threads}
    DROP COLUMN IF EXISTS max_input_tokens;

    ALTER TABLE ${tables.threads}
    DROP COLUMN IF EXISTS provider;

    ALTER TABLE ${tables.threads}
    DROP COLUMN IF EXISTS system_prompt;

    ALTER TABLE ${tables.threads}
    DROP COLUMN IF EXISTS max_turns;

    ALTER TABLE ${tables.threads}
    DROP COLUMN IF EXISTS temperature;

    ALTER TABLE ${tables.threads}
    DROP COLUMN IF EXISTS context;

    CREATE TABLE IF NOT EXISTS ${tables.messages} (
      id UUID PRIMARY KEY,
      input_id UUID,
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
    ADD COLUMN IF NOT EXISTS input_id UUID;

    ALTER TABLE ${tables.messages}
    ADD COLUMN IF NOT EXISTS run_thread_id TEXT;

    ALTER TABLE ${tables.messages}
    ADD COLUMN IF NOT EXISTS compacted_through_sequence BIGINT;

    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_messages_thread_sequence_idx`)}
    ON ${tables.messages} (thread_id, sequence);

    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_messages_compact_checkpoint_idx`)}
    ON ${tables.messages} (thread_id, sequence DESC)
    WHERE compacted_through_sequence IS NOT NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_messages_input_id_idx`)}
    ON ${tables.messages} (input_id)
    WHERE input_id IS NOT NULL;

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
      connector_key TEXT NOT NULL DEFAULT '',
      channel_id TEXT,
      external_message_id TEXT,
      actor_id TEXT,
      identity_id TEXT REFERENCES ${identityTableName}(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL,
      applied_at TIMESTAMPTZ,
      applied_run_id UUID,
      discarded_at TIMESTAMPTZ,
      metadata JSONB,
      message JSONB
    );

    ALTER TABLE ${tables.inputs}
    ADD COLUMN IF NOT EXISTS metadata JSONB;

    ALTER TABLE ${tables.inputs}
    ADD COLUMN IF NOT EXISTS connector_key TEXT;

    UPDATE ${tables.inputs}
    SET connector_key = COALESCE(metadata -> 'route' ->> 'connectorKey', '')
    WHERE connector_key IS NULL;

    ALTER TABLE ${tables.inputs}
    ALTER COLUMN connector_key SET DEFAULT '';

    ALTER TABLE ${tables.inputs}
    ALTER COLUMN connector_key SET NOT NULL;

    ALTER TABLE ${tables.inputs}
    ADD COLUMN IF NOT EXISTS applied_run_id UUID;

    ALTER TABLE ${tables.inputs}
    ADD COLUMN IF NOT EXISTS discarded_at TIMESTAMPTZ;

    ALTER TABLE ${tables.inputs}
    ALTER COLUMN message DROP NOT NULL;

    DROP INDEX IF EXISTS ${quoteQualifiedIdentifier(
      RUNTIME_SCHEMA,
      `${tables.prefix}_inputs_thread_order_idx`,
    )};

    DROP INDEX IF EXISTS ${quoteQualifiedIdentifier(
      RUNTIME_SCHEMA,
      `${tables.prefix}_inputs_pending_idx`,
    )};

    CREATE INDEX ${quoteIdentifier(`${tables.prefix}_inputs_pending_idx`)}
    ON ${tables.inputs} (thread_id, input_order)
    WHERE applied_at IS NULL AND discarded_at IS NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_inputs_thread_id_id_idx`)}
    ON ${tables.inputs} (thread_id, id);

    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_inputs_external_message_connector_key_idx`)}
    ON ${tables.inputs} (
      thread_id,
      source,
      connector_key,
      COALESCE(channel_id, ''),
      external_message_id
    )
    WHERE external_message_id IS NOT NULL;

    DROP INDEX IF EXISTS ${quoteQualifiedIdentifier(
      RUNTIME_SCHEMA,
      `${tables.prefix}_inputs_external_message_connector_idx`,
    )};

    DROP INDEX IF EXISTS ${quoteQualifiedIdentifier(
      RUNTIME_SCHEMA,
      `${tables.prefix}_inputs_external_message_idx`,
    )};

    CREATE TABLE IF NOT EXISTS ${tables.runs} (
      id UUID PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES ${tables.threads}(id) ON DELETE CASCADE,
      owner_source TEXT,
      owner_key TEXT,
      owner_holder_id TEXT,
      status TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL,
      finished_at TIMESTAMPTZ,
      abort_requested_at TIMESTAMPTZ,
      abort_reason TEXT,
      admitted_through_input_order BIGINT,
      error TEXT,
      error_summary TEXT
    );

    ALTER TABLE ${tables.runs}
    ADD COLUMN IF NOT EXISTS admitted_through_input_order BIGINT;

    ALTER TABLE ${tables.runs}
    ADD COLUMN IF NOT EXISTS error_summary TEXT;

    ALTER TABLE ${tables.runs}
    ADD COLUMN IF NOT EXISTS owner_source TEXT;

    ALTER TABLE ${tables.runs}
    ADD COLUMN IF NOT EXISTS owner_key TEXT;

    ALTER TABLE ${tables.runs}
    ADD COLUMN IF NOT EXISTS owner_holder_id TEXT;

    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_runs_thread_started_idx`)}
    ON ${tables.runs} (thread_id, started_at);

    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_runs_thread_id_id_idx`)}
    ON ${tables.runs} (thread_id, id);

    CREATE TABLE IF NOT EXISTS ${tables.abortOperations} (
      operation_id UUID PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES ${tables.threads}(id) ON DELETE CASCADE,
      run_id UUID,
      reason TEXT NOT NULL,
      blocks_new_runs BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      FOREIGN KEY (thread_id, run_id) REFERENCES ${tables.runs}(thread_id, id)
    );

    ALTER TABLE ${tables.abortOperations}
    ADD COLUMN IF NOT EXISTS blocks_new_runs BOOLEAN NOT NULL DEFAULT FALSE;

    CREATE TABLE IF NOT EXISTS ${tables.compactionNoopOperations} (
      operation_id UUID PRIMARY KEY,
      session_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      FOREIGN KEY (session_id, thread_id) REFERENCES ${tables.threads}(session_id, id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ${tables.toolJobs} (
      id UUID PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES ${tables.threads}(id) ON DELETE CASCADE,
      run_id UUID REFERENCES ${tables.runs}(id) ON DELETE SET NULL,
      run_thread_id TEXT,
      owner_source TEXT,
      owner_key TEXT,
      owner_holder_id TEXT,
      parent_tool_call_id TEXT,
      command_ordinal BIGINT,
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

    ALTER TABLE ${tables.toolJobs}
    ADD COLUMN IF NOT EXISTS owner_source TEXT;

    ALTER TABLE ${tables.toolJobs}
    ADD COLUMN IF NOT EXISTS owner_key TEXT;

    ALTER TABLE ${tables.toolJobs}
    ADD COLUMN IF NOT EXISTS owner_holder_id TEXT;

    ALTER TABLE ${tables.toolJobs}
    ADD COLUMN IF NOT EXISTS parent_tool_call_id TEXT;

    ALTER TABLE ${tables.toolJobs}
    ADD COLUMN IF NOT EXISTS command_ordinal BIGINT;

    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_tool_jobs_thread_started_idx`)}
    ON ${tables.toolJobs} (thread_id, started_at);

    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_tool_jobs_status_idx`)}
    ON ${tables.toolJobs} (status, started_at);

    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_tool_jobs_running_owner_idx`)}
    ON ${tables.toolJobs} (owner_source, owner_key, owner_holder_id, started_at)
    WHERE status = 'running';

    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_tool_jobs_parent_ordinal_idx`)}
    ON ${tables.toolJobs} (thread_id, run_id, parent_tool_call_id, command_ordinal)
    WHERE parent_tool_call_id IS NOT NULL;

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

    CREATE TABLE IF NOT EXISTS ${tables.shellStates} (
      session_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      execution_environment_id TEXT NOT NULL,
      cwd TEXT NOT NULL,
      env JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (session_id, thread_id, execution_environment_id),
      FOREIGN KEY (session_id, thread_id)
        REFERENCES ${tables.threads}(session_id, id)
        ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_shell_states_thread_idx`)}
    ON ${tables.shellStates} (session_id, thread_id);
  `;
}

export function buildThreadRuntimeIntegrityChecks(): IntegrityCheckGroup {
  const tables = buildThreadRuntimeTableNames();
  const sessionTableName = buildSessionTableNames().sessions;
  return {scope: "Thread runtime schema", checks: [
    {
      label: "threads.session_id orphaned from agent_sessions.id",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.threads} AS thread
        LEFT JOIN ${sessionTableName} AS session
          ON session.id = thread.session_id
        WHERE session.id IS NULL
      `,
    },
    {
      label: "threads.replaces_thread_id points outside its session",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.threads} AS thread
        LEFT JOIN ${tables.threads} AS replaced
          ON replaced.id = thread.replaces_thread_id
         AND replaced.session_id = thread.session_id
        WHERE thread.replaces_thread_id IS NOT NULL
          AND replaced.id IS NULL
      `,
    },
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
      label: "running thread runs missing durable daemon ownership",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.runs}
        WHERE status = 'running'
          AND (owner_source IS NULL OR owner_key IS NULL OR owner_holder_id IS NULL)
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
      label: "messages contain malformed compaction checkpoints",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.messages}
        WHERE (
          compacted_through_sequence IS NULL
          AND COALESCE(metadata ->> 'kind', '') = 'compact_boundary'
        ) OR (
          compacted_through_sequence IS NOT NULL
          AND NOT (${buildValidCompactionCheckpointSql()})
        )
      `,
    },
    {
      label: "inputs.applied_run_id orphaned from runs.id",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.inputs} AS input
        LEFT JOIN ${tables.runs} AS run
          ON run.id = input.applied_run_id
        WHERE input.applied_run_id IS NOT NULL
          AND run.id IS NULL
      `,
    },
    {
      label: "inputs.applied_run_id bound to a run from another thread",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.inputs} AS input
        INNER JOIN ${tables.runs} AS run
          ON run.id = input.applied_run_id
        WHERE run.thread_id <> input.thread_id
      `,
    },
    {
      label: "messages.input_id orphaned from inputs.id",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.messages} AS message
        LEFT JOIN ${tables.inputs} AS input
          ON input.id = message.input_id
        WHERE message.input_id IS NOT NULL
          AND input.id IS NULL
      `,
    },
    {
      label: "messages.input_id bound to an input from another thread",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.messages} AS message
        INNER JOIN ${tables.inputs} AS input
          ON input.id = message.input_id
        WHERE input.thread_id <> message.thread_id
      `,
    },
    {
      label: "applied input missing canonical message link",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.inputs} AS input
        LEFT JOIN ${tables.messages} AS message
          ON message.input_id = input.id
        WHERE input.applied_at IS NOT NULL
          AND message.id IS NULL
      `,
    },
    {
      label: "non-applied input has a canonical message link",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.inputs} AS input
        INNER JOIN ${tables.messages} AS message
          ON message.input_id = input.id
        WHERE input.applied_at IS NULL
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
      label: "running tool_jobs missing durable daemon owner",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.toolJobs}
        WHERE status = 'running'
          AND (
            owner_source IS NULL
            OR owner_key IS NULL
            OR owner_holder_id IS NULL
          )
      `,
    },
    {
      label: "tool_jobs have partial daemon owner",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.toolJobs}
        WHERE NOT (
          (owner_source IS NULL AND owner_key IS NULL AND owner_holder_id IS NULL)
          OR (owner_source IS NOT NULL AND owner_key IS NOT NULL AND owner_holder_id IS NOT NULL)
        )
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
  ]};
}

async function backfillLegacyAppliedInputMessageLinks(
  pool: PgQueryable,
  tables: ThreadRuntimeTableNames,
): Promise<boolean> {
  const appliedInput = await pool.query(`
    SELECT 1
    FROM ${tables.inputs}
    WHERE applied_at IS NOT NULL
    LIMIT 1
  `);
  if (appliedInput.rows.length === 0) {
    return false;
  }

  const matchesLegacyInput = (messageAlias: string, inputAlias: string): string => `
    ${messageAlias}.input_id IS NULL
    AND ${messageAlias}.origin = 'input'
    AND ${messageAlias}.thread_id = ${inputAlias}.thread_id
    AND ${messageAlias}.source = ${inputAlias}.source
    AND (${messageAlias}.channel_id = ${inputAlias}.channel_id
      OR (${messageAlias}.channel_id IS NULL AND ${inputAlias}.channel_id IS NULL))
    AND (${messageAlias}.external_message_id = ${inputAlias}.external_message_id
      OR (${messageAlias}.external_message_id IS NULL AND ${inputAlias}.external_message_id IS NULL))
    AND (${messageAlias}.actor_id = ${inputAlias}.actor_id
      OR (${messageAlias}.actor_id IS NULL AND ${inputAlias}.actor_id IS NULL))
    AND (${messageAlias}.identity_id = ${inputAlias}.identity_id
      OR (${messageAlias}.identity_id IS NULL AND ${inputAlias}.identity_id IS NULL))
    AND ${messageAlias}.created_at = ${inputAlias}.created_at
    AND (${messageAlias}.metadata = ${inputAlias}.metadata
      OR (${messageAlias}.metadata IS NULL AND ${inputAlias}.metadata IS NULL))
    AND ${messageAlias}.message = ${inputAlias}.message
  `;

  // Old Panda applied each input and inserted its transcript message in one
  // transaction, but stored no explicit link. Refuse to destroy the duplicate
  // payload unless that historical canonical row is uniquely identifiable.
  await assertIntegrityChecks(pool, "thread input lineage migration", [
    {
      label: "applied input has no unique canonical message",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.inputs} AS input
        WHERE input.applied_at IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM ${tables.messages} AS linked WHERE linked.input_id = input.id
          )
          AND (
            SELECT COUNT(*)
            FROM ${tables.messages} AS message
            WHERE ${matchesLegacyInput("message", "input")}
          ) <> 1
      `,
    },
    {
      label: "canonical message matches multiple applied inputs",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM (
          SELECT message.id
          FROM ${tables.messages} AS message
          INNER JOIN ${tables.inputs} AS input
            ON ${matchesLegacyInput("message", "input")}
          WHERE input.applied_at IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM ${tables.messages} AS linked WHERE linked.input_id = input.id
            )
          GROUP BY message.id
          HAVING COUNT(*) > 1
        ) AS ambiguous
      `,
    },
  ]);

  await pool.query(`
    UPDATE ${tables.messages} AS message
    SET input_id = input.id
    FROM ${tables.inputs} AS input
    WHERE input.applied_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM ${tables.messages} AS linked WHERE linked.input_id = input.id
      )
      AND ${matchesLegacyInput("message", "input")}
  `);

  await assertIntegrityChecks(pool, "thread input lineage migration", [{
    label: "applied input remains without canonical message link",
    sql: `
      SELECT COUNT(*)::INTEGER AS count
      FROM ${tables.inputs} AS input
      WHERE input.applied_at IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM ${tables.messages} AS message WHERE message.input_id = input.id
        )
    `,
  }]);
  return true;
}

async function backfillToolJobOwners(pool: PgQueryable, tables: ThreadRuntimeTableNames): Promise<void> {
  await pool.query(`
    UPDATE ${tables.toolJobs}
    SET owner_source = run.owner_source,
        owner_key = run.owner_key,
        owner_holder_id = run.owner_holder_id
    FROM ${tables.runs} AS run
    WHERE ${tables.toolJobs}.run_id = run.id
      AND ${tables.toolJobs}.thread_id = run.thread_id
      AND run.owner_source IS NOT NULL
      AND run.owner_key IS NOT NULL
      AND run.owner_holder_id IS NOT NULL
      AND (
        ${tables.toolJobs}.owner_source IS NULL
        OR ${tables.toolJobs}.owner_source <> run.owner_source
        OR ${tables.toolJobs}.owner_key IS NULL
        OR ${tables.toolJobs}.owner_key <> run.owner_key
        OR ${tables.toolJobs}.owner_holder_id IS NULL
        OR ${tables.toolJobs}.owner_holder_id <> run.owner_holder_id
      )
  `);
  // Old standalone rows never had a durable owner. They cannot safely be
  // adopted because their external process may still be running elsewhere.
  await pool.query(`
    UPDATE ${tables.toolJobs}
    SET status = 'lost',
        finished_at = COALESCE(finished_at, NOW()),
        duration_ms = COALESCE(duration_ms, 0),
        status_reason = COALESCE(
          status_reason,
          'Background job had no durable daemon owner during schema upgrade.'
        )
    WHERE status = 'running'
      AND (
        owner_source IS NULL
        OR owner_key IS NULL
        OR owner_holder_id IS NULL
      )
  `);
  await pool.query(`
    UPDATE ${tables.toolJobs}
    SET owner_source = NULL,
        owner_key = NULL,
        owner_holder_id = NULL
    WHERE status <> 'running'
      AND NOT (
        (owner_source IS NULL AND owner_key IS NULL AND owner_holder_id IS NULL)
        OR (owner_source IS NOT NULL AND owner_key IS NOT NULL AND owner_holder_id IS NOT NULL)
      )
  `);
}

/** Ensures thread runtime storage schema, migrations, and cross-table integrity constraints. */
export async function ensurePostgresThreadRuntimeSchema(pool: PgQueryable): Promise<void> {
  const tables = buildThreadRuntimeTableNames();
  const identityTableName = buildIdentityTableNames().identities;
  const sessionTableName = buildSessionTableNames().sessions;

  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await ensureThreadsTable(pool, tables);
  const existingLegacyScalarColumns = await readExistingThreadColumns(
    pool,
    LEGACY_THREAD_SCALAR_COLUMNS,
  );
  const existingContextColumns = await readExistingThreadColumns(pool, [LEGACY_THREAD_CONTEXT_COLUMN]);
  await dropReadonlyThreadsViewForColumnCleanup(
    pool,
    new Set([...existingLegacyScalarColumns, ...existingContextColumns]),
  );
  await backfillWorkerMetadataFromLegacyThreadContext(pool, tables, existingContextColumns);
  await pool.query(buildThreadRuntimeSchemaSql(tables, identityTableName));
  await ensureSingleRunningRunPerThread(pool, tables);
  await backfillToolJobOwners(pool, tables);
  const hasAppliedInputs = await backfillLegacyAppliedInputMessageLinks(pool, tables);
  // Applied inputs have a canonical transcript message. Keep only their small
  // idempotency/lineage tombstone instead of retaining a second payload copy.
  if (hasAppliedInputs) {
    await pool.query(`
      UPDATE ${tables.inputs}
      SET metadata = NULL,
          message = NULL
      WHERE applied_at IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM ${tables.messages} AS message WHERE message.input_id = ${tables.inputs}.id
        )
        AND (metadata IS NOT NULL OR message IS NOT NULL)
    `);
  }
  await migrateSessionRuntimeConfigFromThreadRows(pool, tables);
  await ensureThreadRuntimeMigrationTable(pool);
  await migrateTypedCompactionCheckpoints(pool, tables);
  await redactLegacySetEnvValueToolCallArguments(pool, tables);
  const integrity = buildThreadRuntimeIntegrityChecks();
  await assertIntegrityChecks(pool, integrity.scope, integrity.checks);
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
  await alterIfSupported(pool, `
    ALTER TABLE ${tables.threads}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_threads_session_fk`)}
    FOREIGN KEY (session_id)
    REFERENCES ${sessionTableName}(id)
    ON DELETE CASCADE
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.threads}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_threads_replacement_fk`)}
    FOREIGN KEY (session_id, replaces_thread_id)
    REFERENCES ${tables.threads}(session_id, id)
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.runs}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_runs_owner_shape_check`)}
    CHECK (
      (
        owner_source IS NULL
        AND owner_key IS NULL
        AND owner_holder_id IS NULL
      ) OR (
        owner_source IS NOT NULL
        AND owner_key IS NOT NULL
        AND owner_holder_id IS NOT NULL
      )
    )
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.runs}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_runs_running_owner_check`)}
    CHECK (
      status <> 'running'
      OR (
        owner_source IS NOT NULL
        AND owner_key IS NOT NULL
        AND owner_holder_id IS NOT NULL
      )
    )
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.runs}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_runs_admission_cutoff_check`)}
    CHECK (admitted_through_input_order IS NULL OR admitted_through_input_order > 0)
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.messages}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_messages_compact_checkpoint_check`)}
    CHECK (
      (
        compacted_through_sequence IS NULL
        AND COALESCE(metadata ->> 'kind', '') <> 'compact_boundary'
      ) OR (
        ${buildValidCompactionCheckpointSql()}
      )
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
    ALTER TABLE ${tables.inputs}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_inputs_lifecycle_check`)}
    CHECK (
      (
        applied_at IS NULL
        AND applied_run_id IS NULL
        AND discarded_at IS NULL
        AND message IS NOT NULL
      ) OR (
        applied_at IS NOT NULL
        AND discarded_at IS NULL
        AND message IS NULL
      ) OR (
        applied_at IS NULL
        AND applied_run_id IS NULL
        AND discarded_at IS NOT NULL
        AND message IS NULL
      )
    )
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.inputs}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_inputs_applied_run_scope_fk`)}
    FOREIGN KEY (thread_id, applied_run_id)
    REFERENCES ${tables.runs}(thread_id, id)
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.messages}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_messages_input_scope_fk`)}
    FOREIGN KEY (thread_id, input_id)
    REFERENCES ${tables.inputs}(thread_id, id)
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.messages}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_messages_input_origin_check`)}
    CHECK (input_id IS NULL OR origin = 'input')
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
    ALTER TABLE ${tables.toolJobs}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_tool_jobs_command_lineage_check`)}
    CHECK (
      (
        parent_tool_call_id IS NULL
        AND command_ordinal IS NULL
      ) OR (
        parent_tool_call_id IS NOT NULL
        AND command_ordinal IS NOT NULL
        AND command_ordinal > 0
        AND kind = 'command'
        AND run_id IS NOT NULL
      )
    )
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.toolJobs}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_tool_jobs_owner_shape_check`)}
    CHECK (
      (owner_source IS NULL AND owner_key IS NULL AND owner_holder_id IS NULL)
      OR (owner_source IS NOT NULL AND owner_key IS NOT NULL AND owner_holder_id IS NOT NULL)
    )
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.toolJobs}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_tool_jobs_running_owner_check`)}
    CHECK (status <> 'running' OR owner_source IS NOT NULL)
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
  await ensurePostgresRuntimeOperationReceiptSchema(pool);
}
