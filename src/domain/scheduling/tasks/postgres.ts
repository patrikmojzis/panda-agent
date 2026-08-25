import {optionalTimestampMillis, requireTimestampMillis} from "../../../lib/postgres-values.js";
import {randomUUID} from "node:crypto";

import {requireBoolean} from "../../../lib/booleans.js";
import type {PgClientLike, PgPoolLike} from "../../../lib/postgres-query.js";
import {buildThreadRuntimeTableNames} from "../../threads/runtime/postgres-shared.js";
import {buildSessionTableNames} from "../../sessions/postgres-shared.js";
import {computeInitialNextFireAt, normalizeScheduledTaskSchedule} from "./schedule.js";
import {buildScheduledTaskTableNames, type ScheduledTaskTableNames} from "./postgres-shared.js";
import {optionalScheduledTaskString, requireScheduledTaskString} from "./shared.js";
import type {ScheduledTaskStore} from "./store.js";
import type {
  CancelScheduledTaskInput,
  ClaimedScheduledTaskRunRecord,
  ClaimScheduledTaskResult,
  ClaimScheduledTaskRunInput,
  CompleteScheduledTaskRunInput,
  CreateScheduledTaskInput,
  FailScheduledTaskRunInput,
  ListActiveScheduledTasksInput,
  ListDueScheduledTasksInput,
  ListScheduledTaskRunsInput,
  ListScheduledTasksInput,
  MaterializeScheduledTaskRunsInput,
  RenewScheduledTaskRunClaimInput,
  ScheduledTaskRecord,
  ScheduledTaskRunRecord,
  StartScheduledTaskRunInput,
  UpdateScheduledTaskInput,
} from "./types.js";

export interface PostgresScheduledTaskStoreOptions {
  pool: PgPoolLike;
}

const MAX_SCHEDULED_TASK_READ_LIMIT = 100;
const MAX_MATERIALIZATION_BATCH_SIZE = 100;

function boundedReadLimit(value: number | undefined): number {
  const limit = value ?? 25;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("Scheduled task read limit must be a positive integer.");
  }
  return Math.min(MAX_SCHEDULED_TASK_READ_LIMIT, limit);
}

function missingTaskError(taskId: string): Error {
  return new Error(`Unknown scheduled task ${taskId}`);
}

function rejectedTaskRunMutationError(runId: string, action: string): Error {
  return new Error(
    `Scheduled task run ${runId} could not ${action}: its claim expired or its execution receipt does not match.`,
  );
}

function parseScheduleKind(value: unknown): ScheduledTaskRecord["schedule"]["kind"] {
  if (value === "once" || value === "recurring") {
    return value;
  }

  throw new Error(`Unsupported scheduled task schedule kind ${String(value)}.`);
}

function parseRunStatus(value: unknown): ScheduledTaskRunRecord["status"] {
  if (
    value === "pending"
    || value === "claimed"
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
    threadInputId: optionalScheduledTaskString("thread input id", row.thread_input_id),
    threadRunId: optionalScheduledTaskString("thread run id", row.thread_run_id),
    claimToken: optionalScheduledTaskString("claim token", row.claim_token),
    claimedAt: optionalTimestampMillis(row.claimed_at, "Scheduled task run claimed_at must be a valid timestamp."),
    claimedBy: optionalScheduledTaskString("claim owner", row.claimed_by),
    claimExpiresAt: optionalTimestampMillis(row.claim_expires_at, "Scheduled task run claim_expires_at must be a valid timestamp."),
    error: optionalScheduledTaskString("error", row.error),
    createdAt: requireTimestampMillis(row.created_at, "Scheduled task created_at must be a valid timestamp."),
    startedAt: optionalTimestampMillis(row.started_at, "Scheduled task started_at must be a valid timestamp."),
    finishedAt: optionalTimestampMillis(row.finished_at, "Scheduled task finished_at must be a valid timestamp."),
  };
}

function parseClaimedTaskRunRow(row: Record<string, unknown>): ClaimedScheduledTaskRunRecord {
  const run = parseTaskRunRow(row);
  if (!run.claimToken || !run.claimedAt || !run.claimedBy || !run.claimExpiresAt) {
    throw new Error(`Scheduled task run ${run.id} is missing its active claim.`);
  }
  return {
    ...run,
    claimToken: run.claimToken,
    claimedAt: run.claimedAt,
    claimedBy: run.claimedBy,
    claimExpiresAt: run.claimExpiresAt,
  };
}

const TASK_ROW_COLUMNS = [
  "id",
  "session_id",
  "created_by_identity_id",
  "created_from_message_id",
  "title",
  "instruction",
  "schedule_kind",
  "run_at",
  "cron_expr",
  "timezone",
  "enabled",
  "next_fire_at",
  "completed_at",
  "cancelled_at",
  "created_at",
  "updated_at",
] as const;

function selectTaskRowColumns(alias: string): string {
  return TASK_ROW_COLUMNS
    .map((column) => `${alias}.${column} AS task__${column}`)
    .join(",\n        ");
}

function extractTaskRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(TASK_ROW_COLUMNS.map((column) => [column, row[`task__${column}`]]));
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
  private readonly threadTables = buildThreadRuntimeTableNames();
  private readonly sessionTables = buildSessionTableNames();

  constructor(options: PostgresScheduledTaskStoreOptions) {
    this.pool = options.pool;
    this.tables = buildScheduledTaskTableNames();
  }

  async createTask(input: CreateScheduledTaskInput): Promise<ScheduledTaskRecord> {
    const normalized = normalizeCreateInput(input);
    if (normalized.createdFromMessageId) {
      const messageResult = await this.pool.query(
        `
          SELECT message.id
          FROM ${this.threadTables.messages} AS message
          INNER JOIN ${this.threadTables.threads} AS thread
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
      if (existing.completedAt !== undefined || existing.cancelledAt !== undefined) {
        throw new Error(`Scheduled task ${existing.id} is terminal and cannot be updated; create a new task instead.`);
      }
      const nowMs = Date.now();
      const schedule = normalizeScheduledTaskSchedule(input.schedule ?? existing.schedule);
      const nextFireAt = computeInitialNextFireAt(schedule, nowMs);
      const unfinishedRun = await client.query(`
        SELECT 1
        FROM ${this.tables.scheduledTaskRuns}
        WHERE task_id = $1
          AND status IN ('pending', 'claimed', 'running')
        LIMIT 1
      `, [existing.id]);
      if (unfinishedRun.rows.length > 0) {
        throw new Error(`Scheduled task ${existing.id} has an unfinished occurrence and cannot be updated.`);
      }
      const duplicateOccurrence = await client.query(`
        SELECT 1
        FROM ${this.tables.scheduledTaskRuns}
        WHERE task_id = $1
          AND scheduled_for = $2
        LIMIT 1
      `, [existing.id, new Date(nextFireAt)]);
      if (duplicateOccurrence.rows.length > 0) {
        throw new Error(
          `Scheduled task ${existing.id} already has an occurrence at ${new Date(nextFireAt).toISOString()}; choose a new time or create a new task.`,
        );
      }

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
              next_fire_at = $9,
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
          new Date(nextFireAt),
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
    const client = await this.pool.connect();
    let inTransaction = false;
    try {
      await client.query("BEGIN");
      inTransaction = true;
      const existing = await readLockedTask(client, this.tables, input);
      if (existing.completedAt !== undefined || existing.cancelledAt !== undefined) {
        throw new Error(`Scheduled task ${existing.id} is terminal and cannot be cancelled.`);
      }
      const result = await client.query(`
        UPDATE ${this.tables.scheduledTasks}
        SET cancelled_at = NOW(),
            next_fire_at = NULL,
            updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `, [
        existing.id,
      ]);

      await client.query(`
        UPDATE ${this.tables.scheduledTaskRuns}
        SET status = 'cancelled',
            error = $2,
            finished_at = NOW(),
            claim_token = NULL,
            claim_expires_at = NULL
        WHERE task_id = $1
          AND status = 'pending'
      `, [existing.id, input.reason?.trim() || "Scheduled task cancelled before execution."]);
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

  async listTasks(input: ListScheduledTasksInput): Promise<readonly ScheduledTaskRecord[]> {
    const status = input.status ?? "active";
    const limit = boundedReadLimit(input.limit);
    const statusFilter = status === "active"
      ? "AND enabled = TRUE AND cancelled_at IS NULL AND completed_at IS NULL"
      : status === "disabled"
        ? "AND enabled = FALSE AND cancelled_at IS NULL AND completed_at IS NULL"
        : status === "completed"
          ? "AND completed_at IS NOT NULL"
          : status === "cancelled"
            ? "AND cancelled_at IS NOT NULL"
            : "";
    const result = await this.pool.query(
      `
        SELECT *
        FROM ${this.tables.scheduledTasks}
        WHERE session_id = $1
          ${statusFilter}
        ORDER BY next_fire_at ASC NULLS LAST, updated_at DESC, id ASC
        LIMIT $2
      `,
      [
        requireScheduledTaskString("session id", input.sessionId),
        limit,
      ],
    );

    return result.rows.map((row) => parseTaskRow(row as Record<string, unknown>));
  }

  async listTaskRuns(input: ListScheduledTaskRunsInput): Promise<readonly ScheduledTaskRunRecord[]> {
    const limit = boundedReadLimit(input.limit);
    const result = await this.pool.query(
      `
        SELECT *
        FROM ${this.tables.scheduledTaskRuns}
        WHERE task_id = $1
          AND session_id = $2
        ORDER BY created_at DESC, id ASC
        LIMIT $3
      `,
      [
        requireScheduledTaskString("task id", input.taskId),
        requireScheduledTaskString("session id", input.sessionId),
        limit,
      ],
    );

    return result.rows.map((row) => parseTaskRunRow(row as Record<string, unknown>));
  }

  async listActiveTasks(input: ListActiveScheduledTasksInput): Promise<readonly ScheduledTaskRecord[]> {
    const limit = boundedReadLimit(input.limit);
    const result = await this.pool.query(
      `
        /* scheduled_active_tasks */
        SELECT task.*
        FROM ${this.tables.scheduledTasks} AS task
        WHERE task.session_id = $1
          AND task.enabled = TRUE
          AND task.cancelled_at IS NULL
          AND task.completed_at IS NULL
          AND (
            task.next_fire_at IS NOT NULL
            OR EXISTS (
              SELECT 1
              FROM ${this.tables.scheduledTaskRuns} AS active_run
              WHERE active_run.task_id = task.id
                AND active_run.status IN ('pending', 'claimed', 'running')
            )
          )
        ORDER BY task.next_fire_at ASC, task.id ASC
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
    const limit = boundedReadLimit(input.limit);
    if (input.asOf !== undefined && !Number.isFinite(input.asOf)) {
      throw new Error("Scheduled task due time must be a finite timestamp.");
    }
    // Production scheduling uses the database clock, the same authority that
    // fences materialization and claim expiry. asOf exists only for explicit
    // deterministic reads such as tests and operator diagnostics.
    const dueAt = input.asOf === undefined ? "NOW()" : "$1";
    const limitParameter = input.asOf === undefined ? "$1" : "$2";
    const result = await this.pool.query(
      `
        SELECT task.*
        FROM ${this.tables.scheduledTasks} AS task
        INNER JOIN ${this.sessionTables.sessions} AS session
          ON session.id = task.session_id
         AND session.archived_at IS NULL
        WHERE task.enabled = TRUE
          AND task.cancelled_at IS NULL
          AND task.completed_at IS NULL
          AND task.next_fire_at IS NOT NULL
          AND task.next_fire_at <= ${dueAt}
          AND NOT EXISTS (
            SELECT 1
            FROM ${this.tables.scheduledTaskRuns} AS active_run
            WHERE active_run.task_id = task.id
              AND active_run.status IN ('pending', 'claimed', 'running')
          )
        ORDER BY task.next_fire_at ASC, task.id ASC
        LIMIT ${limitParameter}
      `,
      input.asOf === undefined ? [limit] : [new Date(input.asOf), limit],
    );

    return result.rows.map((row) => parseTaskRow(row as Record<string, unknown>));
  }

  async materializeTaskRuns(input: MaterializeScheduledTaskRunsInput): Promise<readonly ScheduledTaskRunRecord[]> {
    if (input.runs.length === 0) {
      return [];
    }
    if (input.runs.length > MAX_MATERIALIZATION_BATCH_SIZE) {
      throw new Error(`Scheduled task materialization cannot exceed ${MAX_MATERIALIZATION_BATCH_SIZE} occurrences.`);
    }

    const taskIds = new Set<string>();
    const values: unknown[] = [];
    const requestedRows = input.runs.map((run, index) => {
      const taskId = requireScheduledTaskString("task id", run.taskId);
      if (taskIds.has(taskId)) {
        throw new Error(`Scheduled task ${taskId} was included more than once in one materialization batch.`);
      }
      taskIds.add(taskId);
      if (!Number.isFinite(run.scheduledFor) || (run.nextFireAt !== undefined && !Number.isFinite(run.nextFireAt))) {
        throw new Error(`Scheduled task ${taskId} has an invalid materialization timestamp.`);
      }

      const offset = index * 4;
      values.push(
        randomUUID(),
        taskId,
        new Date(run.scheduledFor),
        run.nextFireAt === undefined ? null : new Date(run.nextFireAt),
      );
      return `($${offset + 1}::uuid, $${offset + 2}::uuid, $${offset + 3}::timestamptz, $${offset + 4}::timestamptz)`;
    });

    // Lock definitions before inserting occurrences. The active-task unique
    // index is the final cross-daemon fence, while advancing only rows actually
    // inserted prevents a blocked recurring task from losing a scheduled fire.
    const result = await this.pool.query(`
      WITH requested (run_id, task_id, scheduled_for, next_fire_at) AS (
        VALUES ${requestedRows.join(",\n               ")}
      ),
      locked_sessions AS MATERIALIZED (
        SELECT session.id
        FROM ${this.sessionTables.sessions} AS session
        WHERE session.id IN (
          SELECT task.session_id
          FROM requested
          INNER JOIN ${this.tables.scheduledTasks} AS task ON task.id = requested.task_id
        )
          AND session.archived_at IS NULL
        ORDER BY session.id
        FOR UPDATE
      ),
      eligible AS MATERIALIZED (
        SELECT
          requested.run_id,
          requested.scheduled_for,
          requested.next_fire_at,
          task.id AS task_id,
          task.session_id,
          task.created_by_identity_id
        FROM requested
        INNER JOIN ${this.tables.scheduledTasks} AS task ON task.id = requested.task_id
        INNER JOIN locked_sessions AS session ON session.id = task.session_id
        WHERE task.enabled = TRUE
          AND task.cancelled_at IS NULL
          AND task.completed_at IS NULL
          AND task.next_fire_at = requested.scheduled_for
          AND task.next_fire_at <= NOW()
          AND NOT EXISTS (
            SELECT 1
            FROM ${this.tables.scheduledTaskRuns} AS active_run
            WHERE active_run.task_id = task.id
              AND active_run.status IN ('pending', 'claimed', 'running')
          )
        ORDER BY task.next_fire_at ASC, task.id ASC
        FOR UPDATE OF task SKIP LOCKED
      ),
      inserted_runs AS (
        INSERT INTO ${this.tables.scheduledTaskRuns} (
          id,
          task_id,
          session_id,
          created_by_identity_id,
          scheduled_for,
          status
        )
        SELECT
          run_id,
          task_id,
          session_id,
          created_by_identity_id,
          scheduled_for,
          'pending'
        FROM eligible
        ON CONFLICT DO NOTHING
        RETURNING *
      ),
      advanced_tasks AS (
        UPDATE ${this.tables.scheduledTasks} AS task
        SET next_fire_at = eligible.next_fire_at,
            updated_at = NOW()
        FROM eligible
        INNER JOIN inserted_runs ON inserted_runs.id = eligible.run_id
        WHERE task.id = eligible.task_id
          AND task.enabled = TRUE
          AND task.cancelled_at IS NULL
          AND task.completed_at IS NULL
          AND task.next_fire_at = eligible.scheduled_for
        RETURNING task.id
      )
      SELECT inserted_runs.*
      FROM inserted_runs
      INNER JOIN advanced_tasks ON advanced_tasks.id = inserted_runs.task_id
    `, values);

    return result.rows.map((row) => parseTaskRunRow(row as Record<string, unknown>));
  }

  async claimTaskRun(input: ClaimScheduledTaskRunInput): Promise<ClaimScheduledTaskResult | null> {
    if (!Number.isFinite(input.claimTtlMs) || input.claimTtlMs <= 0) {
      throw new Error("Scheduled task claim TTL must be positive.");
    }

    const result = await this.pool.query(`
      WITH candidate_session AS MATERIALIZED (
        SELECT session.id
        FROM ${this.sessionTables.sessions} AS session
        WHERE session.archived_at IS NULL
          AND EXISTS (
            SELECT 1
            FROM ${this.tables.scheduledTaskRuns} AS run
            INNER JOIN ${this.tables.scheduledTasks} AS task ON task.id = run.task_id
            WHERE task.session_id = session.id
              AND run.status IN ('pending', 'claimed', 'running')
              AND (run.status IN ('claimed', 'running') OR task.cancelled_at IS NULL)
              AND (run.claim_token IS NULL OR run.claim_expires_at IS NULL OR run.claim_expires_at <= NOW())
          )
        ORDER BY (
          SELECT MIN(run.scheduled_for)
          FROM ${this.tables.scheduledTaskRuns} AS run
          INNER JOIN ${this.tables.scheduledTasks} AS task ON task.id = run.task_id
          WHERE task.session_id = session.id
            AND run.status IN ('pending', 'claimed', 'running')
        ), session.id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      ), candidate AS (
        SELECT run.id
        FROM candidate_session AS session
        INNER JOIN ${this.tables.scheduledTasks} AS task ON task.session_id = session.id
        INNER JOIN ${this.tables.scheduledTaskRuns} AS run ON run.task_id = task.id
        WHERE run.status IN ('pending', 'claimed', 'running')
          AND (run.status IN ('claimed', 'running') OR task.cancelled_at IS NULL)
          AND (
            run.claim_token IS NULL
            OR run.claim_expires_at IS NULL
            OR run.claim_expires_at <= NOW()
          )
        ORDER BY run.scheduled_for ASC, run.id ASC
        FOR UPDATE OF run SKIP LOCKED
        LIMIT 1
      ),
      claimed AS (
        UPDATE ${this.tables.scheduledTaskRuns} AS run
        SET status = CASE WHEN run.status = 'pending' THEN 'claimed' ELSE run.status END,
            claim_token = $1,
            claimed_at = NOW(),
            claimed_by = $2,
            claim_expires_at = NOW() + ($3 * INTERVAL '1 millisecond')
        FROM candidate
        WHERE run.id = candidate.id
        RETURNING run.*
      )
      SELECT
        claimed.*,
        ${selectTaskRowColumns("task")}
      FROM claimed
      INNER JOIN ${this.tables.scheduledTasks} AS task ON task.id = claimed.task_id
    `, [
      randomUUID(),
      requireScheduledTaskString("claim owner", input.claimedBy),
      input.claimTtlMs,
    ]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }

    return {
      task: parseTaskRow(extractTaskRow(row)),
      run: parseClaimedTaskRunRow(row),
    };
  }

  async renewTaskRunClaim(input: RenewScheduledTaskRunClaimInput): Promise<ScheduledTaskRunRecord | null> {
    if (!Number.isFinite(input.claimTtlMs) || input.claimTtlMs <= 0) {
      throw new Error("Scheduled task claim TTL must be positive.");
    }
    const result = await this.pool.query(`
      UPDATE ${this.tables.scheduledTaskRuns}
      SET claim_expires_at = NOW() + ($3 * INTERVAL '1 millisecond')
      WHERE id = $1
        AND claim_token = $2
        AND status IN ('claimed', 'running')
        AND claim_expires_at > NOW()
      RETURNING *
    `, [
      requireScheduledTaskString("run id", input.runId),
      requireScheduledTaskString("claim token", input.claimToken),
      input.claimTtlMs,
    ]);
    const row = result.rows[0];
    return row ? parseTaskRunRow(row as Record<string, unknown>) : null;
  }

  async startTaskRun(input: StartScheduledTaskRunInput): Promise<ScheduledTaskRunRecord> {
    // Occurrence id is the durable input idempotency key. Deriving the join
    // here prevents callers from linking a different input after a crash.
    const result = await this.pool.query(
      `
        UPDATE ${this.tables.scheduledTaskRuns} AS scheduled_run
        SET status = 'running',
            resolved_thread_id = thread_input.thread_id,
            resolved_thread_session_id = scheduled_run.session_id,
            thread_input_id = scheduled_run.id,
            thread_input_thread_id = thread_input.thread_id,
            lineage_recorded_at = COALESCE(scheduled_run.lineage_recorded_at, NOW()),
            started_at = COALESCE(started_at, NOW())
        FROM ${this.threadTables.inputs} AS thread_input
        INNER JOIN ${this.threadTables.threads} AS thread
          ON thread.id = thread_input.thread_id
        WHERE scheduled_run.id = $1
          AND scheduled_run.claim_token = $2
          AND scheduled_run.status IN ('claimed', 'running')
          AND scheduled_run.claim_expires_at > NOW()
          AND thread_input.id = scheduled_run.id
          AND thread_input.source = 'scheduled_task'
          AND thread_input.external_message_id = scheduled_run.id::text
          AND thread.session_id = scheduled_run.session_id
          AND (scheduled_run.thread_input_id IS NULL OR scheduled_run.thread_input_id = scheduled_run.id)
          AND (scheduled_run.resolved_thread_id IS NULL OR scheduled_run.resolved_thread_id = thread_input.thread_id)
        RETURNING scheduled_run.*
      `,
      [
        requireScheduledTaskString("run id", input.runId),
        requireScheduledTaskString("claim token", input.claimToken),
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw rejectedTaskRunMutationError(input.runId, "link the submitted input");
    }

    return parseTaskRunRow(row as Record<string, unknown>);
  }

  async completeTaskRun(input: CompleteScheduledTaskRunInput): Promise<ScheduledTaskRunRecord> {
    return this.settleTaskRun({
      runId: input.runId,
      claimToken: input.claimToken,
      status: "succeeded",
      threadRunId: input.threadRunId,
    });
  }

  async failTaskRun(input: FailScheduledTaskRunInput): Promise<ScheduledTaskRunRecord> {
    return this.settleTaskRun({
      runId: input.runId,
      claimToken: input.claimToken,
      status: "failed",
      threadRunId: input.threadRunId,
      error: input.error,
    });
  }

  private async settleTaskRun(input: {
    runId: string;
    claimToken: string;
    status: "succeeded" | "failed";
    threadRunId?: string;
    error?: string;
  }): Promise<ScheduledTaskRunRecord> {
    // Both data-modifying CTEs execute once as one PostgreSQL statement. The
    // receipt predicate also makes the input's applied_run_id—not thread timing
    // or history—the only run that can settle this occurrence.
    const result = await this.pool.query(`
      WITH settled_run AS (
        UPDATE ${this.tables.scheduledTaskRuns} AS scheduled_run
        SET status = $3,
            thread_run_id = COALESCE($4, scheduled_run.thread_run_id),
            thread_run_thread_id = CASE
              WHEN COALESCE($4, scheduled_run.thread_run_id) IS NULL THEN NULL
              ELSE scheduled_run.resolved_thread_id
            END,
            error = $5,
            finished_at = NOW(),
            claim_token = NULL,
            claim_expires_at = NULL
        WHERE scheduled_run.id = $1
          AND scheduled_run.claim_token = $2
          AND scheduled_run.status IN ('claimed', 'running')
          AND scheduled_run.claim_expires_at > NOW()
          AND (
            (
              $3 = 'failed'
              AND $4::uuid IS NULL
              AND (
                (
                  scheduled_run.status = 'claimed'
                  AND scheduled_run.thread_input_id IS NULL
                  AND NOT EXISTS (
                    SELECT 1
                    FROM ${this.threadTables.inputs} AS exact_input
                    WHERE exact_input.id = scheduled_run.id
                      AND exact_input.discarded_at IS NULL
                      AND exact_input.source = 'scheduled_task'
                      AND exact_input.external_message_id = scheduled_run.id::text
                  )
                )
                OR (
                  scheduled_run.status = 'running'
                  AND EXISTS (
                    SELECT 1
                    FROM ${this.threadTables.inputs} AS discarded_input
                    WHERE discarded_input.id = scheduled_run.thread_input_id
                      AND discarded_input.discarded_at IS NOT NULL
                  )
                )
              )
            )
            OR EXISTS (
              SELECT 1
              FROM ${this.threadTables.inputs} AS thread_input
              INNER JOIN ${this.threadTables.runs} AS thread_run
                ON thread_run.id = thread_input.applied_run_id
              WHERE thread_input.id = scheduled_run.thread_input_id
                AND thread_input.thread_id = scheduled_run.resolved_thread_id
                AND thread_run.id = $4::uuid
                AND thread_run.thread_id = scheduled_run.resolved_thread_id
                AND (
                  ($3 = 'succeeded' AND thread_run.status = 'completed')
                  OR ($3 = 'failed' AND thread_run.status = 'failed')
                )
            )
          )
        RETURNING scheduled_run.*
      ),
      settled_task AS (
        UPDATE ${this.tables.scheduledTasks} AS task
        SET completed_at = CASE
              WHEN task.schedule_kind = 'once' AND task.cancelled_at IS NULL THEN NOW()
              ELSE task.completed_at
            END,
            next_fire_at = CASE
              WHEN task.schedule_kind = 'once' THEN NULL
              ELSE task.next_fire_at
            END,
            updated_at = CASE
              WHEN task.schedule_kind = 'once' THEN NOW()
              ELSE task.updated_at
            END
        FROM settled_run
        WHERE task.id = settled_run.task_id
        RETURNING task.id
      )
      SELECT settled_run.*
      FROM settled_run
      INNER JOIN settled_task ON settled_task.id = settled_run.task_id
    `, [
      requireScheduledTaskString("run id", input.runId),
      requireScheduledTaskString("claim token", input.claimToken),
      input.status,
      input.threadRunId ?? null,
      input.status === "failed" ? requireScheduledTaskString("error", input.error) : null,
    ]);
    const row = result.rows[0];
    if (!row) {
      throw rejectedTaskRunMutationError(input.runId, "settle");
    }

    return parseTaskRunRow(row as Record<string, unknown>);
  }

}
