import type {PgQueryable} from "../../lib/postgres-query.js";
import {requireNonEmptyString} from "../../lib/strings.js";
import {buildAgentTableNames} from "../agents/postgres-shared.js";
import {buildScheduledTaskTableNames} from "../scheduling/tasks/postgres-shared.js";
import type {ScheduledTaskRunStatus, ScheduledTaskSchedule} from "../scheduling/tasks/types.js";
import {buildSessionTableNames} from "../sessions/postgres-shared.js";
import {buildControlTableNames} from "./postgres-shared.js";
import type {ControlSessionRecord} from "./types.js";

const DEFAULT_TASK_LIMIT = 25;
const MAX_TASK_LIMIT = 100;
const RECENT_RUN_LIMIT = 3;

export type ControlScheduledTaskLifecycleStatus = "scheduled" | "disabled" | "running" | "completed" | "cancelled";

export interface ControlScheduledTaskRun {
  id: string;
  status: ScheduledTaskRunStatus;
  scheduledFor: string;
  startedAt: string | null;
  finishedAt: string | null;
  resolvedThreadId?: string;
  threadRunId?: string;
}

export interface ControlScheduledTask {
  id: string;
  title: string;
  schedule: ScheduledTaskSchedule;
  enabled: boolean;
  lifecycleStatus: ControlScheduledTaskLifecycleStatus;
  nextFireAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
  recentRuns: readonly ControlScheduledTaskRun[];
}

export interface ControlScheduledTasksRecord {
  agentKey: string;
  sessionId: string;
  tasks: readonly ControlScheduledTask[];
}

export interface GetScheduledTasksInput {
  limit?: number;
}

type TaskRow = Record<string, unknown>;
type RunRow = Record<string, unknown>;

function toIso(value: unknown, label: string): string {
  const millis = value instanceof Date ? value.getTime() : typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(millis)) throw new Error(`${label} must be a valid timestamp.`);
  return new Date(millis).toISOString();
}

function optionalIso(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  return toIso(value, label);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is missing.`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function lifecycleStatus(row: TaskRow): ControlScheduledTaskLifecycleStatus {
  if (row.cancelled_at) return "cancelled";
  if (row.completed_at) return "completed";
  if (row.claimed_at) return "running";
  if (row.enabled === false) return "disabled";
  return "scheduled";
}

function publicSchedule(row: TaskRow): ScheduledTaskSchedule {
  const kind = requiredString(row.schedule_kind, "Schedule kind");
  if (kind === "once") {
    return {kind, runAt: toIso(row.run_at, "Scheduled task run_at")};
  }
  if (kind === "recurring") {
    return {
      kind,
      cron: requiredString(row.cron_expr, "Scheduled task cron"),
      timezone: requiredString(row.timezone, "Scheduled task timezone"),
    };
  }
  throw new Error(`Unsupported scheduled task schedule kind ${kind}.`);
}

function parseLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TASK_LIMIT;
  if (!Number.isInteger(value) || value < 1) throw new Error("Control scheduled tasks limit must be a positive integer.");
  return Math.min(MAX_TASK_LIMIT, value);
}

function publicRun(row: RunRow): ControlScheduledTaskRun {
  return {
    id: requiredString(row.id, "Scheduled task run id"),
    status: requiredString(row.status, "Scheduled task run status") as ScheduledTaskRunStatus,
    scheduledFor: toIso(row.scheduled_for, "Scheduled task run scheduled_for"),
    startedAt: optionalIso(row.started_at, "Scheduled task run started_at"),
    finishedAt: optionalIso(row.finished_at, "Scheduled task run finished_at"),
    ...(optionalString(row.resolved_thread_id) ? {resolvedThreadId: optionalString(row.resolved_thread_id)} : {}),
    ...(optionalString(row.thread_run_id) ? {threadRunId: optionalString(row.thread_run_id)} : {}),
  };
}

function publicTask(row: TaskRow, runs: readonly ControlScheduledTaskRun[]): ControlScheduledTask {
  return {
    id: requiredString(row.id, "Scheduled task id"),
    title: requiredString(row.title, "Scheduled task title"),
    schedule: publicSchedule(row),
    enabled: row.enabled === true,
    lifecycleStatus: lifecycleStatus(row),
    nextFireAt: optionalIso(row.next_fire_at, "Scheduled task next_fire_at"),
    completedAt: optionalIso(row.completed_at, "Scheduled task completed_at"),
    cancelledAt: optionalIso(row.cancelled_at, "Scheduled task cancelled_at"),
    createdAt: toIso(row.created_at, "Scheduled task created_at"),
    updatedAt: toIso(row.updated_at, "Scheduled task updated_at"),
    recentRuns: runs,
  };
}

export class ControlScheduledTasksService {
  private readonly pool: PgQueryable;
  private readonly agents = buildAgentTableNames();
  private readonly sessionTables = buildSessionTableNames();
  private readonly control = buildControlTableNames();
  private readonly scheduled = buildScheduledTaskTableNames();

  constructor(options: {pool: PgQueryable}) {
    this.pool = options.pool;
  }

  private async assertCanAccess(session: ControlSessionRecord, agentKey: string, targetSessionId: string): Promise<void> {
    const normalizedAgentKey = requireNonEmptyString(agentKey, "Agent key is required.");
    const normalizedSessionId = requireNonEmptyString(targetSessionId, "Session id is required.");
    const result = await this.pool.query(`
      SELECT 1
      FROM ${this.sessionTables.sessions} AS target_session
      INNER JOIN ${this.agents.agentPairings} AS pairing
        ON pairing.agent_key = target_session.agent_key
       AND pairing.identity_id = $1
      INNER JOIN ${this.control.grants} AS grant_row
        ON grant_row.identity_id = $1
       AND grant_row.active = TRUE
       AND (grant_row.role = 'admin' OR (grant_row.role = 'scoped' AND grant_row.agent_key = target_session.agent_key))
      WHERE target_session.id = $2
        AND target_session.agent_key = $3
      LIMIT 1
    `, [session.identityId, normalizedSessionId, normalizedAgentKey]);
    if (result.rows.length === 0) {
      throw new Error("Control scheduled tasks target session was not found or is not visible.");
    }
  }

  async getScheduledTasks(session: ControlSessionRecord, agentKey: string, targetSessionId: string, input: GetScheduledTasksInput = {}): Promise<ControlScheduledTasksRecord> {
    const limit = parseLimit(input.limit);
    await this.assertCanAccess(session, agentKey, targetSessionId);
    const normalizedAgentKey = requireNonEmptyString(agentKey, "Agent key is required.");
    const normalizedSessionId = requireNonEmptyString(targetSessionId, "Session id is required.");

    const taskResult = await this.pool.query(`
      SELECT
        id,
        title,
        schedule_kind,
        run_at,
        cron_expr,
        timezone,
        enabled,
        claimed_at,
        next_fire_at,
        completed_at,
        cancelled_at,
        created_at,
        updated_at
      FROM ${this.scheduled.scheduledTasks}
      WHERE session_id = $1
      ORDER BY next_fire_at ASC NULLS LAST, created_at DESC, id ASC
      LIMIT $2
    `, [normalizedSessionId, limit]);

    const taskIds = taskResult.rows.map((row) => requiredString((row as TaskRow).id, "Scheduled task id"));
    const runsByTaskId = new Map<string, ControlScheduledTaskRun[]>();
    for (const taskId of taskIds) {
      const runResult = await this.pool.query(`
        SELECT
          id,
          task_id,
          status,
          scheduled_for,
          started_at,
          finished_at,
          resolved_thread_id,
          thread_run_id
        FROM ${this.scheduled.scheduledTaskRuns}
        WHERE session_id = $1
          AND task_id = $2
        ORDER BY created_at DESC, id ASC
        LIMIT $3
      `, [normalizedSessionId, taskId, RECENT_RUN_LIMIT]);
      runsByTaskId.set(taskId, (runResult.rows as RunRow[]).map(publicRun));
    }

    return {
      agentKey: normalizedAgentKey,
      sessionId: normalizedSessionId,
      tasks: (taskResult.rows as TaskRow[]).map((row) => publicTask(row, runsByTaskId.get(requiredString(row.id, "Scheduled task id")) ?? [])),
    };
  }
}
