import type {PgQueryable} from "../../lib/postgres-query.js";
import {buildAgentTableNames} from "../agents/postgres-shared.js";
import {buildScheduledTaskTableNames} from "../scheduling/tasks/postgres-shared.js";
import {buildSessionTableNames} from "../sessions/postgres-shared.js";
import {buildControlTableNames} from "./postgres-shared.js";
import type {ControlSessionRecord} from "./types.js";
import type {ControlAuditEventSummary, ControlReadService} from "./read-service.js";

const SESSION_LIMIT = 25;
const ATTENTION_LIMIT = 20;
const UPCOMING_LIMIT = 10;
const RECENT_ACTIVITY_LIMIT = 8;
const TASK_ROWS_PER_SESSION_LIMIT = ATTENTION_LIMIT + UPCOMING_LIMIT;

type ControlHomeStatusLevel = "ok" | "attention";
type ControlHomeAttentionSeverity = "info" | "warning" | "critical";
type ControlHomeAttentionType = "failed_task" | "overdue_task";

export interface ControlHomeAgentScope {
  agentKey: string;
  displayName: string;
  paired: boolean;
  sessionCount: number;
}

export interface ControlHomeAttentionItem {
  id: string;
  severity: ControlHomeAttentionSeverity;
  type: ControlHomeAttentionType;
  agentKey: string;
  sessionId: string;
  sessionLabel: string;
  summary: string;
  targetRoute: string;
  createdAt?: string;
  dueAt?: string;
}

export interface ControlHomeSessionSummary {
  agentKey: string;
  sessionId: string;
  label: string;
  kind: string;
  heartbeat: {enabled: boolean; everyMinutes: number; nextFireAt: string | null; lastFireAt?: string};
  nextTaskAt: string | null;
  lastTaskStatus: string | null;
  links: {watches: string; runtimeActivity: string; scheduledTasks: string; heartbeat: string; briefing: string};
}

export interface ControlHomeUpcomingAutomation {
  taskId: string;
  agentKey: string;
  sessionId: string;
  title: string;
  lifecycleStatus: string;
  nextFireAt: string | null;
  scheduleKind: string;
  targetRoute: string;
}

export interface ControlHome {
  generatedAt: string;
  scope: {
    identityId: string;
    role: "admin" | "scoped";
    visibleAgentCount: number;
    visibleSessionCount: number;
    agents: ControlHomeAgentScope[];
  };
  status: {level: ControlHomeStatusLevel; reasonCodes: string[]};
  attentionItems: ControlHomeAttentionItem[];
  sessions: ControlHomeSessionSummary[];
  upcomingAutomations: ControlHomeUpcomingAutomation[];
  recentActivity: ControlAuditEventSummary[];
}

type VisibleSessionRow = Record<string, unknown>;
type TaskRow = Record<string, unknown>;
type RunRow = Record<string, unknown>;

function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const millis = value instanceof Date ? value.getTime() : typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

function labelForSession(row: VisibleSessionRow): string {
  for (const key of ["display_name", "alias", "session_id"] as const) {
    const value = row[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return "session";
}

function lifecycleStatus(row: TaskRow): string {
  if (row.cancelled_at) return "cancelled";
  if (row.completed_at) return "completed";
  if (row.claimed_at) return "running";
  if (row.enabled === false) return "disabled";
  return "scheduled";
}

function severityRank(severity: ControlHomeAttentionSeverity): number {
  if (severity === "critical") return 0;
  if (severity === "warning") return 1;
  return 2;
}

function sessionWorkspaceRoute(agentKey: string, sessionId: string, tab = "overview"): string {
  const base = `/agents/${encodeURIComponent(agentKey)}/sessions/${encodeURIComponent(sessionId)}`;
  return tab === "overview" ? base : `${base}?tab=${encodeURIComponent(tab)}`;
}

export class ControlHomeService {
  private readonly pool: PgQueryable;
  private readonly reads: Pick<ControlReadService, "listAgents" | "listAuditEvents">;
  private readonly agents = buildAgentTableNames();
  private readonly sessions = buildSessionTableNames();
  private readonly control = buildControlTableNames();
  private readonly scheduled = buildScheduledTaskTableNames();

  constructor(options: {pool: PgQueryable; reads: Pick<ControlReadService, "listAgents" | "listAuditEvents">}) {
    this.pool = options.pool;
    this.reads = options.reads;
  }

  async getHome(session: ControlSessionRecord): Promise<ControlHome> {
    const generatedAt = new Date();
    const visibleAgents = [...await this.reads.listAgents(session)];
    const visibleResult = await this.pool.query(`
      SELECT DISTINCT
        agent.agent_key,
        agent.display_name AS agent_display_name,
        target_session.id AS session_id,
        target_session.kind,
        target_session.alias,
        target_session.display_name,
        CASE WHEN pairing.identity_id IS NULL THEN FALSE ELSE TRUE END AS paired,
        heartbeat.enabled AS heartbeat_enabled,
        heartbeat.every_minutes,
        heartbeat.next_fire_at,
        heartbeat.last_fire_at
      FROM ${this.sessions.sessions} AS target_session
      INNER JOIN ${this.agents.agents} AS agent ON agent.agent_key = target_session.agent_key
      INNER JOIN ${this.control.grants} AS grant_row
        ON grant_row.identity_id = $1
       AND grant_row.active = TRUE
       AND grant_row.role = $2
       AND (grant_row.role = 'admin' OR grant_row.agent_key = target_session.agent_key)
      LEFT JOIN ${this.agents.agentPairings} AS pairing
        ON pairing.agent_key = target_session.agent_key
       AND pairing.identity_id = $1
      LEFT JOIN ${this.sessions.sessionHeartbeats} AS heartbeat
        ON heartbeat.session_id = target_session.id
      WHERE agent.status = 'active'
        AND (grant_row.role = 'admin' OR pairing.identity_id IS NOT NULL)
      ORDER BY agent.agent_key ASC, target_session.id ASC
      LIMIT ${SESSION_LIMIT}
    `, [session.identityId, session.role]);

    const visibleRows = visibleResult.rows as VisibleSessionRow[];
    const sessionIds = visibleRows.map((row) => String(row.session_id));
    const tasksBySession = new Map<string, TaskRow[]>();
    const runsBySession = new Map<string, RunRow[]>();

    if (sessionIds.length > 0) {
      const [taskResult, runResult] = await Promise.all([
        this.pool.query(`
          SELECT id, session_id, title, schedule_kind, enabled, claimed_at, next_fire_at, completed_at, cancelled_at, created_at
          FROM ${this.scheduled.scheduledTasks}
          WHERE session_id = ANY($1::text[])
            AND (
              (enabled = TRUE AND completed_at IS NULL AND cancelled_at IS NULL AND next_fire_at IS NOT NULL)
              OR claimed_at IS NOT NULL
              OR enabled = FALSE
            )
          ORDER BY next_fire_at ASC NULLS LAST, created_at DESC, id ASC
          LIMIT $2
        `, [sessionIds, sessionIds.length * TASK_ROWS_PER_SESSION_LIMIT]),
        this.pool.query(`
          SELECT id, task_id, session_id, status, scheduled_for, created_at, finished_at
          FROM ${this.scheduled.scheduledTaskRuns}
          WHERE session_id = ANY($1::text[])
          ORDER BY created_at DESC, id ASC
          LIMIT $2
        `, [sessionIds, sessionIds.length * (TASK_ROWS_PER_SESSION_LIMIT + 1)]),
      ]);
      for (const row of taskResult.rows as TaskRow[]) {
        const rows = tasksBySession.get(String(row.session_id)) ?? [];
        rows.push(row);
        tasksBySession.set(String(row.session_id), rows);
      }
      for (const row of runResult.rows as RunRow[]) {
        const rows = runsBySession.get(String(row.session_id)) ?? [];
        rows.push(row);
        runsBySession.set(String(row.session_id), rows);
      }
    }

    const agentMap = new Map<string, ControlHomeAgentScope>();
    for (const agent of visibleAgents) {
      agentMap.set(agent.agentKey, {
        agentKey: agent.agentKey,
        displayName: agent.displayName,
        paired: agent.paired,
        sessionCount: agent.sessionCount,
      });
    }

    const attentionItems: ControlHomeAttentionItem[] = [];
    const upcomingAutomations: ControlHomeUpcomingAutomation[] = [];
    const sessions: ControlHomeSessionSummary[] = visibleRows.map((row) => {
      const agentKey = String(row.agent_key);
      const sessionId = String(row.session_id);
      const label = labelForSession(row);
      const taskRows = tasksBySession.get(sessionId) ?? [];
      const runRows = runsBySession.get(sessionId) ?? [];
      const nextTask = taskRows.find((task) => task.enabled === true && !task.completed_at && !task.cancelled_at && task.next_fire_at);
      const lastRun = runRows[0];
      const heartbeatEnabled = row.heartbeat_enabled !== false;
      const heartbeat = {
        enabled: heartbeatEnabled,
        everyMinutes: Number(row.every_minutes ?? 60),
        nextFireAt: toIso(row.next_fire_at),
        ...(toIso(row.last_fire_at) ? {lastFireAt: toIso(row.last_fire_at)!} : {}),
      };

      if (lastRun?.status === "failed") {
        attentionItems.push({
          id: `failed-task:${String(lastRun.id)}`,
          severity: "warning",
          type: "failed_task",
          agentKey,
          sessionId,
          sessionLabel: label,
          summary: "A scheduled task run failed recently.",
          targetRoute: sessionWorkspaceRoute(agentKey, sessionId, "automations"),
          createdAt: toIso(lastRun.created_at) ?? undefined,
          dueAt: toIso(lastRun.scheduled_for) ?? undefined,
        });
      }
      for (const task of taskRows) {
        const nextFireAt = toIso(task.next_fire_at);
        const status = lifecycleStatus(task);
        if (task.enabled === true && !task.completed_at && !task.cancelled_at && nextFireAt) {
          upcomingAutomations.push({
            taskId: String(task.id),
            agentKey,
            sessionId,
            title: String(task.title),
            lifecycleStatus: status,
            nextFireAt,
            scheduleKind: String(task.schedule_kind),
            targetRoute: sessionWorkspaceRoute(agentKey, sessionId, "automations"),
          });
          if (Date.parse(nextFireAt) < generatedAt.getTime()) {
            attentionItems.push({
              id: `overdue-task:${String(task.id)}`,
              severity: "warning",
              type: "overdue_task",
              agentKey,
              sessionId,
              sessionLabel: label,
              summary: "A scheduled task is overdue to run.",
              targetRoute: sessionWorkspaceRoute(agentKey, sessionId, "automations"),
              dueAt: nextFireAt,
            });
          }
        }
      }

      return {
        agentKey,
        sessionId,
        label,
        kind: String(row.kind),
        heartbeat,
        nextTaskAt: toIso(nextTask?.next_fire_at),
        lastTaskStatus: typeof lastRun?.status === "string" ? lastRun.status : null,
        links: {
          watches: sessionWorkspaceRoute(agentKey, sessionId, "watches"),
          runtimeActivity: sessionWorkspaceRoute(agentKey, sessionId, "runtime"),
          scheduledTasks: sessionWorkspaceRoute(agentKey, sessionId, "automations"),
          heartbeat: sessionWorkspaceRoute(agentKey, sessionId, "runtime"),
          briefing: sessionWorkspaceRoute(agentKey, sessionId, "briefing"),
        },
      };
    });

    upcomingAutomations.sort((left, right) => String(left.nextFireAt ?? "9999").localeCompare(String(right.nextFireAt ?? "9999")));
    attentionItems.sort((left, right) => severityRank(left.severity) - severityRank(right.severity)
      || String(left.dueAt ?? left.createdAt ?? "9999").localeCompare(String(right.dueAt ?? right.createdAt ?? "9999"))
      || left.id.localeCompare(right.id));

    const boundedAttention = attentionItems.slice(0, ATTENTION_LIMIT);
    const reasonCodes = Array.from(new Set(boundedAttention.map((item) => item.type)));

    return {
      generatedAt: generatedAt.toISOString(),
      scope: {
        identityId: session.identityId,
        role: session.role,
        visibleAgentCount: agentMap.size,
        visibleSessionCount: visibleAgents.reduce((count, agent) => count + agent.sessionCount, 0),
        agents: Array.from(agentMap.values()).sort((left, right) => left.agentKey.localeCompare(right.agentKey)),
      },
      status: {level: boundedAttention.length > 0 ? "attention" : "ok", reasonCodes},
      attentionItems: boundedAttention,
      sessions,
      upcomingAutomations: upcomingAutomations.slice(0, UPCOMING_LIMIT),
      recentActivity: [...await this.reads.listAuditEvents(session, {limit: RECENT_ACTIVITY_LIMIT})],
    };
  }
}
