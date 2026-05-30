export type ControlRole = "admin" | "scoped";
export type ControlSession = {id: string; identityId: string; role: ControlRole; expiresAt: string};
export type BootstrapResponse = {hasGrant: boolean};
export type LoginResponse = {session: ControlSession; csrfToken: string};
export type MeResponse = {session: ControlSession; csrfToken?: string};
export type Overview = {agents: number; sessions: number; runningRuns: number; credentialsPresent: number};
export type AgentSummary = {agentKey: string; displayName: string; status: string; sessionCount: number; paired: boolean};
export type CredentialSummary = {agentKey: string; envKey: string; present: true; createdAt: string; updatedAt: string};
export type SessionBriefing = {agentKey: string; sessionId: string; slug: "session"; content: string; wasSet: boolean; createdAt?: string; updatedAt?: string};

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
  agents: () => requestJson<{agents: AgentSummary[]}>("/agents"),
  credentials: () => requestJson<{credentials: CredentialSummary[]}>("/credentials"),
  getSessionBriefing: (agentKey: string, sessionId: string) => requestJson<{briefing: SessionBriefing}>(`/agents/${encodeURIComponent(agentKey)}/sessions/${encodeURIComponent(sessionId)}/briefing`),
  putSessionBriefing: (agentKey: string, sessionId: string, content: string, csrfToken: string | null) => requestJson<{briefing: SessionBriefing}>(`/agents/${encodeURIComponent(agentKey)}/sessions/${encodeURIComponent(sessionId)}/briefing`, {method: "PUT", headers: csrfToken ? {"x-control-csrf": csrfToken} : {}, body: JSON.stringify({content})}),
  clearSessionBriefing: (agentKey: string, sessionId: string, csrfToken: string | null) => requestJson<{briefing: SessionBriefing}>(`/agents/${encodeURIComponent(agentKey)}/sessions/${encodeURIComponent(sessionId)}/briefing`, {method: "DELETE", headers: csrfToken ? {"x-control-csrf": csrfToken} : {}, body: JSON.stringify({confirm: "clear-session-briefing"})}),
};
