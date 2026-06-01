export type ControlRole = "admin" | "scoped";
export type ControlSession = {id: string; identityId: string; role: ControlRole; expiresAt: string};
export type BootstrapResponse = {hasGrant: boolean};
export type LoginResponse = {session: ControlSession; csrfToken: string};
export type MeResponse = {session: ControlSession; csrfToken?: string};
export type Overview = {agents: number; sessions: number; runningRuns: number; credentialsPresent: number};
export type AgentSummary = {agentKey: string; displayName: string; status: string; sessionCount: number; paired: boolean};
export type CredentialSummary = {agentKey: string; envKey: string; present: true; createdAt: string; updatedAt: string};
export type SessionBriefing = {agentKey: string; sessionId: string; slug: "session"; content: string; wasSet: boolean; createdAt?: string; updatedAt?: string};
export type SessionHeartbeat = {agentKey: string; sessionId: string; enabled: boolean; everyMinutes: number; nextFireAt: string; lastFireAt?: string};
export type SessionTodoStatus = "pending" | "in_progress" | "blocked" | "done";
export type SessionTodo = {sessionId: string; items: Array<{status: SessionTodoStatus; content: string}>; itemsHash: string | null; createdAt: string | null; updatedAt: string | null; counts: Record<SessionTodoStatus, number>};
export type ScheduledTaskLifecycleStatus = "scheduled" | "disabled" | "running" | "completed" | "cancelled";
export type ScheduledTaskSchedule = {kind: "once"; runAt: string} | {kind: "recurring"; cron: string; timezone: string};
export type ScheduledTaskRun = {id: string; status: string; scheduledFor: string; startedAt: string | null; finishedAt: string | null; resolvedThreadId?: string; threadRunId?: string};
export type ScheduledTask = {id: string; title: string; schedule: ScheduledTaskSchedule; enabled: boolean; lifecycleStatus: ScheduledTaskLifecycleStatus; nextFireAt: string | null; completedAt: string | null; cancelledAt: string | null; createdAt: string; updatedAt: string; recentRuns: ScheduledTaskRun[]};
export type ScheduledTasks = {agentKey: string; sessionId: string; tasks: ScheduledTask[]};
export type AuditEventSummary = {id: string; identityId?: string; sessionId?: string; eventType: string; metadata: Record<string, unknown>; createdAt: string};

export type HomeStatus = {level: "ok" | "attention"; reasonCodes: string[]};
export type HomeAttentionItem = {id: string; severity: "info" | "warning" | "critical"; type: "blocked_todos" | "in_progress_todos" | "failed_task" | "overdue_task" | "disabled_heartbeat"; agentKey: string; sessionId: string; sessionLabel: string; summary: string; targetRoute: string; createdAt?: string; dueAt?: string};
export type HomeSessionSummary = {agentKey: string; sessionId: string; label: string; kind: string; heartbeat: {enabled: boolean; everyMinutes: number; nextFireAt: string | null; lastFireAt?: string}; todoCounts: Record<SessionTodoStatus, number>; nextTaskAt: string | null; lastTaskStatus: string | null; links: {todos: string; scheduledTasks: string; heartbeat: string; briefing: string}};
export type HomeUpcomingAutomation = {taskId: string; agentKey: string; sessionId: string; title: string; lifecycleStatus: string; nextFireAt: string | null; scheduleKind: string; targetRoute: string};
export type ControlHome = {generatedAt: string; scope: {identityId: string; role: ControlRole; visibleAgentCount: number; visibleSessionCount: number; agents: Array<{agentKey: string; displayName: string; paired: boolean; sessionCount: number}>}; status: HomeStatus; attentionItems: HomeAttentionItem[]; sessions: HomeSessionSummary[]; upcomingAutomations: HomeUpcomingAutomation[]; recentActivity: AuditEventSummary[]};

export class ControlApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/control${path}`, {
    credentials: "same-origin",
    headers: {"content-type": "application/json", ...(init.headers ?? {})},
    ...init,
  });
  if (!response.ok) {
    let message = `Control API request failed (${response.status}).`;
    try {
      const body = await response.json() as {error?: string};
      if (body.error) message = body.error;
    } catch {
      // keep generic message
    }
    throw new ControlApiError(response.status, message);
  }
  return await response.json() as T;
}

export const controlApi = {
  bootstrap: () => requestJson<BootstrapResponse>("/bootstrap"),
  me: () => requestJson<MeResponse>("/me"),
  login: (token: string) => requestJson<LoginResponse>("/login", {method: "POST", body: JSON.stringify({token})}),
  logout: (csrfToken: string | null) => requestJson<{ok: true}>("/logout", {method: "POST", headers: csrfToken ? {"x-control-csrf": csrfToken} : {}}),
  overview: () => requestJson<Overview>("/overview"),
  home: () => requestJson<{home: ControlHome}>("/home"),
  agents: () => requestJson<{agents: AgentSummary[]}>("/agents"),
  credentials: () => requestJson<{credentials: CredentialSummary[]}>("/credentials"),
  auditEvents: (input: {limit?: number; eventType?: string; before?: string} = {}) => {
    const params = new URLSearchParams();
    if (input.limit !== undefined) params.set("limit", String(input.limit));
    if (input.eventType) params.set("eventType", input.eventType);
    if (input.before) params.set("before", input.before);
    const suffix = params.toString();
    return requestJson<{auditEvents: AuditEventSummary[]}>(`/audit-events${suffix ? `?${suffix}` : ""}`);
  },
  getSessionBriefing: (agentKey: string, sessionId: string) => requestJson<{briefing: SessionBriefing}>(`/agents/${encodeURIComponent(agentKey)}/sessions/${encodeURIComponent(sessionId)}/briefing`),
  putSessionBriefing: (agentKey: string, sessionId: string, content: string, csrfToken: string | null) => requestJson<{briefing: SessionBriefing}>(`/agents/${encodeURIComponent(agentKey)}/sessions/${encodeURIComponent(sessionId)}/briefing`, {method: "PUT", headers: csrfToken ? {"x-control-csrf": csrfToken} : {}, body: JSON.stringify({content})}),
  clearSessionBriefing: (agentKey: string, sessionId: string, csrfToken: string | null) => requestJson<{briefing: SessionBriefing}>(`/agents/${encodeURIComponent(agentKey)}/sessions/${encodeURIComponent(sessionId)}/briefing`, {method: "DELETE", headers: csrfToken ? {"x-control-csrf": csrfToken} : {}, body: JSON.stringify({confirm: "clear-session-briefing"})}),
  getSessionHeartbeat: (agentKey: string, sessionId: string) => requestJson<{heartbeat: SessionHeartbeat}>(`/agents/${encodeURIComponent(agentKey)}/sessions/${encodeURIComponent(sessionId)}/heartbeat`),
  getSessionTodo: (agentKey: string, sessionId: string) => requestJson<{todo: SessionTodo}>(`/agents/${encodeURIComponent(agentKey)}/sessions/${encodeURIComponent(sessionId)}/todos`),
  getScheduledTasks: (agentKey: string, sessionId: string, limit = 50) => requestJson<{scheduledTasks: ScheduledTasks}>(`/agents/${encodeURIComponent(agentKey)}/sessions/${encodeURIComponent(sessionId)}/scheduled-tasks?limit=${encodeURIComponent(String(limit))}`),
  patchSessionHeartbeat: (agentKey: string, sessionId: string, input: {enabled: boolean; everyMinutes: number}, csrfToken: string | null) => requestJson<{heartbeat: SessionHeartbeat}>(`/agents/${encodeURIComponent(agentKey)}/sessions/${encodeURIComponent(sessionId)}/heartbeat`, {method: "PATCH", headers: csrfToken ? {"x-control-csrf": csrfToken} : {}, body: JSON.stringify({...input, confirm: "update-heartbeat"})}),
};
