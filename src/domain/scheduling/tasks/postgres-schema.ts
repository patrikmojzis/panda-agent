import {CREATE_RUNTIME_SCHEMA_SQL, quoteIdentifier} from "../../../lib/postgres-relations.js";

import {addConstraint, assertIntegrityChecks} from "../../../lib/postgres-integrity.js";
import {buildIdentityTableNames} from "../../identity/postgres-shared.js";
import {buildSessionTableNames} from "../../sessions/postgres-shared.js";
import type {PgPoolLike} from "../../../lib/postgres-query.js";
import {
    buildThreadRuntimeTableNames} from "../../threads/runtime/postgres-shared.js";
import {buildScheduledTaskTableNames} from "./postgres-shared.js";

/** Ensures scheduled-task storage schema, migrations, and cross-table integrity constraints. */
export async function ensurePostgresScheduledTaskSchema(pool: PgPoolLike): Promise<void> {
  const tables = buildScheduledTaskTableNames();
  const identityTableName = buildIdentityTableNames().identities;
  const sessionTableName = buildSessionTableNames().sessions;
  const threadTables = buildThreadRuntimeTableNames();
  const threadTableName = threadTables.threads;
  const messageTableName = threadTables.messages;
  const runTableName = threadTables.runs;

  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.scheduledTasks} (
      id UUID PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES ${sessionTableName}(id) ON DELETE CASCADE,
      created_by_identity_id TEXT REFERENCES ${identityTableName}(id) ON DELETE SET NULL,
      created_from_message_id UUID,
      title TEXT NOT NULL,
      instruction TEXT NOT NULL,
      schedule_kind TEXT NOT NULL,
      run_at TIMESTAMPTZ,
      cron_expr TEXT,
      timezone TEXT,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      completed_at TIMESTAMPTZ,
      cancelled_at TIMESTAMPTZ,
      next_fire_at TIMESTAMPTZ,
      claimed_at TIMESTAMPTZ,
      claimed_by TEXT,
      claim_expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_scheduled_tasks_due_idx`)}
    ON ${tables.scheduledTasks} (enabled, cancelled_at, completed_at, next_fire_at, id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_scheduled_tasks_identity_agent_idx`)}
    ON ${tables.scheduledTasks} (session_id, created_at DESC)
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_scheduled_tasks_session_id_id_idx`)}
    ON ${tables.scheduledTasks} (session_id, id)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.scheduledTaskRuns} (
      id UUID PRIMARY KEY,
      task_id UUID NOT NULL REFERENCES ${tables.scheduledTasks}(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES ${sessionTableName}(id) ON DELETE CASCADE,
      created_by_identity_id TEXT REFERENCES ${identityTableName}(id) ON DELETE SET NULL,
      resolved_thread_id TEXT,
      resolved_thread_session_id TEXT,
      scheduled_for TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL,
      thread_run_id UUID,
      thread_run_thread_id TEXT,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ
    )
  `);
  // Runtime boot recreates readonly session views after store schemas.
  // CASCADE lets deployed DBs shed legacy columns even when old views depend on them.
  await pool.query(`
    ALTER TABLE ${tables.scheduledTasks}
    DROP COLUMN IF EXISTS deliver_at CASCADE,
    DROP COLUMN IF EXISTS next_fire_kind CASCADE
  `);
  await pool.query(`
    ALTER TABLE ${tables.scheduledTaskRuns}
    DROP COLUMN IF EXISTS fire_kind CASCADE,
    DROP COLUMN IF EXISTS delivery_status CASCADE
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_scheduled_task_runs_task_created_idx`)}
    ON ${tables.scheduledTaskRuns} (task_id, created_at DESC)
  `);
  await pool.query(`
    ALTER TABLE ${tables.scheduledTaskRuns}
    ADD COLUMN IF NOT EXISTS resolved_thread_session_id TEXT
  `);
  await pool.query(`
    ALTER TABLE ${tables.scheduledTaskRuns}
    ADD COLUMN IF NOT EXISTS thread_run_thread_id TEXT
  `);
  await pool.query(`
    ALTER TABLE ${tables.scheduledTasks}
    ADD COLUMN IF NOT EXISTS created_from_message_id UUID
  `);
  const threadRunTypeResult = await pool.query(`
    SELECT data_type
    FROM information_schema.columns
    WHERE table_schema = 'runtime'
      AND table_name = 'scheduled_task_runs'
      AND column_name = 'thread_run_id'
  `);
  const threadRunType = String((threadRunTypeResult.rows[0] as {data_type?: unknown} | undefined)?.data_type ?? "");
  if (threadRunType && threadRunType !== "uuid") {
    await assertIntegrityChecks(pool, "Scheduled task schema", [
      {
        label: "scheduled_task_runs.thread_run_id invalid UUID format",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM ${tables.scheduledTaskRuns}
          WHERE thread_run_id IS NOT NULL
            AND BTRIM(thread_run_id::text) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        `,
      },
    ]);
    await pool.query(`
      ALTER TABLE ${tables.scheduledTaskRuns}
      ALTER COLUMN thread_run_id TYPE UUID
      USING CASE
        WHEN thread_run_id IS NULL THEN NULL
        ELSE thread_run_id::uuid
      END
    `);
  }
  await assertIntegrityChecks(pool, "Scheduled task schema", [
    {
      label: "scheduled_tasks.created_from_message_id orphaned from messages.id",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.scheduledTasks} AS task
        LEFT JOIN ${messageTableName} AS message
          ON message.id = task.created_from_message_id
        WHERE task.created_from_message_id IS NOT NULL
          AND message.id IS NULL
      `,
    },
    {
      label: "scheduled_task_runs.task_id orphaned from scheduled_tasks.id",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.scheduledTaskRuns} AS run
        LEFT JOIN ${tables.scheduledTasks} AS task
          ON task.id = run.task_id
        WHERE task.id IS NULL
      `,
    },
    {
      label: "scheduled_task_runs task/session mismatch",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.scheduledTaskRuns} AS run
        INNER JOIN ${tables.scheduledTasks} AS task
          ON task.id = run.task_id
        WHERE task.session_id <> run.session_id
      `,
    },
    {
      label: "scheduled_task_runs.resolved_thread_id orphaned from threads.id",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.scheduledTaskRuns} AS run
        LEFT JOIN ${threadTableName} AS thread
          ON thread.id = run.resolved_thread_id
        WHERE run.resolved_thread_id IS NOT NULL
          AND thread.id IS NULL
      `,
    },
    {
      label: "scheduled_task_runs.resolved_thread_id bound to another session",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.scheduledTaskRuns} AS run
        INNER JOIN ${threadTableName} AS thread
          ON thread.id = run.resolved_thread_id
        WHERE run.resolved_thread_id IS NOT NULL
          AND thread.session_id <> run.session_id
      `,
    },
    {
      label: "scheduled_task_runs.thread_run_id orphaned from runs.id",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.scheduledTaskRuns} AS run
        LEFT JOIN ${runTableName} AS thread_run
          ON thread_run.id = run.thread_run_id
        WHERE run.thread_run_id IS NOT NULL
          AND thread_run.id IS NULL
      `,
    },
    {
      label: "scheduled_task_runs.thread_run_id set without resolved_thread_id",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.scheduledTaskRuns}
        WHERE thread_run_id IS NOT NULL
          AND resolved_thread_id IS NULL
      `,
    },
    {
      label: "scheduled_task_runs.thread_run_id bound to another thread",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.scheduledTaskRuns} AS run
        INNER JOIN ${runTableName} AS thread_run
          ON thread_run.id = run.thread_run_id
        WHERE run.thread_run_id IS NOT NULL
          AND thread_run.thread_id <> run.resolved_thread_id
      `,
    },
  ]);
  await pool.query(`
    UPDATE ${tables.scheduledTaskRuns}
    SET resolved_thread_session_id = NULL
    WHERE resolved_thread_id IS NULL
      AND resolved_thread_session_id IS NOT NULL
  `);
  await pool.query(`
    UPDATE ${tables.scheduledTaskRuns}
    SET resolved_thread_session_id = thread.session_id
    FROM ${threadTableName} AS thread
    WHERE ${tables.scheduledTaskRuns}.resolved_thread_id IS NOT NULL
      AND thread.id = ${tables.scheduledTaskRuns}.resolved_thread_id
      AND (
        ${tables.scheduledTaskRuns}.resolved_thread_session_id IS NULL
        OR ${tables.scheduledTaskRuns}.resolved_thread_session_id <> thread.session_id
      )
  `);
  await pool.query(`
    UPDATE ${tables.scheduledTaskRuns}
    SET thread_run_thread_id = NULL
    WHERE thread_run_id IS NULL
      AND thread_run_thread_id IS NOT NULL
  `);
  await pool.query(`
    UPDATE ${tables.scheduledTaskRuns}
    SET thread_run_thread_id = thread_run.thread_id
    FROM ${runTableName} AS thread_run
    WHERE ${tables.scheduledTaskRuns}.thread_run_id IS NOT NULL
      AND thread_run.id = ${tables.scheduledTaskRuns}.thread_run_id
      AND (
        ${tables.scheduledTaskRuns}.thread_run_thread_id IS NULL
        OR ${tables.scheduledTaskRuns}.thread_run_thread_id <> thread_run.thread_id
      )
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.scheduledTasks}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_scheduled_tasks_created_from_message_fk`)}
    FOREIGN KEY (created_from_message_id)
    REFERENCES ${messageTableName}(id)
    ON DELETE SET NULL
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.scheduledTaskRuns}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_scheduled_task_runs_task_scope_fk`)}
    FOREIGN KEY (session_id, task_id)
    REFERENCES ${tables.scheduledTasks}(session_id, id)
    ON DELETE CASCADE
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.scheduledTaskRuns}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_scheduled_task_runs_resolved_thread_fk`)}
    FOREIGN KEY (resolved_thread_id)
    REFERENCES ${threadTableName}(id)
    ON DELETE SET NULL
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.scheduledTaskRuns}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_scheduled_task_runs_thread_run_fk`)}
    FOREIGN KEY (thread_run_id)
    REFERENCES ${runTableName}(id)
    ON DELETE SET NULL
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.scheduledTaskRuns}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_scheduled_task_runs_resolved_thread_scope_check`)}
    CHECK (
      (
        resolved_thread_id IS NULL
        AND resolved_thread_session_id IS NULL
      ) OR (
        resolved_thread_id IS NOT NULL
        AND resolved_thread_session_id = session_id
      )
    )
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.scheduledTaskRuns}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_scheduled_task_runs_resolved_thread_scope_fk`)}
    FOREIGN KEY (resolved_thread_session_id, resolved_thread_id)
    REFERENCES ${threadTableName}(session_id, id)
    ON DELETE SET NULL
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.scheduledTaskRuns}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_scheduled_task_runs_thread_run_scope_check`)}
    CHECK (
      (
        thread_run_id IS NULL
        AND thread_run_thread_id IS NULL
      ) OR (
        thread_run_id IS NOT NULL
        AND thread_run_thread_id IS NOT NULL
        AND resolved_thread_id IS NOT NULL
        AND thread_run_thread_id = resolved_thread_id
      )
    )
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.scheduledTaskRuns}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_scheduled_task_runs_thread_run_scope_fk`)}
    FOREIGN KEY (thread_run_thread_id, thread_run_id)
    REFERENCES ${runTableName}(thread_id, id)
    ON DELETE SET NULL
  `);
}
