import {CREATE_RUNTIME_SCHEMA_SQL, quoteIdentifier} from "../../../lib/postgres-relations.js";

import {addConstraint, assertIntegrityChecks, type IntegrityCheckGroup} from "../../../lib/postgres-integrity.js";
import {buildIdentityTableNames} from "../../identity/postgres-shared.js";
import {buildSessionTableNames} from "../../sessions/postgres-shared.js";
import type {PgQueryable} from "../../../lib/postgres-query.js";
import {buildThreadRuntimeTableNames} from "../../threads/runtime/postgres-shared.js";
import {buildScheduledTaskTableNames} from "./postgres-shared.js";

export function buildScheduledTaskIntegrityChecks(): IntegrityCheckGroup {
  const tables = buildScheduledTaskTableNames();
  const threadTables = buildThreadRuntimeTableNames();
  return {scope: "Scheduled task schema", checks: [
    {
      label: "scheduled_tasks.created_from_message_id orphaned from messages.id",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.scheduledTasks} AS task
        LEFT JOIN ${threadTables.messages} AS message
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
      label: "scheduled_task_runs tasks with multiple active occurrences",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.scheduledTaskRuns} AS candidate
        INNER JOIN ${tables.scheduledTaskRuns} AS duplicate
          ON duplicate.task_id = candidate.task_id
         AND duplicate.id <> candidate.id
        WHERE candidate.status IN ('pending', 'claimed', 'running')
          AND duplicate.status IN ('pending', 'claimed', 'running')
      `,
    },
    {
      label: "scheduled_tasks next_fire_at repeats an existing occurrence",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.scheduledTasks} AS task
        INNER JOIN ${tables.scheduledTaskRuns} AS run
          ON run.task_id = task.id
         AND run.scheduled_for = task.next_fire_at
        WHERE task.enabled = TRUE
          AND task.completed_at IS NULL
          AND task.cancelled_at IS NULL
          AND task.next_fire_at IS NOT NULL
      `,
    },
    {
      label: "scheduled_task_runs.resolved_thread_id orphaned from threads.id",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.scheduledTaskRuns} AS run
        LEFT JOIN ${threadTables.threads} AS thread
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
        INNER JOIN ${threadTables.threads} AS thread
          ON thread.id = run.resolved_thread_id
        WHERE run.resolved_thread_id IS NOT NULL
          AND thread.session_id <> run.session_id
      `,
    },
    {
      label: "scheduled_task_runs.thread_input_id orphaned from inputs.id",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.scheduledTaskRuns} AS run
        LEFT JOIN ${threadTables.inputs} AS thread_input
          ON thread_input.id = run.thread_input_id
        WHERE run.thread_input_id IS NOT NULL
          AND thread_input.id IS NULL
      `,
    },
    {
      label: "scheduled_task_runs.thread_input_id set without resolved_thread_id",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.scheduledTaskRuns}
        WHERE thread_input_id IS NOT NULL
          AND resolved_thread_id IS NULL
      `,
    },
    {
      label: "scheduled_task_runs.thread_input_id differs from occurrence id",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.scheduledTaskRuns}
        WHERE thread_input_id IS NOT NULL
          AND thread_input_id <> id
      `,
    },
    {
      label: "scheduled_task_runs.thread_input_id bound to another thread",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.scheduledTaskRuns} AS run
        INNER JOIN ${threadTables.inputs} AS thread_input
          ON thread_input.id = run.thread_input_id
        WHERE run.thread_input_id IS NOT NULL
          AND thread_input.thread_id <> run.resolved_thread_id
      `,
    },
    {
      label: "scheduled_task_runs.thread_input_id lacks its scheduled-task fingerprint",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.scheduledTaskRuns} AS run
        INNER JOIN ${threadTables.inputs} AS thread_input
          ON thread_input.id = run.thread_input_id
        WHERE run.thread_input_id IS NOT NULL
          AND (
            thread_input.source <> 'scheduled_task'
            OR COALESCE(thread_input.external_message_id, '') <> run.id::text
          )
      `,
    },
    {
      label: "scheduled_task_runs.thread_run_id orphaned from runs.id",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.scheduledTaskRuns} AS run
        LEFT JOIN ${threadTables.runs} AS thread_run
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
        INNER JOIN ${threadTables.runs} AS thread_run
          ON thread_run.id = run.thread_run_id
        WHERE run.thread_run_id IS NOT NULL
          AND thread_run.thread_id <> run.resolved_thread_id
      `,
    },
  ]};
}

/** Ensures scheduled-task storage schema, migrations, and cross-table integrity constraints. */
export async function ensurePostgresScheduledTaskSchema(pool: PgQueryable): Promise<void> {
  const tables = buildScheduledTaskTableNames();
  const identityTableName = buildIdentityTableNames().identities;
  const sessionTableName = buildSessionTableNames().sessions;
  const threadTables = buildThreadRuntimeTableNames();
  const threadTableName = threadTables.threads;
  const inputTableName = threadTables.inputs;
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
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_scheduled_tasks_session_fire_idx`)}
    ON ${tables.scheduledTasks} (session_id, next_fire_at ASC, created_at DESC, id ASC)
    WHERE enabled = TRUE
      AND completed_at IS NULL
      AND cancelled_at IS NULL
      AND next_fire_at IS NOT NULL
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_scheduled_tasks_session_id_id_idx`)}
    ON ${tables.scheduledTasks} (session_id, id)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.scheduledTaskRuns} (
      id UUID PRIMARY KEY,
      task_id UUID NOT NULL,
      session_id TEXT NOT NULL,
      created_by_identity_id TEXT REFERENCES ${identityTableName}(id) ON DELETE SET NULL,
      resolved_thread_id TEXT,
      resolved_thread_session_id TEXT,
      scheduled_for TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL,
      thread_input_id UUID,
      thread_input_thread_id TEXT,
      thread_run_id UUID,
      thread_run_thread_id TEXT,
      claim_token UUID,
      claimed_at TIMESTAMPTZ,
      claimed_by TEXT,
      claim_expires_at TIMESTAMPTZ,
      lineage_recorded_at TIMESTAMPTZ,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ
    )
  `);
  // The baseline migration recreates readonly session views after concrete
  // tables. CASCADE lets it shed legacy columns even when old views depend on
  // them; normal runtime boot never executes this mutation path.
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
    DROP INDEX IF EXISTS ${quoteIdentifier(tables.prefix)}.${quoteIdentifier(`${tables.prefix}_scheduled_task_runs_task_created_idx`)}
  `);
  await pool.query(`
    CREATE INDEX ${quoteIdentifier(`${tables.prefix}_scheduled_task_runs_task_created_idx`)}
    ON ${tables.scheduledTaskRuns} (session_id, task_id, created_at DESC, id ASC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_scheduled_task_runs_session_created_idx`)}
    ON ${tables.scheduledTaskRuns} (session_id, created_at DESC, id ASC)
  `);
  await assertIntegrityChecks(pool, "Scheduled task schema", [{
    label: "duplicate scheduled_task_runs (task_id, scheduled_for) occurrences",
    sql: `
      SELECT COUNT(*)::INTEGER AS count
      FROM ${tables.scheduledTaskRuns} AS candidate
      INNER JOIN ${tables.scheduledTaskRuns} AS duplicate
        ON duplicate.task_id = candidate.task_id
       AND duplicate.scheduled_for = candidate.scheduled_for
       AND duplicate.id <> candidate.id
    `,
  }]);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_scheduled_task_runs_task_fire_idx`)}
    ON ${tables.scheduledTaskRuns} (task_id, scheduled_for)
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
    ALTER TABLE ${tables.scheduledTaskRuns}
    ADD COLUMN IF NOT EXISTS thread_input_id UUID,
    ADD COLUMN IF NOT EXISTS thread_input_thread_id TEXT,
    ADD COLUMN IF NOT EXISTS claim_token UUID,
    ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS claimed_by TEXT,
    ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS lineage_recorded_at TIMESTAMPTZ
  `);
  const legacyTaskClaimColumns = await pool.query(`
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'runtime'
      AND table_name = 'scheduled_tasks'
      AND column_name = 'claimed_at'
    LIMIT 1
  `);
  // The old claim lived on the task definition, so its claimed run has no
  // occurrence token. Demote only while that legacy column still identifies
  // the one-time migration; new occurrence-owned `claimed` rows must survive boot.
  if (legacyTaskClaimColumns.rows.length > 0) {
    await pool.query(`
      UPDATE ${tables.scheduledTaskRuns}
      SET status = 'pending'
      WHERE status = 'claimed'
    `);
  }
  // Already-running legacy work cannot identify the input/run it owns. Close
  // it explicitly instead of guessing from thread history.
  await pool.query(`
    UPDATE ${tables.scheduledTaskRuns}
    SET status = 'failed',
        error = COALESCE(error, 'Interrupted during the scheduled input-lineage migration.'),
        finished_at = COALESCE(finished_at, NOW())
    WHERE status = 'running'
      AND thread_input_id IS NULL
  `);
  // Historical successful rows predate mandatory input lineage, and the old
  // completion API even allowed no thread-run id. Mark that one-time legacy
  // boundary explicitly; new rows set this only while linking their exact input.
  await pool.query(`
    UPDATE ${tables.scheduledTaskRuns}
    SET lineage_recorded_at = COALESCE(started_at, finished_at, created_at)
    WHERE status = 'succeeded'
      AND lineage_recorded_at IS NULL
  `);
  await pool.query(`
    UPDATE ${tables.scheduledTasks}
    SET next_fire_at = NULL,
        updated_at = NOW()
    WHERE schedule_kind = 'once'
      AND next_fire_at IS NOT NULL
      AND id IN (
        SELECT run.task_id
        FROM ${tables.scheduledTaskRuns} AS run
        WHERE run.status IN ('pending', 'claimed', 'running')
      )
  `);
  await pool.query(`
    UPDATE ${tables.scheduledTasks}
    SET completed_at = COALESCE(completed_at, NOW()),
        next_fire_at = NULL,
        updated_at = NOW()
    WHERE schedule_kind = 'once'
      AND completed_at IS NULL
      AND id IN (
        SELECT run.task_id
        FROM ${tables.scheduledTaskRuns} AS run
        WHERE run.status = 'failed'
          AND run.error = 'Interrupted during the scheduled input-lineage migration.'
      )
  `);
  await pool.query(`
    ALTER TABLE ${tables.scheduledTasks}
    DROP COLUMN IF EXISTS claimed_at CASCADE,
    DROP COLUMN IF EXISTS claimed_by CASCADE,
    DROP COLUMN IF EXISTS claim_expires_at CASCADE
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_scheduled_task_runs_claimable_idx`)}
    ON ${tables.scheduledTaskRuns} (status, claim_expires_at, scheduled_for, id)
    WHERE status IN ('pending', 'claimed', 'running')
  `);
  await assertIntegrityChecks(pool, "Scheduled task schema", [{
    label: "scheduled_task_runs tasks with multiple active occurrences",
    sql: `
      SELECT COUNT(*)::INTEGER AS count
      FROM ${tables.scheduledTaskRuns} AS candidate
      INNER JOIN ${tables.scheduledTaskRuns} AS duplicate
        ON duplicate.task_id = candidate.task_id
       AND duplicate.id <> candidate.id
      WHERE candidate.status IN ('pending', 'claimed', 'running')
        AND duplicate.status IN ('pending', 'claimed', 'running')
    `,
  }]);
  await pool.query(`
    DROP INDEX IF EXISTS ${quoteIdentifier(tables.prefix)}.${quoteIdentifier(`${tables.prefix}_scheduled_task_runs_active_task_idx`)}
  `);
  await pool.query(`
    CREATE UNIQUE INDEX ${quoteIdentifier(`${tables.prefix}_scheduled_task_runs_active_task_idx`)}
    ON ${tables.scheduledTaskRuns} (task_id)
    WHERE status IN ('pending', 'claimed', 'running')
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
  const integrity = buildScheduledTaskIntegrityChecks();
  await assertIntegrityChecks(pool, integrity.scope, integrity.checks);
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
    SET thread_input_thread_id = NULL
    WHERE thread_input_id IS NULL
      AND thread_input_thread_id IS NOT NULL
  `);
  await pool.query(`
    UPDATE ${tables.scheduledTaskRuns}
    SET thread_input_thread_id = thread_input.thread_id
    FROM ${inputTableName} AS thread_input
    WHERE ${tables.scheduledTaskRuns}.thread_input_id IS NOT NULL
      AND thread_input.id = ${tables.scheduledTaskRuns}.thread_input_id
      AND (
        ${tables.scheduledTaskRuns}.thread_input_thread_id IS NULL
        OR ${tables.scheduledTaskRuns}.thread_input_thread_id <> thread_input.thread_id
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
    ALTER TABLE ${tables.scheduledTaskRuns}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_scheduled_task_runs_status_check`)}
    CHECK (status IN ('pending', 'claimed', 'running', 'succeeded', 'failed', 'cancelled'))
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.scheduledTaskRuns}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_scheduled_task_runs_lifecycle_check`)}
    CHECK (
      (status <> 'pending' OR (
        claim_token IS NULL
        AND thread_input_id IS NULL
        AND thread_run_id IS NULL
        AND lineage_recorded_at IS NULL
        AND started_at IS NULL
        AND finished_at IS NULL
      ))
      AND (status <> 'claimed' OR (
        claim_token IS NOT NULL
        AND thread_input_id IS NULL
        AND thread_run_id IS NULL
        AND lineage_recorded_at IS NULL
        AND started_at IS NULL
        AND finished_at IS NULL
      ))
      AND (status <> 'running' OR (
        claim_token IS NOT NULL
        AND resolved_thread_id IS NOT NULL
        AND thread_input_id IS NOT NULL
        AND thread_run_id IS NULL
        AND lineage_recorded_at IS NOT NULL
        AND started_at IS NOT NULL
        AND finished_at IS NULL
      ))
      AND (status <> 'succeeded' OR (
        lineage_recorded_at IS NOT NULL
        AND started_at IS NOT NULL
        AND finished_at IS NOT NULL
        AND error IS NULL
      ))
      AND (status <> 'failed' OR (
        error IS NOT NULL
        AND finished_at IS NOT NULL
      ))
      AND (status <> 'cancelled' OR (
        finished_at IS NOT NULL
      ))
      AND (status NOT IN ('succeeded', 'failed', 'cancelled') OR (
        claim_token IS NULL
        AND claim_expires_at IS NULL
        AND finished_at IS NOT NULL
      ))
      AND (
        (claim_token IS NULL AND claim_expires_at IS NULL)
        OR (
          claim_token IS NOT NULL
          AND claimed_at IS NOT NULL
          AND claimed_by IS NOT NULL
          AND claim_expires_at IS NOT NULL
        )
      )
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
  // The scoped task FK subsumes both legacy single-column references while
  // also proving that the denormalized session_id belongs to this task.
  await pool.query(`
    ALTER TABLE ${tables.scheduledTaskRuns}
    DROP CONSTRAINT IF EXISTS scheduled_task_runs_task_id_fkey,
    DROP CONSTRAINT IF EXISTS scheduled_task_runs_session_id_fkey
  `);
  await pool.query(`
    ALTER TABLE ${tables.scheduledTaskRuns}
    DROP CONSTRAINT IF EXISTS ${quoteIdentifier(`${tables.prefix}_scheduled_task_runs_resolved_thread_fk`)},
    DROP CONSTRAINT IF EXISTS ${quoteIdentifier(`${tables.prefix}_scheduled_task_runs_thread_run_fk`)},
    DROP CONSTRAINT IF EXISTS ${quoteIdentifier(`${tables.prefix}_scheduled_task_runs_thread_run_scope_check`)}
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.scheduledTaskRuns}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_scheduled_task_runs_stable_input_check`)}
    CHECK (thread_input_id IS NULL OR thread_input_id = id)
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.scheduledTaskRuns}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_scheduled_task_runs_thread_input_scope_check`)}
    CHECK (
      (
        thread_input_id IS NULL
        AND thread_input_thread_id IS NULL
      ) OR (
        thread_input_id IS NOT NULL
        AND thread_input_thread_id IS NOT NULL
        AND (
          thread_input_thread_id = resolved_thread_id
          OR (status IN ('succeeded', 'failed', 'cancelled') AND resolved_thread_id IS NULL)
        )
      )
    )
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.scheduledTaskRuns}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_scheduled_task_runs_thread_input_scope_fk`)}
    FOREIGN KEY (thread_input_thread_id, thread_input_id)
    REFERENCES ${inputTableName}(thread_id, id)
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
        AND (
          thread_run_thread_id = resolved_thread_id
          OR (status IN ('succeeded', 'failed', 'cancelled') AND resolved_thread_id IS NULL)
        )
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
