import type { TableParams } from "@/lib/api"

type FailureParams = TableParams & {
  agentKey?: string
  kind?: string
  severity?: string
  sessionId?: string
  source?: string
}

type AuditParams = TableParams & {
  agentKey?: string
  eventType?: string
  targetSessionId?: string
}

type ModelCallTraceParams = TableParams & {
  agent_key?: string
  mode?: string
  run_id?: string
  session_id?: string
  status?: string
}

type GatewayEventParams = TableParams & {
  sourceId?: string
}

export const controlKeys = {
  all: ["control"] as const,
  auth: () => [...controlKeys.all, "auth"] as const,
  me: () => [...controlKeys.auth(), "me"] as const,
  search: (search: string, perPage = 8) =>
    [...controlKeys.all, "search", { per_page: perPage, search }] as const,
  failures: {
    all: () => [...controlKeys.all, "failures"] as const,
    list: (params: FailureParams) =>
      [...controlKeys.failures.all(), "list", params] as const,
    summary: (params: FailureParams) =>
      [...controlKeys.failures.all(), "summary", params] as const,
  },
  identities: {
    all: () => [...controlKeys.all, "identities"] as const,
    list: (params: TableParams) =>
      [...controlKeys.identities.all(), "list", params] as const,
  },
  agents: {
    all: () => [...controlKeys.all, "agents"] as const,
    list: (params: TableParams) =>
      [...controlKeys.agents.all(), "list", params] as const,
    detail: (agentKey: string) =>
      [...controlKeys.agents.all(), "detail", agentKey] as const,
    pairings: (agentKey: string, params: TableParams) =>
      [...controlKeys.agents.detail(agentKey), "pairings", params] as const,
    sessions: (agentKey: string, params: TableParams) =>
      [...controlKeys.agents.detail(agentKey), "sessions", params] as const,
    session: (agentKey: string, sessionId: string) =>
      [...controlKeys.agents.detail(agentKey), "sessions", "detail", sessionId] as const,
    mcpServers: (agentKey: string) =>
      [...controlKeys.agents.detail(agentKey), "mcp-servers"] as const,
    credentials: (agentKey: string, params: TableParams) =>
      [...controlKeys.agents.detail(agentKey), "credentials", params] as const,
    wikiBinding: (agentKey: string) =>
      [...controlKeys.agents.detail(agentKey), "wiki-binding"] as const,
    connectors: (agentKey: string, params: TableParams) =>
      [...controlKeys.agents.detail(agentKey), "connectors", params] as const,
    telegramSetup: (agentKey: string, accountKey: string) =>
      [...controlKeys.agents.detail(agentKey), "telegram-setup", accountKey] as const,
    bindings: (agentKey: string, params: TableParams) =>
      [...controlKeys.agents.detail(agentKey), "bindings", params] as const,
    emailRoutes: (agentKey: string, params: TableParams) =>
      [...controlKeys.agents.detail(agentKey), "email-routes", params] as const,
    emailAllowedRecipients: (agentKey: string, params: TableParams) =>
      [...controlKeys.agents.detail(agentKey), "email-allowlist", params] as const,
    discordActorPairings: (agentKey: string, params: TableParams) =>
      [...controlKeys.agents.detail(agentKey), "discord-actor-pairings", params] as const,
    channelActorPairings: (agentKey: string, params: TableParams) =>
      [...controlKeys.agents.detail(agentKey), "channel-actor-pairings", params] as const,
    skills: (agentKey: string, params?: TableParams) =>
      [...controlKeys.agents.detail(agentKey), "skills", params ?? "list"] as const,
    skill: (agentKey: string, skillKey: string) =>
      [...controlKeys.agents.detail(agentKey), "skills", "detail", skillKey] as const,
    subagents: (agentKey: string, params?: TableParams) =>
      [...controlKeys.agents.detail(agentKey), "subagents", params ?? "list"] as const,
    subagent: (agentKey: string, slug: string) =>
      [...controlKeys.agents.detail(agentKey), "subagents", "detail", slug] as const,
    gatewaySources: (agentKey: string, params: TableParams) =>
      [...controlKeys.agents.detail(agentKey), "gateway", "sources", params] as const,
    gatewayDevices: (agentKey: string, sourceId: string, params?: TableParams) =>
      [...controlKeys.agents.detail(agentKey), "gateway", "sources", sourceId, "devices", params ?? "list"] as const,
    gatewayEventTypes: (agentKey: string, sourceId: string, params: TableParams) =>
      [...controlKeys.agents.detail(agentKey), "gateway", "sources", sourceId, "event-types", params] as const,
    gatewayEvents: (agentKey: string, params: GatewayEventParams) =>
      [...controlKeys.agents.detail(agentKey), "gateway", "events", params] as const,
  },
  sessions: {
    a2aBindings: (agentKey: string, sessionId: string, params: TableParams) =>
      [...controlKeys.agents.session(agentKey, sessionId), "a2a-bindings", params] as const,
    briefing: (agentKey: string, sessionId: string) =>
      [...controlKeys.agents.session(agentKey, sessionId), "briefing"] as const,
    sessionPrompts: (agentKey: string, sessionId: string) =>
      [...controlKeys.agents.session(agentKey, sessionId), "prompts"] as const,
    heartbeat: (agentKey: string, sessionId: string) =>
      [...controlKeys.agents.session(agentKey, sessionId), "heartbeat"] as const,
    targets: (agentKey: string, sessionId: string) =>
      [...controlKeys.agents.session(agentKey, sessionId), "targets"] as const,
    runtime: (agentKey: string, sessionId: string, params: TableParams) =>
      [...controlKeys.agents.session(agentKey, sessionId), "runtime", params] as const,
    scheduledTasks: (agentKey: string, sessionId: string, params?: TableParams) =>
      [
        ...controlKeys.agents.session(agentKey, sessionId),
        "scheduled-tasks",
        ...(params ? [params] : []),
      ] as const,
    watches: (agentKey: string, sessionId: string, params?: TableParams) =>
      [
        ...controlKeys.agents.session(agentKey, sessionId),
        "watches",
        ...(params ? [params] : []),
      ] as const,
    gatewayEvents: (agentKey: string, sessionId: string, params: TableParams) =>
      [...controlKeys.agents.session(agentKey, sessionId), "gateway-events", params] as const,
  },
  modelCallTraces: {
    all: () => [...controlKeys.all, "model-call-traces"] as const,
    list: (params: ModelCallTraceParams) =>
      [...controlKeys.modelCallTraces.all(), "list", params] as const,
    detail: (traceId: string) =>
      [...controlKeys.modelCallTraces.all(), "detail", traceId] as const,
  },
  audit: {
    list: (params: AuditParams) =>
      [...controlKeys.all, "audit-events", params] as const,
  },
}
