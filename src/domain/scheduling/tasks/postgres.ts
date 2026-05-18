import {optionalTimestampMillis, requireTimestampMillis} from "../../../lib/postgres-values.js";
import {randomUUID} from "node:crypto";

import {requireBoolean} from "../../../lib/booleans.js";
import {hasActiveClaim} from "../../../lib/claims.js";
import {toDateOrNull} from "../../../lib/dates.js";
import type {PgClientLike, PgPoolLike} from "../../../lib/postgres-query.js";
import {buildThreadRuntimeTableNames} from "../../threads/runtime/postgres-shared.js";
import {computeInitialNextFireAt, normalizeScheduledTaskSchedule} from "./schedule.js";
import {ensurePostgresScheduledTaskSchema} from "./postgres-schema.js";
import {buildScheduledTaskTableNames, type ScheduledTaskTableNames} from "./postgres-shared.js";
import {optionalScheduledTaskString, requireScheduledTaskString} from "./shared.js";
import type {ScheduledTaskStore} from "./store.js";
import type {
    CancelScheduledTaskInput,
    ClaimScheduledTaskInput,
    ClaimScheduledTaskResult,
    CompleteScheduledTaskRunInput,
    CreateScheduledTaskInput,
    FailScheduledTaskRunInput,
    ListActiveScheduledTasksInput,
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

const toDate = toDateOrNull;

function parseScheduleKind(value: unknown): ScheduledTaskRecord["schedule"]["kind"] {
  if (value === "once" || value === "recurring") {
    return value;
  }

  throw new Error(`Unsupported scheduled task schedule kind ${String(value)}.`);
}

function parseRunStatus(value: unknown): ScheduledTaskRunRecord["status"] {
  if (
    value === "claimed"
    || value === "running"
    || value === "succeeded"
    || value === "failed"
    || value === "cancelled"
  ) {
    return value;
  }

  throw new Error(`Unsupported scheduled task run status ${String(value)}.`);
}

function parseTaskRow(row: Record<string, unknown>): ScheduledTaskRecord {
  const scheduleKind = parseScheduleKind(row.schedule_kind);
  const schedule = normalizeScheduledTaskSchedule(scheduleKind === "once"
    ? {
      kind: "once",
      runAt: new Date(requireTimestampMillis(row.run_at, "Scheduled task run_at must be a valid timestamp.")).toISOString(),
    }
    : {
      kind: "recurring",
      cron: requireScheduledTaskString("cron", row.cron_expr),
      timezone: requireScheduledTaskString("timezone", row.timezone),
    });

  return {
    id: requireScheduledTaskString("task id", row.id),
    sessionId: requireScheduledTaskString("session id", row.session_id),
    createdByIdentityId: optionalScheduledTaskString("created identity id", row.created_by_identity_id),
    createdFromMessageId: optionalScheduledTaskString("created message id", row.created_from_message_id),
    title: requireScheduledTaskString("title", row.title),
    instruction: requireScheduledTaskString("instruction", row.instruction),
    schedule,
    enabled: requireBoolean(row.enabled, "Scheduled task enabled flag must be a boolean."),
    nextFireAt: optionalTimestampMillis(row.next_fire_at, "Scheduled task next_fire_at must be a valid timestamp."),
    claimedAt: optionalTimestampMillis(row.claimed_at, "Scheduled task claimed_at must be a valid timestamp."),
    claimedBy: optionalScheduledTaskString("claim owner", row.claimed_by),
    claimExpiresAt: optionalTimestampMillis(row.claim_expires_at, "Scheduled task claim_expires_at must be a valid timestamp."),
    completedAt: optionalTimestampMillis(row.completed_at, "Scheduled task completed_at must be a valid timestamp."),
    cancelledAt: optionalTimestampMillis(row.cancelled_at, "Scheduled task cancelled_at must be a valid timestamp."),
    createdAt: requireTimestampMillis(row.created_at, "Scheduled task created_at must be a valid timestamp."),
    updatedAt: requireTimestampMillis(row.updated_at, "Scheduled task updated_at must be a valid timestamp."),
  };
}

function parseTaskRunRow(row: Record<string, unknown>): ScheduledTaskRunRecord {
  return {
    id: requireScheduledTaskString("run id", row.id),
    taskId: requireScheduledTaskString("task id", row.task_id),
    sessionId: requireScheduledTaskString("session id", row.session_id),
    createdByIdentityId: optionalScheduledTaskString("created identity id", row.created_by_identity_id),
    resolvedThreadId: optionalScheduledTaskString("resolved thread id", row.resolved_thread_id),
    scheduledFor: requireTimestampMillis(row.scheduled_for, "Scheduled task scheduled_for must be a valid timestamp."),
    status: parseRunStatus(row.status),
    threadRunId: optionalScheduledTaskString("thread run id", row.thread_run_id),
    error: optionalScheduledTaskString("error", row.error),
    createdAt: requireTimestampMillis(row.created_at, "Scheduled task created_at must be a valid timestamp."),
    startedAt: optionalTimestampMillis(row.started_at, "Scheduled task started_at must be a valid timestamp."),
    finishedAt: optionalTimestampMillis(row.finished_at, "Scheduled task finished_at must be a valid timestamp."),
  };
}

function normalizeCreateInput(input: CreateScheduledTaskInput): {
  sessionId: string;
  createdByIdentityId?: string;
  createdFromMessageId?: string;
  title: string;
  instruction: string;
  enabled: boolean;
  schedule: ScheduledTaskRecord["schedule"];
  nextFireAt: number;
} {
  const schedule = normalizeScheduledTaskSchedule(input.schedule);

  return {
    sessionId: requireScheduledTaskString("session id", input.sessionId),
    createdByIdentityId: input.createdByIdentityId?.trim() || undefined,
    createdFromMessageId: input.createdFromMessageId?.trim() || undefined,
    title: requireScheduledTaskString("title", input.title),
    instruction: requireScheduledTaskString("instruction", input.instruction),
    enabled: input.enabled ?? true,
    schedule,
    nextFireAt: computeInitialNextFireAt(schedule, Date.now()),
  };
}

async function readLockedTask(
  client: PgClientLike,
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
      requireScheduledTaskString("task id", input.taskId),
      requireScheduledTaskString("session id", input.sessionId),
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

  constructor(options: PostgresScheduledTaskStoreOptions) {
    this.pool = options.pool;
    this.tables = buildScheduledTaskTableNames();
  }

  async ensureSchema(): Promise<void> {
    await ensurePostgresScheduledTaskSchema(this.pool);
  }

  async createTask(input: CreateScheduledTaskInput): Promise<ScheduledTaskRecord> {
    const normalized = normalizeCreateInput(input);
    if (normalized.createdFromMessageId) {
      const threadTables = buildThreadRuntimeTableNames();
      const messageResult = await this.pool.query(
        `
          SELECT message.id
          FROM ${threadTables.messages} AS message
          INNER JOIN ${threadTables.threads} AS thread
            ON thread.id = message.thread_id
          WHERE message.id = $1
            AND thread.session_id = $2
        `,
        [
          normalized.createdFromMessageId,
          normalized.sessionId,
        ],
      );
      if (messageResult.rows.length === 0) {
        throw new Error(`Scheduled task provenance message ${normalized.createdFromMessageId} does not belong to session ${normalized.sessionId}.`);
      }
    }
    const result = await this.pool.query(
      `
        INSERT INTO ${this.tables.scheduledTasks} (
          id,
          session_id,
          created_by_identity_id,
          created_from_message_id,
          title,
          instruction,
          schedule_kind,
          run_at,
          cron_expr,
          timezone,
          enabled,
          next_fire_at
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
          $12
        )
        RETURNING *
      `,
      [
        randomUUID(),
        normalized.sessionId,
        normalized.createdByIdentityId ?? null,
        normalized.createdFromMessageId ?? null,
        normalized.title,
        normalized.instruction,
        normalized.schedule.kind,
        normalized.schedule.kind === "once" ? normalized.schedule.runAt : null,
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
      if (hasActiveClaim(existing, nowMs)) {
        throw new Error(`Scheduled task ${existing.id} is currently running and cannot be updated.`);
      }

      const schedule = normalizeScheduledTaskSchedule(input.schedule ?? existing.schedule);
      const result = await client.query(
        `
          UPDATE ${this.tables.scheduledTasks}
          SET title = $2,
              instruction = $3,
              schedule_kind = $4,
              run_at = $5,
              cron_expr = $6,
              timezone = $7,
              enabled = $8,
              completed_at = NULL,
              cancelled_at = NULL,
              next_fire_at = $9,
              claimed_at = NULL,
              claimed_by = NULL,
              claim_expires_at = NULL,
              updated_at = NOW()
          WHERE id = $1
          RETURNING *
        `,
        [
          existing.id,
          input.title === undefined ? existing.title : requireScheduledTaskString("title", input.title),
          input.instruction === undefined ? existing.instruction : requireScheduledTaskString("instruction", input.instruction),
          schedule.kind,
          schedule.kind === "once" ? schedule.runAt : null,
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
        requireScheduledTaskString("task id", input.taskId),
        requireScheduledTaskString("session id", input.sessionId),
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
      [requireScheduledTaskString("task id", taskId)],
    );
    const row = result.rows[0];
    if (!row) {
      throw missingTaskError(taskId);
    }

    return parseTaskRow(row as Record<string, unknown>);
  }

  async listActiveTasks(input: ListActiveScheduledTasksInput): Promise<readonly ScheduledTaskRecord[]> {
    const limit = Math.max(1, input.limit ?? 25);
    const result = await this.pool.query(
      `
        SELECT *
        FROM ${this.tables.scheduledTasks}
        WHERE session_id = $1
          AND enabled = TRUE
          AND cancelled_at IS NULL
          AND completed_at IS NULL
          AND next_fire_at IS NOT NULL
        ORDER BY next_fire_at ASC, id ASC
        LIMIT $2
      `,
      [
        requireScheduledTaskString("session id", input.sessionId),
        limit,
      ],
    );

    return result.rows.map((row) => parseTaskRow(row as Record<string, unknown>));
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
        [requireScheduledTaskString("task id", input.taskId)],
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
            scheduled_for,
            status
          ) VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            'claimed'
          )
          RETURNING *
        `,
        [
          randomUUID(),
          task.id,
          task.sessionId,
          task.createdByIdentityId ?? null,
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
              updated_at = NOW()
          WHERE id = $1
          RETURNING *
        `,
        [
          task.id,
          requireScheduledTaskString("claim owner", input.claimedBy),
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
        requireScheduledTaskString("run id", input.runId),
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
            error = NULL,
            finished_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [
        requireScheduledTaskString("run id", input.runId),
        input.resolvedThreadId ?? null,
        input.threadRunId ?? null,
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
            error = $4,
            finished_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [
        requireScheduledTaskString("run id", input.runId),
        input.resolvedThreadId ?? null,
        input.threadRunId ?? null,
        requireScheduledTaskString("error", input.error),
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
      [requireScheduledTaskString("task id", taskId)],
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
      [requireScheduledTaskString("task id", taskId)],
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
      [requireScheduledTaskString("task id", taskId)],
    );
    const row = result.rows[0];
    if (!row) {
      throw missingTaskError(taskId);
    }

    return parseTaskRow(row as Record<string, unknown>);
  }

}
