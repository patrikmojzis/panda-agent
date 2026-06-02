import {createHash} from "node:crypto";

import type {PgQueryable} from "../../lib/postgres-query.js";
import {requireNonEmptyString} from "../../lib/strings.js";
import {buildAgentTableNames} from "../agents/postgres-shared.js";
import {buildScheduledTaskTableNames} from "../scheduling/tasks/postgres-shared.js";
import {normalizeScheduledTaskSchedule} from "../scheduling/tasks/schedule.js";
import type {ScheduledTaskStore} from "../scheduling/tasks/store.js";
import type {ScheduledTaskRecord, ScheduledTaskRunStatus, ScheduledTaskSchedule} from "../scheduling/tasks/types.js";
import {buildSessionTableNames} from "../sessions/postgres-shared.js";
import {buildControlTableNames} from "./postgres-shared.js";
import type {ControlSessionRecord} from "./types.js";

const DEFAULT_TASK_LIMIT = 25;
const MAX_TASK_LIMIT = 100;
const RECENT_RUN_LIMIT = 3;

export type ControlScheduledTaskLifecycleStatus = "scheduled" | "disabled" | "running" | "completed" | "cancelled";
export type ControlScheduledTaskSortDirection = "asc" | "desc";

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
  data: readonly ControlScheduledTask[];
  meta: ControlScheduledTasksTableMeta;
  tasks: readonly ControlScheduledTask[];
}

export interface GetScheduledTasksInput {
  page?: number;
  perPage?: number;
  sortBy?: string;
  sortDirection?: ControlScheduledTaskSortDirection;
  search?: string;
  lifecycleStatus?: ControlScheduledTaskLifecycleStatus;
  enabled?: boolean;
  limit?: number;
}

export interface ControlScheduledTasksTableMeta {
  current_page: number;
  last_page: number;
  total: number;
  per_page: number;
}

export interface CreateControlScheduledTaskInput {
  title?: unknown;
  instruction?: unknown;
  schedule?: unknown;
  enabled?: unknown;
}

export interface UpdateControlScheduledTaskInput {
  title?: unknown;
  instruction?: unknown;
  schedule?: unknown;
  enabled?: unknown;
}

export interface CancelControlScheduledTaskInput {
  reason?: unknown;
}

export interface ControlScheduledTaskWriteResult {
  scheduledTask: ControlScheduledTask;
  audit: Record<string, unknown>;
}

type TaskRow = Record<string, unknown>;
type RunRow = Record<string, unknown>;
type ControlScheduledTaskStore = Pick<ScheduledTaskStore, "createTask" | "updateTask" | "cancelTask">;

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

function pageInput(input: GetScheduledTasksInput): {page: number; perPage: number} {
  const page = input.page ?? 1;
  const perPage = input.perPage ?? input.limit ?? DEFAULT_TASK_LIMIT;
  if (!Number.isInteger(page) || page < 1) throw new Error("Control scheduled tasks page must be a positive integer.");
  if (!Number.isInteger(perPage) || perPage < 1) throw new Error("Control scheduled tasks per_page must be a positive integer.");
  return {page, perPage: Math.min(MAX_TASK_LIMIT, perPage)};
}

function normalizeSearch(value: string | undefined): string {
  return value?.trim() ?? "";
}

function lifecycleStatusExpression(): string {
  return `
    CASE
      WHEN cancelled_at IS NOT NULL THEN 'cancelled'
      WHEN completed_at IS NOT NULL THEN 'completed'
      WHEN claimed_at IS NOT NULL THEN 'running'
      WHEN enabled = FALSE THEN 'disabled'
      ELSE 'scheduled'
    END
  `;
}

function scheduleSortExpression(): string {
  return `
    CASE
      WHEN schedule_kind = 'once' THEN COALESCE(run_at::text, '')
      WHEN schedule_kind = 'recurring' THEN CONCAT(COALESCE(cron_expr, ''), ' ', COALESCE(timezone, ''))
      ELSE COALESCE(schedule_kind, '')
    END
  `;
}

function sortExpression(sortBy: string | undefined): string {
  switch (sortBy) {
    case "title":
      return "title";
    case "enabled":
      return "enabled";
    case "lifecycleStatus":
      return lifecycleStatusExpression();
    case "schedule":
      return scheduleSortExpression();
    case "nextFireAt":
      return "next_fire_at";
    case "createdAt":
      return "created_at";
    case "updatedAt":
      return "updated_at";
    case "completedAt":
      return "completed_at";
    case "cancelledAt":
      return "cancelled_at";
    default:
      return "next_fire_at";
  }
}

function tableMeta(page: number, perPage: number, total: number): ControlScheduledTasksTableMeta {
  return {
    current_page: page,
    last_page: Math.max(1, Math.ceil(total / perPage)),
    total,
    per_page: perPage,
  };
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

function lifecycleStatusFromRecord(record: ScheduledTaskRecord): ControlScheduledTaskLifecycleStatus {
  if (record.cancelledAt) return "cancelled";
  if (record.completedAt) return "completed";
  if (record.claimedAt) return "running";
  if (!record.enabled) return "disabled";
  return "scheduled";
}

function publicTaskRecord(record: ScheduledTaskRecord, runs: readonly ControlScheduledTaskRun[] = []): ControlScheduledTask {
  return {
    id: record.id,
    title: record.title,
    schedule: record.schedule,
    enabled: record.enabled,
    lifecycleStatus: lifecycleStatusFromRecord(record),
    nextFireAt: optionalIso(record.nextFireAt, "Scheduled task nextFireAt"),
    completedAt: optionalIso(record.completedAt, "Scheduled task completedAt"),
    cancelledAt: optionalIso(record.cancelledAt, "Scheduled task cancelledAt"),
    createdAt: toIso(record.createdAt, "Scheduled task createdAt"),
    updatedAt: toIso(record.updatedAt, "Scheduled task updatedAt"),
    recentRuns: runs,
  };
}

function requiredInputString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  return requireNonEmptyString(value, `${label} is required.`);
}

function optionalInputString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function optionalInputBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean.`);
  return value;
}

function requiredInputSchedule(value: unknown): ScheduledTaskSchedule {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Scheduled task schedule is required.");
  return normalizeScheduledTaskSchedule(value as ScheduledTaskSchedule);
}

function optionalInputSchedule(value: unknown): ScheduledTaskSchedule | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredInputSchedule(value);
}

function contentSummary(value: string): {length: number; sha256: string} {
  return {
    length: value.length,
    sha256: createHash("sha256").update(value).digest("hex"),
  };
}

function scheduleSummary(schedule: ScheduledTaskSchedule): Record<string, unknown> {
  if (schedule.kind === "once") return {kind: schedule.kind, runAt: schedule.runAt};
  return {kind: schedule.kind, cron: schedule.cron, timezone: schedule.timezone};
}

export class ControlScheduledTasksService {
  private readonly pool: PgQueryable;
  private readonly store: ControlScheduledTaskStore;
  private readonly agents = buildAgentTableNames();
  private readonly sessionTables = buildSessionTableNames();
  private readonly control = buildControlTableNames();
  private readonly scheduled = buildScheduledTaskTableNames();

  constructor(options: {pool: PgQueryable; store: ControlScheduledTaskStore}) {
    this.pool = options.pool;
    this.store = options.store;
  }

  private async assertCanAccess(session: ControlSessionRecord, agentKey: string, targetSessionId: string): Promise<void> {
    const normalizedAgentKey = requireNonEmptyString(agentKey, "Agent key is required.");
    const normalizedSessionId = requireNonEmptyString(targetSessionId, "Session id is required.");
    const result = await this.pool.query(`
      SELECT 1
      FROM ${this.sessionTables.sessions} AS target_session
      INNER JOIN ${this.control.grants} AS grant_row
        ON grant_row.identity_id = $1
       AND grant_row.active = TRUE
       AND grant_row.role = $4
       AND (grant_row.role = 'admin' OR grant_row.agent_key = target_session.agent_key)
      LEFT JOIN ${this.agents.agentPairings} AS pairing
        ON pairing.agent_key = target_session.agent_key
       AND pairing.identity_id = $1
      WHERE target_session.id = $2
        AND target_session.agent_key = $3
        AND (grant_row.role = 'admin' OR pairing.identity_id IS NOT NULL)
      LIMIT 1
    `, [session.identityId, normalizedSessionId, normalizedAgentKey, session.role]);
    if (result.rows.length === 0) {
      throw new Error("Control scheduled tasks target session was not found or is not visible.");
    }
  }

  async getScheduledTasks(session: ControlSessionRecord, agentKey: string, targetSessionId: string, input: GetScheduledTasksInput = {}): Promise<ControlScheduledTasksRecord> {
    const {page, perPage} = pageInput(input);
    const search = normalizeSearch(input.search);
    await this.assertCanAccess(session, agentKey, targetSessionId);
    const normalizedAgentKey = requireNonEmptyString(agentKey, "Agent key is required.");
    const normalizedSessionId = requireNonEmptyString(targetSessionId, "Session id is required.");
    const where = ["session_id = $1"];
    const values: unknown[] = [normalizedSessionId];
    if (search) {
      values.push(`%${search}%`);
      const searchParam = `$${values.length}`;
      where.push(`(
        id::text ILIKE ${searchParam}
        OR title ILIKE ${searchParam}
        OR schedule_kind ILIKE ${searchParam}
        OR COALESCE(cron_expr, '') ILIKE ${searchParam}
        OR COALESCE(timezone, '') ILIKE ${searchParam}
      )`);
    }
    if (input.lifecycleStatus) {
      values.push(input.lifecycleStatus);
      where.push(`${lifecycleStatusExpression()} = $${values.length}`);
    }
    if (input.enabled !== undefined) {
      values.push(input.enabled);
      where.push(`enabled = $${values.length}`);
    }
    const whereClause = where.join("\n        AND ");
    const countResult = await this.pool.query(`
      SELECT COUNT(*)::INTEGER AS count
      FROM ${this.scheduled.scheduledTasks}
      WHERE ${whereClause}
    `, values);
    const total = Number((countResult.rows[0] as Record<string, unknown> | undefined)?.count ?? 0);
    values.push(perPage, (page - 1) * perPage);
    const direction = input.sortDirection === "desc" ? "DESC" : "ASC";

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
      WHERE ${whereClause}
      ORDER BY ${sortExpression(input.sortBy)} ${direction} NULLS LAST, id ASC
      LIMIT $${values.length - 1}
      OFFSET $${values.length}
    `, values);

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

    const data = (taskResult.rows as TaskRow[]).map((row) => publicTask(row, runsByTaskId.get(requiredString(row.id, "Scheduled task id")) ?? []));
    return {
      agentKey: normalizedAgentKey,
      sessionId: normalizedSessionId,
      data,
      meta: tableMeta(page, perPage, total),
      tasks: data,
    };
  }

  async createScheduledTask(
    session: ControlSessionRecord,
    agentKey: string,
    targetSessionId: string,
    input: CreateControlScheduledTaskInput,
  ): Promise<ControlScheduledTaskWriteResult> {
    await this.assertCanAccess(session, agentKey, targetSessionId);
    const normalizedAgentKey = requireNonEmptyString(agentKey, "Agent key is required.");
    const normalizedSessionId = requireNonEmptyString(targetSessionId, "Session id is required.");
    const title = requiredInputString(input.title, "Scheduled task title");
    const instruction = requiredInputString(input.instruction, "Scheduled task instruction");
    const schedule = requiredInputSchedule(input.schedule);
    const enabled = optionalInputBoolean(input.enabled, "Scheduled task enabled");
    const created = await this.store.createTask({
      sessionId: normalizedSessionId,
      createdByIdentityId: session.identityId,
      title,
      instruction,
      schedule,
      ...(enabled !== undefined ? {enabled} : {}),
    });

    return {
      scheduledTask: publicTaskRecord(created),
      audit: {
        action: "create_scheduled_task",
        agentKey: normalizedAgentKey,
        targetSessionId: normalizedSessionId,
        taskId: created.id,
        title,
        schedule: scheduleSummary(schedule),
        enabled: created.enabled,
        instruction: contentSummary(instruction),
      },
    };
  }

  async updateScheduledTask(
    session: ControlSessionRecord,
    agentKey: string,
    targetSessionId: string,
    taskId: string,
    input: UpdateControlScheduledTaskInput,
  ): Promise<ControlScheduledTaskWriteResult> {
    await this.assertCanAccess(session, agentKey, targetSessionId);
    const normalizedAgentKey = requireNonEmptyString(agentKey, "Agent key is required.");
    const normalizedSessionId = requireNonEmptyString(targetSessionId, "Session id is required.");
    const normalizedTaskId = requireNonEmptyString(taskId, "Scheduled task id is required.");
    const title = optionalInputString(input.title, "Scheduled task title");
    const instruction = optionalInputString(input.instruction, "Scheduled task instruction");
    const schedule = optionalInputSchedule(input.schedule);
    const enabled = optionalInputBoolean(input.enabled, "Scheduled task enabled");
    const updated = await this.store.updateTask({
      taskId: normalizedTaskId,
      sessionId: normalizedSessionId,
      ...(title !== undefined ? {title} : {}),
      ...(instruction !== undefined ? {instruction} : {}),
      ...(schedule !== undefined ? {schedule} : {}),
      ...(enabled !== undefined ? {enabled} : {}),
    });

    return {
      scheduledTask: publicTaskRecord(updated),
      audit: {
        action: "update_scheduled_task",
        agentKey: normalizedAgentKey,
        targetSessionId: normalizedSessionId,
        taskId: updated.id,
        ...(title !== undefined ? {title} : {}),
        ...(schedule !== undefined ? {schedule: scheduleSummary(schedule)} : {}),
        ...(enabled !== undefined ? {enabled} : {}),
        ...(instruction !== undefined ? {instruction: contentSummary(instruction)} : {}),
      },
    };
  }

  async cancelScheduledTask(
    session: ControlSessionRecord,
    agentKey: string,
    targetSessionId: string,
    taskId: string,
    input: CancelControlScheduledTaskInput = {},
  ): Promise<ControlScheduledTaskWriteResult> {
    await this.assertCanAccess(session, agentKey, targetSessionId);
    const normalizedAgentKey = requireNonEmptyString(agentKey, "Agent key is required.");
    const normalizedSessionId = requireNonEmptyString(targetSessionId, "Session id is required.");
    const normalizedTaskId = requireNonEmptyString(taskId, "Scheduled task id is required.");
    const reason = optionalInputString(input.reason, "Scheduled task cancel reason");
    const cancelled = await this.store.cancelTask({
      taskId: normalizedTaskId,
      sessionId: normalizedSessionId,
      ...(reason ? {reason} : {}),
    });

    return {
      scheduledTask: publicTaskRecord(cancelled),
      audit: {
        action: "cancel_scheduled_task",
        agentKey: normalizedAgentKey,
        targetSessionId: normalizedSessionId,
        taskId: cancelled.id,
        ...(reason ? {reason: contentSummary(reason)} : {}),
      },
    };
  }
}
