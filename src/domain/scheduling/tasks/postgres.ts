import {randomUUID} from "node:crypto";

import type {PoolClient} from "pg";

import {toDateOrNull} from "../../../lib/dates.js";
import {buildIdentityTableNames} from "../../identity/postgres-shared.js";
import {buildSessionTableNames} from "../../sessions/postgres-shared.js";
import type {PgPoolLike} from "../../threads/runtime/postgres-db.js";
import {
    buildThreadRuntimeTableNames,
    CREATE_RUNTIME_SCHEMA_SQL,
    quoteIdentifier,
    toMillis
} from "../../threads/runtime/postgres-shared.js";
import {addConstraint, assertIntegrityChecks} from "../../../lib/postgres-integrity.js";
import {computeInitialNextFireAt, normalizeScheduledTaskSchedule} from "./schedule.js";
import {buildScheduledTaskTableNames, type ScheduledTaskTableNames} from "./postgres-shared.js";
import {requireScheduledTaskString} from "./shared.js";
import type {ScheduledTaskStore} from "./store.js";
import type {
    CancelScheduledTaskInput,
    ClaimScheduledTaskInput,
    ClaimScheduledTaskResult,
    CompleteScheduledTaskRunInput,
    CreateScheduledTaskInput,
    FailScheduledTaskRunInput,
    ListDueScheduledTasksInput,
    ScheduledTaskRecord,
    ScheduledTaskRunRecord,
    StartScheduledTaskRunInput,
    UpdateScheduledTaskInput,
} from "./types.js";

export interface PostgresScheduledTaskStoreOptions {
  pool: PgPoolLike;
}

function missingTaskError(taskId: string): Error {
  return new Error(`Unknown scheduled task ${taskId}`);
}

function missingTaskRunError(runId: string): Error {
  return new Error(`Unknown scheduled task run ${runId}`);
}

const requireTrimmed = requireScheduledTaskString;
const toDate = toDateOrNull;

function parseTaskRow(row: Record<string, unknown>): ScheduledTaskRecord {
  const scheduleKind = String(row.schedule_kind) as ScheduledTaskRecord["schedule"]["kind"];
  const schedule = scheduleKind === "once"
    ? {
      kind: "once",
      runAt: new Date(String(row.run_at)).toISOString(),
      deliverAt: row.deliver_at === null ? undefined : new Date(String(row.deliver_at)).toISOString(),
    } satisfies ScheduledTaskRecord["schedule"]
    : {
      kind: "recurring",
      cron: String(row.cron_expr),
      timezone: String(row.timezone),
    } satisfies ScheduledTaskRecord["schedule"];

  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    createdByIdentityId: row.created_by_identity_id === null ? undefined : String(row.created_by_identity_id),
    title: String(row.title),
    instruction: String(row.instruction),
    schedule,
    enabled: Boolean(row.enabled),
    nextFireAt: row.next_fire_at === null ? undefined : toMillis(row.next_fire_at),
    nextFireKind: String(row.next_fire_kind) as ScheduledTaskRecord["nextFireKind"],
    claimedAt: row.claimed_at === null ? undefined : toMillis(row.claimed_at),
    claimedBy: row.claimed_by === null ? undefined : String(row.claimed_by),
    claimExpiresAt: row.claim_expires_at === null ? undefined : toMillis(row.claim_expires_at),
    completedAt: row.completed_at === null ? undefined : toMillis(row.completed_at),
    cancelledAt: row.cancelled_at === null ? undefined : toMillis(row.cancelled_at),
    createdAt: toMillis(row.created_at),
    updatedAt: toMillis(row.updated_at),
  };
}

function parseTaskRunRow(row: Record<string, unknown>): ScheduledTaskRunRecord {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    sessionId: String(row.session_id),
    createdByIdentityId: row.created_by_identity_id === null ? undefined : String(row.created_by_identity_id),
    resolvedThreadId: row.resolved_thread_id === null ? undefined : String(row.resolved_thread_id),
    fireKind: String(row.fire_kind) as ScheduledTaskRunRecord["fireKind"],
    scheduledFor: toMillis(row.scheduled_for),
    status: String(row.status) as ScheduledTaskRunRecord["status"],
    threadRunId: row.thread_run_id === null ? undefined : String(row.thread_run_id),
    deliveryStatus: String(row.delivery_status) as ScheduledTaskRunRecord["deliveryStatus"],
    error: row.error === null ? undefined : String(row.error),
    createdAt: toMillis(row.created_at),
    startedAt: row.started_at === null ? undefined : toMillis(row.started_at),
    finishedAt: row.finished_at === null ? undefined : toMillis(row.finished_at),
  };
}

function normalizeCreateInput(input: CreateScheduledTaskInput): {
  sessionId: string;
  createdByIdentityId?: string;
  title: string;
  instruction: string;
  enabled: boolean;
  schedule: ScheduledTaskRecord["schedule"];
  nextFireAt: number;
} {
  const schedule = normalizeScheduledTaskSchedule(input.schedule);

  return {
    sessionId: requireTrimmed("session id", input.sessionId),
    createdByIdentityId: input.createdByIdentityId?.trim() || undefined,
    title: requireTrimmed("title", input.title),
    instruction: requireTrimmed("instruction", input.instruction),
    enabled: input.enabled ?? true,
    schedule,
    nextFireAt: computeInitialNextFireAt(schedule, Date.now()),
  };
}

function isActiveClaim(task: ScheduledTaskRecord, nowMs: number): boolean {
  return task.claimedAt !== undefined
    && task.claimExpiresAt !== undefined
    && task.claimExpiresAt > nowMs;
}

function isWaitingDelayedDelivery(task: ScheduledTaskRecord): boolean {
  return task.schedule.kind === "once"
    && task.nextFireKind === "deliver"
    && task.completedAt === undefined
    && task.cancelledAt === undefined;
}

async function readLockedTask(
  client: PoolClient,
  tables: ScheduledTaskTableNames,
  input: Pick<UpdateScheduledTaskInput, "taskId" | "sessionId">,
): Promise<ScheduledTaskRecord> {
  const result = await client.query(
    `
      SELECT *
      FROM ${tables.scheduledTasks}
      WHERE id = $1
        AND session_id = $2
      FOR UPDATE
    `,
    [
      requireTrimmed("task id", input.taskId),
      requireTrimmed("session id", input.sessionId),
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw missingTaskError(input.taskId);
  }

  return parseTaskRow(row as Record<string, unknown>);
}

export class PostgresScheduledTaskStore implements ScheduledTaskStore {
  private readonly pool: PgPoolLike;
  private readonly tables: ScheduledTaskTableNames;
  private readonly identityTableName: string;
  private readonly sessionTableName: string;
  private readonly threadTableName: string;
  private readonly runTableName: string;

  constructor(options: PostgresScheduledTaskStoreOptions) {
    this.pool = options.pool;
    this.tables = buildScheduledTaskTableNames();
    this.identityTableName = buildIdentityTableNames().identities;
    this.sessionTableName = buildSessionTableNames().sessions;
    const threadTables = buildThreadRuntimeTableNames();
    this.threadTableName = threadTables.threads;
    this.runTableName = threadTables.runs;
  }

  async ensureSchema(): Promise<void> {
    await this.pool.query(CREATE_RUNTIME_SCHEMA_SQL);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.scheduledTasks} (
        id UUID PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES ${this.sessionTableName}(id) ON DELETE CASCADE,
        created_by_identity_id TEXT REFERENCES ${this.identityTableName}(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        instruction TEXT NOT NULL,
        schedule_kind TEXT NOT NULL,
        run_at TIMESTAMPTZ,
        deliver_at TIMESTAMPTZ,
        cron_expr TEXT,
        timezone TEXT,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        completed_at TIMESTAMPTZ,
        cancelled_at TIMESTAMPTZ,
        next_fire_at TIMESTAMPTZ,
        next_fire_kind TEXT NOT NULL DEFAULT 'execute',
        claimed_at TIMESTAMPTZ,
        claimed_by TEXT,
        claim_expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_scheduled_tasks_due_idx`)}
      ON ${this.tables.scheduledTasks} (enabled, cancelled_at, completed_at, next_fire_at, id)
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_scheduled_tasks_identity_agent_idx`)}
      ON ${this.tables.scheduledTasks} (session_id, created_at DESC)
    `);
    await this.pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_scheduled_tasks_session_id_id_idx`)}
      ON ${this.tables.scheduledTasks} (session_id, id)
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.scheduledTaskRuns} (
        id UUID PRIMARY KEY,
        task_id UUID NOT NULL REFERENCES ${this.tables.scheduledTasks}(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES ${this.sessionTableName}(id) ON DELETE CASCADE,
        created_by_identity_id TEXT REFERENCES ${this.identityTableName}(id) ON DELETE SET NULL,
        resolved_thread_id TEXT,
        resolved_thread_session_id TEXT,
        fire_kind TEXT NOT NULL,
        scheduled_for TIMESTAMPTZ NOT NULL,
        status TEXT NOT NULL,
        thread_run_id UUID,
        thread_run_thread_id TEXT,
        delivery_status TEXT NOT NULL DEFAULT 'not_requested',
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_scheduled_task_runs_task_created_idx`)}
      ON ${this.tables.scheduledTaskRuns} (task_id, created_at DESC)
    `);
    await this.pool.query(`
      ALTER TABLE ${this.tables.scheduledTaskRuns}
      ADD COLUMN IF NOT EXISTS resolved_thread_session_id TEXT
    `);
    await this.pool.query(`
      ALTER TABLE ${this.tables.scheduledTaskRuns}
      ADD COLUMN IF NOT EXISTS thread_run_thread_id TEXT
    `);
    const threadRunTypeResult = await this.pool.query(`
      SELECT data_type
      FROM information_schema.columns
      WHERE table_schema = 'runtime'
        AND table_name = 'scheduled_task_runs'
        AND column_name = 'thread_run_id'
    `);
    const threadRunType = String((threadRunTypeResult.rows[0] as {data_type?: unknown} | undefined)?.data_type ?? "");
    if (threadRunType && threadRunType !== "uuid") {
      await assertIntegrityChecks(this.pool, "Scheduled task schema", [
        {
          label: "scheduled_task_runs.thread_run_id invalid UUID format",
          sql: `
            SELECT COUNT(*)::INTEGER AS count
            FROM ${this.tables.scheduledTaskRuns}
            WHERE thread_run_id IS NOT NULL
              AND BTRIM(thread_run_id::text) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          `,
        },
      ]);
      await this.pool.query(`
        ALTER TABLE ${this.tables.scheduledTaskRuns}
        ALTER COLUMN thread_run_id TYPE UUID
        USING CASE
          WHEN thread_run_id IS NULL THEN NULL
          ELSE thread_run_id::uuid
        END
      `);
    }
    await assertIntegrityChecks(this.pool, "Scheduled task schema", [
      {
        label: "scheduled_task_runs.task_id orphaned from scheduled_tasks.id",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM ${this.tables.scheduledTaskRuns} AS run
          LEFT JOIN ${this.tables.scheduledTasks} AS task
            ON task.id = run.task_id
          WHERE task.id IS NULL
        `,
      },
      {
        label: "scheduled_task_runs task/session mismatch",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM ${this.tables.scheduledTaskRuns} AS run
          INNER JOIN ${this.tables.scheduledTasks} AS task
            ON task.id = run.task_id
          WHERE task.session_id <> run.session_id
        `,
      },
      {
        label: "scheduled_task_runs.resolved_thread_id orphaned from threads.id",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM ${this.tables.scheduledTaskRuns} AS run
          LEFT JOIN ${this.threadTableName} AS thread
            ON thread.id = run.resolved_thread_id
          WHERE run.resolved_thread_id IS NOT NULL
            AND thread.id IS NULL
        `,
      },
      {
        label: "scheduled_task_runs.resolved_thread_id bound to another session",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM ${this.tables.scheduledTaskRuns} AS run
          INNER JOIN ${this.threadTableName} AS thread
            ON thread.id = run.resolved_thread_id
          WHERE run.resolved_thread_id IS NOT NULL
            AND thread.session_id <> run.session_id
        `,
      },
      {
        label: "scheduled_task_runs.thread_run_id orphaned from runs.id",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM ${this.tables.scheduledTaskRuns} AS run
          LEFT JOIN ${this.runTableName} AS thread_run
            ON thread_run.id = run.thread_run_id
          WHERE run.thread_run_id IS NOT NULL
            AND thread_run.id IS NULL
        `,
      },
      {
        label: "scheduled_task_runs.thread_run_id set without resolved_thread_id",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM ${this.tables.scheduledTaskRuns}
          WHERE thread_run_id IS NOT NULL
            AND resolved_thread_id IS NULL
        `,
      },
      {
        label: "scheduled_task_runs.thread_run_id bound to another thread",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM ${this.tables.scheduledTaskRuns} AS run
          INNER JOIN ${this.runTableName} AS thread_run
            ON thread_run.id = run.thread_run_id
          WHERE run.thread_run_id IS NOT NULL
            AND thread_run.thread_id <> run.resolved_thread_id
        `,
      },
    ]);
    await this.pool.query(`
      UPDATE ${this.tables.scheduledTaskRuns}
      SET resolved_thread_session_id = NULL
      WHERE resolved_thread_id IS NULL
        AND resolved_thread_session_id IS NOT NULL
    `);
    await this.pool.query(`
      UPDATE ${this.tables.scheduledTaskRuns}
      SET resolved_thread_session_id = thread.session_id
      FROM ${this.threadTableName} AS thread
      WHERE ${this.tables.scheduledTaskRuns}.resolved_thread_id IS NOT NULL
        AND thread.id = ${this.tables.scheduledTaskRuns}.resolved_thread_id
        AND (
          ${this.tables.scheduledTaskRuns}.resolved_thread_session_id IS NULL
          OR ${this.tables.scheduledTaskRuns}.resolved_thread_session_id <> thread.session_id
        )
    `);
    await this.pool.query(`
      UPDATE ${this.tables.scheduledTaskRuns}
      SET thread_run_thread_id = NULL
      WHERE thread_run_id IS NULL
        AND thread_run_thread_id IS NOT NULL
    `);
    await this.pool.query(`
      UPDATE ${this.tables.scheduledTaskRuns}
      SET thread_run_thread_id = thread_run.thread_id
      FROM ${this.runTableName} AS thread_run
      WHERE ${this.tables.scheduledTaskRuns}.thread_run_id IS NOT NULL
        AND thread_run.id = ${this.tables.scheduledTaskRuns}.thread_run_id
        AND (
          ${this.tables.scheduledTaskRuns}.thread_run_thread_id IS NULL
          OR ${this.tables.scheduledTaskRuns}.thread_run_thread_id <> thread_run.thread_id
        )
    `);
    await addConstraint(this.pool, `
      ALTER TABLE ${this.tables.scheduledTaskRuns}
      ADD CONSTRAINT ${quoteIdentifier(`${this.tables.prefix}_scheduled_task_runs_task_scope_fk`)}
      FOREIGN KEY (session_id, task_id)
      REFERENCES ${this.tables.scheduledTasks}(session_id, id)
      ON DELETE CASCADE
    `);
    await addConstraint(this.pool, `
      ALTER TABLE ${this.tables.scheduledTaskRuns}
      ADD CONSTRAINT ${quoteIdentifier(`${this.tables.prefix}_scheduled_task_runs_resolved_thread_fk`)}
      FOREIGN KEY (resolved_thread_id)
      REFERENCES ${this.threadTableName}(id)
      ON DELETE SET NULL
    `);
    await addConstraint(this.pool, `
      ALTER TABLE ${this.tables.scheduledTaskRuns}
      ADD CONSTRAINT ${quoteIdentifier(`${this.tables.prefix}_scheduled_task_runs_thread_run_fk`)}
      FOREIGN KEY (thread_run_id)
      REFERENCES ${this.runTableName}(id)
      ON DELETE SET NULL
    `);
    await addConstraint(this.pool, `
      ALTER TABLE ${this.tables.scheduledTaskRuns}
      ADD CONSTRAINT ${quoteIdentifier(`${this.tables.prefix}_scheduled_task_runs_resolved_thread_scope_check`)}
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
    await addConstraint(this.pool, `
      ALTER TABLE ${this.tables.scheduledTaskRuns}
      ADD CONSTRAINT ${quoteIdentifier(`${this.tables.prefix}_scheduled_task_runs_resolved_thread_scope_fk`)}
      FOREIGN KEY (resolved_thread_session_id, resolved_thread_id)
      REFERENCES ${this.threadTableName}(session_id, id)
      ON DELETE SET NULL
    `);
    await addConstraint(this.pool, `
      ALTER TABLE ${this.tables.scheduledTaskRuns}
      ADD CONSTRAINT ${quoteIdentifier(`${this.tables.prefix}_scheduled_task_runs_thread_run_scope_check`)}
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
    await addConstraint(this.pool, `
      ALTER TABLE ${this.tables.scheduledTaskRuns}
      ADD CONSTRAINT ${quoteIdentifier(`${this.tables.prefix}_scheduled_task_runs_thread_run_scope_fk`)}
      FOREIGN KEY (thread_run_thread_id, thread_run_id)
      REFERENCES ${this.runTableName}(thread_id, id)
      ON DELETE SET NULL
    `);
  }

  async createTask(input: CreateScheduledTaskInput): Promise<ScheduledTaskRecord> {
    const normalized = normalizeCreateInput(input);
    const result = await this.pool.query(
      `
        INSERT INTO ${this.tables.scheduledTasks} (
          id,
          session_id,
          created_by_identity_id,
          title,
          instruction,
          schedule_kind,
          run_at,
          deliver_at,
          cron_expr,
          timezone,
          enabled,
          next_fire_at,
          next_fire_kind
        ) VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11,
          $12,
          'execute'
        )
        RETURNING *
      `,
      [
        randomUUID(),
        normalized.sessionId,
        normalized.createdByIdentityId ?? null,
        normalized.title,
        normalized.instruction,
        normalized.schedule.kind,
        normalized.schedule.kind === "once" ? normalized.schedule.runAt : null,
        normalized.schedule.kind === "once" ? normalized.schedule.deliverAt ?? null : null,
        normalized.schedule.kind === "recurring" ? normalized.schedule.cron : null,
        normalized.schedule.kind === "recurring" ? normalized.schedule.timezone : null,
        normalized.enabled,
        new Date(normalized.nextFireAt),
      ],
    );

    return parseTaskRow(result.rows[0] as Record<string, unknown>);
  }

  async updateTask(input: UpdateScheduledTaskInput): Promise<ScheduledTaskRecord> {
    const client = await this.pool.connect();
    let inTransaction = false;

    try {
      await client.query("BEGIN");
      inTransaction = true;

      const existing = await readLockedTask(client, this.tables, input);
      const nowMs = Date.now();
      if (isActiveClaim(existing, nowMs)) {
        throw new Error(`Scheduled task ${existing.id} is currently running and cannot be updated.`);
      }
      if (isWaitingDelayedDelivery(existing)) {
        throw new Error(`Scheduled task ${existing.id} is waiting for delayed delivery and cannot be updated.`);
      }

      const schedule = normalizeScheduledTaskSchedule(input.schedule ?? existing.schedule);
      const result = await client.query(
        `
          UPDATE ${this.tables.scheduledTasks}
          SET title = $2,
              instruction = $3,
              schedule_kind = $4,
              run_at = $5,
              deliver_at = $6,
              cron_expr = $7,
              timezone = $8,
              enabled = $9,
              completed_at = NULL,
              cancelled_at = NULL,
              next_fire_at = $10,
              next_fire_kind = 'execute',
              claimed_at = NULL,
              claimed_by = NULL,
              claim_expires_at = NULL,
              updated_at = NOW()
          WHERE id = $1
          RETURNING *
        `,
        [
          existing.id,
          input.title === undefined ? existing.title : requireTrimmed("title", input.title),
          input.instruction === undefined ? existing.instruction : requireTrimmed("instruction", input.instruction),
          schedule.kind,
          schedule.kind === "once" ? schedule.runAt : null,
          schedule.kind === "once" ? schedule.deliverAt ?? null : null,
          schedule.kind === "recurring" ? schedule.cron : null,
          schedule.kind === "recurring" ? schedule.timezone : null,
          input.enabled ?? existing.enabled,
          new Date(computeInitialNextFireAt(schedule, nowMs)),
        ],
      );

      await client.query("COMMIT");
      inTransaction = false;
      return parseTaskRow(result.rows[0] as Record<string, unknown>);
    } catch (error) {
      if (inTransaction) {
        await client.query("ROLLBACK");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async cancelTask(input: CancelScheduledTaskInput): Promise<ScheduledTaskRecord> {
    const result = await this.pool.query(
      `
        UPDATE ${this.tables.scheduledTasks}
        SET cancelled_at = NOW(),
            next_fire_at = NULL,
            claimed_at = NULL,
            claimed_by = NULL,
            claim_expires_at = NULL,
            updated_at = NOW()
        WHERE id = $1
          AND session_id = $2
        RETURNING *
      `,
      [
        requireTrimmed("task id", input.taskId),
        requireTrimmed("session id", input.sessionId),
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw missingTaskError(input.taskId);
    }

    return parseTaskRow(row as Record<string, unknown>);
  }

  async getTask(taskId: string): Promise<ScheduledTaskRecord> {
    const result = await this.pool.query(
      `
        SELECT *
        FROM ${this.tables.scheduledTasks}
        WHERE id = $1
      `,
      [requireTrimmed("task id", taskId)],
    );
    const row = result.rows[0];
    if (!row) {
      throw missingTaskError(taskId);
    }

    return parseTaskRow(row as Record<string, unknown>);
  }

  async listDueTasks(input: ListDueScheduledTasksInput = {}): Promise<readonly ScheduledTaskRecord[]> {
    const asOf = input.asOf ?? Date.now();
    const limit = Math.max(1, input.limit ?? 25);
    const result = await this.pool.query(
      `
        SELECT *
        FROM ${this.tables.scheduledTasks}
        WHERE enabled = TRUE
          AND cancelled_at IS NULL
          AND completed_at IS NULL
          AND next_fire_at IS NOT NULL
          AND next_fire_at <= $1
          AND (
            claimed_at IS NULL
            OR claim_expires_at IS NULL
            OR claim_expires_at <= $1
          )
        ORDER BY next_fire_at ASC, id ASC
        LIMIT $2
      `,
      [
        new Date(asOf),
        limit,
      ],
    );

    return result.rows.map((row) => parseTaskRow(row as Record<string, unknown>));
  }

  async claimTask(input: ClaimScheduledTaskInput): Promise<ClaimScheduledTaskResult | null> {
    const client = await this.pool.connect();
    let inTransaction = false;

    try {
      await client.query("BEGIN");
      inTransaction = true;

      const selectResult = await client.query(
        `
          SELECT *
          FROM ${this.tables.scheduledTasks}
          WHERE id = $1
            AND enabled = TRUE
            AND cancelled_at IS NULL
            AND completed_at IS NULL
            AND next_fire_at IS NOT NULL
            AND next_fire_at <= NOW()
            AND (
              claimed_at IS NULL
              OR claim_expires_at IS NULL
              OR claim_expires_at <= NOW()
            )
          FOR UPDATE
        `,
        [requireTrimmed("task id", input.taskId)],
      );
      const row = selectResult.rows[0];
      if (!row) {
        await client.query("COMMIT");
        inTransaction = false;
        return null;
      }

      const task = parseTaskRow(row as Record<string, unknown>);
      const runResult = await client.query(
        `
          INSERT INTO ${this.tables.scheduledTaskRuns} (
            id,
            task_id,
            session_id,
            created_by_identity_id,
            fire_kind,
            scheduled_for,
            status,
            delivery_status
          ) VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            'claimed',
            'not_requested'
          )
          RETURNING *
        `,
        [
          randomUUID(),
          task.id,
          task.sessionId,
          task.createdByIdentityId ?? null,
          task.nextFireKind,
          new Date(task.nextFireAt!),
        ],
      );

      const updatedTaskResult = await client.query(
        `
          UPDATE ${this.tables.scheduledTasks}
          SET claimed_at = NOW(),
              claimed_by = $2,
              claim_expires_at = $3,
              next_fire_at = COALESCE($4, next_fire_at),
              next_fire_kind = CASE
                WHEN schedule_kind = 'recurring' THEN 'execute'
                ELSE next_fire_kind
              END,
              updated_at = NOW()
          WHERE id = $1
          RETURNING *
        `,
        [
          task.id,
          requireTrimmed("claim owner", input.claimedBy),
          new Date(input.claimExpiresAt),
          toDate(input.nextFireAt),
        ],
      );

      await client.query("COMMIT");
      inTransaction = false;

      return {
        task: parseTaskRow(updatedTaskResult.rows[0] as Record<string, unknown>),
        run: parseTaskRunRow(runResult.rows[0] as Record<string, unknown>),
      };
    } catch (error) {
      if (inTransaction) {
        await client.query("ROLLBACK");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async startTaskRun(input: StartScheduledTaskRunInput): Promise<ScheduledTaskRunRecord> {
    const result = await this.pool.query(
      `
        UPDATE ${this.tables.scheduledTaskRuns}
        SET status = 'running',
            resolved_thread_id = COALESCE($2, resolved_thread_id),
            resolved_thread_session_id = CASE
              WHEN COALESCE($2, resolved_thread_id) IS NULL THEN NULL
              ELSE session_id
            END,
            started_at = COALESCE(started_at, NOW())
        WHERE id = $1
        RETURNING *
      `,
      [
        requireTrimmed("run id", input.runId),
        input.resolvedThreadId ?? null,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw missingTaskRunError(input.runId);
    }

    return parseTaskRunRow(row as Record<string, unknown>);
  }

  async completeTaskRun(input: CompleteScheduledTaskRunInput): Promise<ScheduledTaskRunRecord> {
    const result = await this.pool.query(
      `
        UPDATE ${this.tables.scheduledTaskRuns}
        SET status = 'succeeded',
            resolved_thread_id = COALESCE($2, resolved_thread_id),
            resolved_thread_session_id = CASE
              WHEN COALESCE($2, resolved_thread_id) IS NULL THEN NULL
              ELSE session_id
            END,
            thread_run_id = COALESCE($3, thread_run_id),
            thread_run_thread_id = CASE
              WHEN COALESCE($3, thread_run_id) IS NULL THEN NULL
              ELSE COALESCE($2, resolved_thread_id)
            END,
            delivery_status = COALESCE($4, delivery_status),
            error = NULL,
            finished_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [
        requireTrimmed("run id", input.runId),
        input.resolvedThreadId ?? null,
        input.threadRunId ?? null,
        input.deliveryStatus ?? null,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw missingTaskRunError(input.runId);
    }

    return parseTaskRunRow(row as Record<string, unknown>);
  }

  async failTaskRun(input: FailScheduledTaskRunInput): Promise<ScheduledTaskRunRecord> {
    const result = await this.pool.query(
      `
        UPDATE ${this.tables.scheduledTaskRuns}
        SET status = 'failed',
            resolved_thread_id = COALESCE($2, resolved_thread_id),
            resolved_thread_session_id = CASE
              WHEN COALESCE($2, resolved_thread_id) IS NULL THEN NULL
              ELSE session_id
            END,
            thread_run_id = COALESCE($3, thread_run_id),
            thread_run_thread_id = CASE
              WHEN COALESCE($3, thread_run_id) IS NULL THEN NULL
              ELSE COALESCE($2, resolved_thread_id)
            END,
            delivery_status = COALESCE($4, delivery_status),
            error = $5,
            finished_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [
        requireTrimmed("run id", input.runId),
        input.resolvedThreadId ?? null,
        input.threadRunId ?? null,
        input.deliveryStatus ?? null,
        requireTrimmed("error", input.error),
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw missingTaskRunError(input.runId);
    }

    return parseTaskRunRow(row as Record<string, unknown>);
  }

  async clearTaskClaim(taskId: string): Promise<ScheduledTaskRecord> {
    const result = await this.pool.query(
      `
        UPDATE ${this.tables.scheduledTasks}
        SET claimed_at = NULL,
            claimed_by = NULL,
            claim_expires_at = NULL,
            updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [requireTrimmed("task id", taskId)],
    );
    const row = result.rows[0];
    if (!row) {
      throw missingTaskError(taskId);
    }

    return parseTaskRow(row as Record<string, unknown>);
  }

  async markTaskWaitingDelivery(taskId: string): Promise<ScheduledTaskRecord> {
    const result = await this.pool.query(
      `
        UPDATE ${this.tables.scheduledTasks}
        SET next_fire_at = CASE
              WHEN cancelled_at IS NULL THEN deliver_at
              ELSE NULL
            END,
            next_fire_kind = CASE
              WHEN cancelled_at IS NULL THEN 'deliver'
              ELSE next_fire_kind
            END,
            claimed_at = NULL,
            claimed_by = NULL,
            claim_expires_at = NULL,
            updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [requireTrimmed("task id", taskId)],
    );
    const row = result.rows[0];
    if (!row) {
      throw missingTaskError(taskId);
    }

    return parseTaskRow(row as Record<string, unknown>);
  }

  async markTaskCompleted(taskId: string): Promise<ScheduledTaskRecord> {
    const result = await this.pool.query(
      `
        UPDATE ${this.tables.scheduledTasks}
        SET completed_at = CASE
              WHEN cancelled_at IS NULL THEN NOW()
              ELSE completed_at
            END,
            next_fire_at = NULL,
            claimed_at = NULL,
            claimed_by = NULL,
            claim_expires_at = NULL,
            updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [requireTrimmed("task id", taskId)],
    );
    const row = result.rows[0];
    if (!row) {
      throw missingTaskError(taskId);
    }

    return parseTaskRow(row as Record<string, unknown>);
  }

  async markTaskFailed(taskId: string): Promise<ScheduledTaskRecord> {
    const result = await this.pool.query(
      `
        UPDATE ${this.tables.scheduledTasks}
        SET completed_at = CASE
              WHEN cancelled_at IS NULL THEN NOW()
              ELSE completed_at
            END,
            next_fire_at = NULL,
            claimed_at = NULL,
            claimed_by = NULL,
            claim_expires_at = NULL,
            updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [requireTrimmed("task id", taskId)],
    );
    const row = result.rows[0];
    if (!row) {
      throw missingTaskError(taskId);
    }

    return parseTaskRow(row as Record<string, unknown>);
  }

  async getLatestTaskRun(taskId: string, fireKind?: ScheduledTaskRunRecord["fireKind"]): Promise<ScheduledTaskRunRecord | null> {
    const values: unknown[] = [requireTrimmed("task id", taskId)];
    let sql = `
      SELECT *
      FROM ${this.tables.scheduledTaskRuns}
      WHERE task_id = $1
    `;

    if (fireKind) {
      values.push(fireKind);
      sql += ` AND fire_kind = $${values.length}`;
    }

    sql += " ORDER BY created_at DESC LIMIT 1";
    const result = await this.pool.query(sql, values);
    const row = result.rows[0];
    return row ? parseTaskRunRow(row as Record<string, unknown>) : null;
  }
}
