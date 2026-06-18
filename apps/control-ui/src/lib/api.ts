export type TableMeta = {
  current_page: number
  last_page: number
  total: number
  per_page: number
}

export type PaginatedResponse<T> = {
  data: T[]
  meta: TableMeta
}

export type TableParamPrimitive = string | number | boolean
export type TableParamValue =
  | TableParamPrimitive
  | readonly TableParamPrimitive[]
  | undefined

export type TableParams = {
  page?: number
  per_page?: number
  sort_by?: string
  sort_direction?: "asc" | "desc"
  search?: string
  [key: string]: TableParamValue
}

export type ControlSession = {
  id: string
  identityId: string
  role: "admin" | "scoped"
  expiresAt: string
}

export type DevLoginInput = {
  identity?: string
  role?: "admin" | "scoped"
  agentKey?: string
}

export type ControlGrant = {
  id: string
  identityId: string
  role: "admin" | "scoped"
  agentKey?: string
  label?: string
  active: boolean
  loginTokenExpiresAt: string
  loginTokenConsumedAt?: string
  createdAt: string
  updatedAt: string
}

export type AgentRow = {
  agentKey: string
  displayName: string
  status: string
  sessionCount: number
  paired: boolean
}

export type AgentDetail = AgentRow & {
  credentialCount: number
  connectorCount: number
  pairingCount: number
  skillCount: number
  subagentCount: number
  gatewaySourceCount: number
  wikiBindingSet: boolean
}

export type SessionRow = {
  id: string
  agentKey: string
  kind: string
  isSubagent: boolean
  currentThreadId: string
  alias?: string
  displayName?: string
  label: string
  createdByIdentityId?: string
  heartbeatEnabled: boolean
  createdAt: string
  updatedAt: string
}

export type SessionDetail = SessionRow & {
  briefingSet: boolean
  runtime: {
    model?: string
    thinking?: string
    thinkingConfigured: boolean
    pendingWakeAt?: string
  }
}

export type ExecutionTarget = {
  alias: string
  kind: "persistent_agent_runner" | "disposable_container" | "local" | string
  state: "provisioning" | "ready" | "failed" | "stopping" | "stopped" | string
  label: string
  health: "reachable" | "unreachable" | "unknown" | "not_applicable" | string
  isDefaultBinding?: boolean
}

export type WorkFailure = {
  id: string
  kind: string
  severity: "warning" | "critical"
  agentKey: string
  sessionId?: string
  sessionLabel?: string
  source: string
  summary: string
  detail?: string
  targetRoute: string
  createdAt: string
}

export type GlobalSearchResult = {
  id: string
  kind:
    | "agent"
    | "session"
    | "identity"
    | "work_failure"
    | "credential"
    | "connector"
    | "binding"
    | "skill"
    | "subagent"
    | "gateway_source"
    | "gateway_device"
  title: string
  subtitle: string
  targetRoute: string
  agentKey?: string
  sessionId?: string
  updatedAt?: string
}

export type CredentialRow = {
  agentKey: string
  envKey: string
  present: true
  createdAt: string
  updatedAt: string
}

export type WikiBinding = {
  agentKey: string
  wikiGroupId: number
  namespacePath: string
  createdAt: string
  updatedAt: string
}

export type ConnectorRow = {
  id: string
  source: string
  accountKey: string
  connectorKey: string
  displayName?: string
  externalUsername?: string
  status: string
  ownerKind: string
  secretKeys: string[]
  email?: {
    fromAddress: string
    fromName?: string
    mailboxes: string[]
    credentialKeys: string[]
    imap: {
      host: string
      port?: number
      secure?: boolean
      usernameCredentialEnvKey: string
      passwordCredentialEnvKey: string
    }
    smtp: {
      host: string
      port?: number
      secure?: boolean
      usernameCredentialEnvKey: string
      passwordCredentialEnvKey: string
    }
  }
  createdAt: string
  updatedAt: string
}

export type BindingRow = {
  source: string
  connectorKey: string
  externalConversationId: string
  sessionId: string
  sessionLabel: string
  displayName?: string
  createdAt: string
  updatedAt: string
}

export type A2ABindingRow = {
  senderSessionId: string
  senderAgentKey: string
  senderSessionLabel: string
  recipientSessionId: string
  recipientAgentKey: string
  recipientSessionLabel: string
  direction: "outbound" | "inbound"
  createdAt: string
  updatedAt: string
}

export type EmailRouteRow = {
  id: string
  agentKey: string
  accountKey: string
  mailbox?: string
  sessionId: string
  sessionLabel: string
  createdAt: string
  updatedAt: string
}

export type EmailAllowedRecipientRow = {
  agentKey: string
  accountKey: string
  address: string
  createdAt: string
}

export type IdentityOptionRow = {
  id: string
  handle: string
  displayName: string
  status: string
  agentPairingCount: number
  actorBindingCount: number
  createdAt: string
  updatedAt: string
}

export type AgentPairingRow = {
  agentKey: string
  identityId: string
  identityHandle: string
  identityDisplayName: string
  identityStatus: string
  createdAt: string
  updatedAt: string
}

export type DiscordActorPairingRow = {
  agentKey: string
  accountKey: string
  connectorKey: string
  externalActorId: string
  identityId: string
  identityHandle: string
  identityDisplayName: string
  identityStatus: string
  createdAt: string
  updatedAt: string
}

export type ChannelActorPairingRow = {
  agentKey: string
  source: "telegram" | "whatsapp"
  connectorKey: string
  externalActorId: string
  identityId: string
  identityHandle: string
  identityDisplayName: string
  identityStatus: string
  createdAt: string
  updatedAt: string
}

export type TelegramSetupStatus = {
  agentKey: string
  accountKey: string
  account: {
    exists: boolean
    enabled: boolean
    status?: string
    ownerAgentKey?: string
    connectorKey?: string
    displayName?: string
    externalUsername?: string
    tokenStored: boolean
    tokenValid: "not_checked" | "valid" | "invalid" | "missing_secret" | "unavailable"
    validationError?: string
  }
  sessionBindings: { total: number; bindings: BindingRow[] }
  actorPairings: { total: number; pairings: ChannelActorPairingRow[] }
  agentPairings: { total: number; identities: AgentPairingRow[] }
  worker: { enabled: boolean; reloadRequired: boolean; detail: string; smokeCommand: string }
  trace: { collectorEnabled: boolean; serviceSelected: boolean; sourceEnvKey: string; sourceConfigured: boolean; detail: string }
  checklist: Array<{ key: string; label: string; status: "done" | "warning" | "blocked" | "info"; detail: string; action?: string }>
}

export type SkillRow = {
  agentKey: string
  skillKey: string
  description: string
  content?: string
  tags: string[]
  loadCount: number
  createdAt: string
  updatedAt: string
}

export type SubagentRow = {
  slug: string
  agentKey?: string
  description: string
  prompt?: string
  toolGroups: string[]
  model?: string
  thinking?: string
  source: string
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export type GatewaySourceRow = {
  sourceId: string
  name: string
  clientId: string
  agentKey: string
  identityId: string
  sessionId?: string
  status: string
  suspendedAt?: string
  suspendReason?: string
  createdAt: string
  updatedAt: string
}

export type GatewayDeviceRow = {
  sourceId: string
  deviceId: string
  label?: string
  capabilities: string[]
  enabled: boolean
  disabledAt?: string
  lastSeenAt?: string
  createdAt: string
  updatedAt: string
}

export type GatewayDevices = PaginatedResponse<GatewayDeviceRow> & {
  devices?: GatewayDeviceRow[]
}

export type GatewayEventTypeRow = {
  sourceId: string
  type: string
  delivery: "queue" | "wake" | string
  createdAt: string
  updatedAt: string
}

export type GatewayEventRow = {
  id: string
  sourceId: string
  type: string
  deliveryRequested: string
  deliveryEffective: string
  status: string
  reason?: string
  threadId?: string
  textBytes: number
  textSha256: string
  createdAt: string
}

export type Briefing = {
  sessionId: string
  slug: string
  content: string
  wasSet: boolean
  createdAt?: string
  updatedAt?: string
}

export type Heartbeat = {
  sessionId: string
  enabled: boolean
  everyMinutes: number
  nextFireAt: string | null
  lastFireAt?: string
}

export type RuntimeRun = {
  id: string
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | string
  startedAt: string
  finishedAt: string | null
  durationMs: number | null
  abortRequestedAt: string | null
  failureCategory:
    | "provider_abort"
    | "provider_timeout"
    | "provider_server_error"
    | "provider_transport_terminated"
    | "provider_transport_network"
    | "provider_error"
    | null
  errorSummary: string | null
}

export type RuntimeActivity = {
  agentKey: string
  sessionId: string
  summary?: {
    total: number
    running: number
    completed: number
    failed: number
    abortRequests: number
    averageDurationMs: number | null
    latestStartedAt: string | null
    latestFinishedAt: string | null
    latestRun: RuntimeRun | null
  }
  data?: RuntimeRun[]
  meta?: TableMeta
  runs?: RuntimeRun[]
}

export type ModelCallTraceMode = "complete" | "stream" | string

export type ModelCallTraceStatus = "completed" | "failed" | string

export type ModelCallTraceSummary = {
  id: string
  runId: string | null
  threadId: string | null
  sessionId: string | null
  agentKey: string | null
  turn: number | null
  callIndex: number | null
  provider: string
  model: string
  mode: ModelCallTraceMode
  status: ModelCallTraceStatus
  startedAt: string
  finishedAt: string
  durationMs: number
  promptCacheKey: string | null
  usage: unknown | null
  error: Record<string, unknown> | null
  expiresAt: string
}

export type ModelCallTraceDetail = ModelCallTraceSummary & {
  request: Record<string, unknown>
  response: unknown | null
}

export type ScheduledTaskRun = {
  id: string
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | string
  scheduledFor: string
  startedAt: string | null
  finishedAt: string | null
  resolvedThreadId?: string
  threadRunId?: string
}

export type ScheduledTaskSchedule =
  | { kind: "once"; runAt: string }
  | { kind: "recurring"; cron: string; timezone: string }

export type ScheduledTask = {
  id: string
  title: string
  schedule: ScheduledTaskSchedule
  enabled: boolean
  lifecycleStatus: "scheduled" | "disabled" | "running" | "completed" | "cancelled"
  nextFireAt: string | null
  completedAt: string | null
  cancelledAt: string | null
  createdAt: string
  updatedAt: string
  recentRuns: ScheduledTaskRun[]
}

export type ScheduledTasks = PaginatedResponse<ScheduledTask> & {
  agentKey?: string
  sessionId?: string
  tasks: ScheduledTask[]
}

export type WatchLatestRun = {
  id: string
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | string
  scheduledFor: string
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
}

export type WatchRow = {
  id: string
  title: string
  sourceKind: "mongodb_query" | "sql_query" | "http_json" | "http_html" | "imap_mailbox" | null
  detectorKind: "new_items" | "snapshot_changed" | "percent_change" | null
  observationKind: "collection" | "snapshot" | "scalar" | null
  intervalMinutes: number
  enabled: boolean
  lifecycleStatus: "enabled" | "disabled" | "cooldown" | "running"
  nextPollAt: string | null
  disabledAt: string | null
  cooldownUntil: string | null
  createdAt: string
  updatedAt: string
  recentRunCount: number
  eventCount: number
  latestRun: WatchLatestRun | null
}

export type Watches = PaginatedResponse<WatchRow> & {
  agentKey?: string
  sessionId?: string
  watches: WatchRow[]
}

export type AuditEvent = {
  id: string
  identityId?: string
  sessionId?: string
  eventType: string
  metadata: Record<string, unknown>
  createdAt: string
}

export class ApiError extends Error {
  body: unknown
  status: number

  constructor(status: number, message: string, body?: unknown) {
    super(message)
    this.body = body
    this.status = status
  }
}

function qs(params: TableParams = {}) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== "") search.append(key, String(item))
      }
      continue
    }
    if (value !== undefined && value !== "") search.set(key, String(value))
  }
  const value = search.toString()
  return value ? `?${value}` : ""
}

async function parseResponse<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => null)) as unknown
  if (!response.ok) {
    const message =
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : `Control request failed with ${response.status}`
    throw new ApiError(response.status, message, body)
  }
  return body as T
}

export function readCookie(name: string): string | null {
  return (
    document.cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${name}=`))
      ?.split("=")
      .slice(1)
      .join("=") ?? null
  )
}

export async function apiGet<T>(path: string): Promise<T> {
  return parseResponse<T>(
    await fetch(`/api/control${path}`, {
      credentials: "include",
    })
  )
}

export async function apiWrite<T>(
  path: string,
  options: { method?: "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown; csrfToken?: string | null } = {}
): Promise<T> {
  return parseResponse<T>(
    await fetch(`/api/control${path}`, {
      method: options.method ?? "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        ...(options.csrfToken ? { "x-control-csrf": options.csrfToken } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })
  )
}

export const controlApi = {
  me: () => apiGet<{ session: ControlSession }>("/me"),
  bootstrap: () => apiGet<{ hasGrant: boolean }>("/bootstrap"),
  login: (input: { token: string; remember?: boolean }) => apiWrite<{ session: ControlSession; csrfToken: string }>("/login", { body: input }),
  devLogin: (body: DevLoginInput) => apiWrite<{ session: ControlSession; csrfToken: string }>("/dev-login", { body }),
  logout: (csrfToken?: string | null) => apiWrite<{ ok: true }>("/logout", { csrfToken }),
  failures: (params: TableParams) => apiGet<PaginatedResponse<WorkFailure>>(`/work-failures${qs(params)}`),
  search: (params: Pick<TableParams, "search" | "per_page">) => apiGet<PaginatedResponse<GlobalSearchResult>>(`/search${qs(params)}`),
  agents: (params: TableParams) => apiGet<PaginatedResponse<AgentRow>>(`/agents${qs(params)}`),
  identities: (params: TableParams) => apiGet<PaginatedResponse<IdentityOptionRow>>(`/identities${qs(params)}`),
  createIdentity: (body: Record<string, unknown>, csrfToken?: string | null) =>
    apiWrite<{ identity: IdentityOptionRow }>("/identities", { body, csrfToken }),
  issueControlGrant: (body: Record<string, unknown>, csrfToken?: string | null) =>
    apiWrite<{ grant: ControlGrant; loginToken: string }>("/control-grants", {
      body,
      csrfToken,
    }),
  updateIdentity: (identityId: string, body: Record<string, unknown>, csrfToken?: string | null) =>
    apiWrite<{ identity: IdentityOptionRow }>(`/identities/${encodeURIComponent(identityId)}`, {
      method: "PATCH",
      body,
      csrfToken,
    }),
  disableIdentity: (identityId: string, csrfToken?: string | null) =>
    apiWrite<{ identity: IdentityOptionRow }>(`/identities/${encodeURIComponent(identityId)}`, {
      method: "DELETE",
      csrfToken,
    }),
  agent: (agentKey: string) => apiGet<{ agent: AgentDetail }>(`/agents/${encodeURIComponent(agentKey)}`),
  agentPairings: (agentKey: string, params: TableParams) =>
    apiGet<PaginatedResponse<AgentPairingRow>>(`/agents/${encodeURIComponent(agentKey)}/pairings${qs(params)}`),
  pairAgentIdentity: (agentKey: string, body: Record<string, unknown>, csrfToken?: string | null) =>
    apiWrite<{ pairing: AgentPairingRow }>(`/agents/${encodeURIComponent(agentKey)}/pairings`, { body, csrfToken }),
  deleteAgentPairing: (agentKey: string, row: Pick<AgentPairingRow, "identityId">, csrfToken?: string | null) =>
    apiWrite<{ deleted: boolean }>(`/agents/${encodeURIComponent(agentKey)}/pairings/${encodeURIComponent(row.identityId)}`, {
      method: "DELETE",
      csrfToken,
    }),
  sessions: (agentKey: string, params: TableParams) =>
    apiGet<PaginatedResponse<SessionRow>>(`/agents/${encodeURIComponent(agentKey)}/sessions${qs(params)}`),
  session: (agentKey: string, sessionId: string) =>
    apiGet<{ session: SessionDetail }>(`/agents/${encodeURIComponent(agentKey)}/sessions/${encodeURIComponent(sessionId)}`),
  sessionTargets: (agentKey: string, sessionId: string) =>
    apiGet<{ targets: ExecutionTarget[] }>(`/agents/${encodeURIComponent(agentKey)}/sessions/${encodeURIComponent(sessionId)}/targets`),
  bindSessionTarget: (agentKey: string, sessionId: string, body: Record<string, unknown>, csrfToken?: string | null) =>
    apiWrite<{ target: ExecutionTarget; targets: ExecutionTarget[] }>(
      `/agents/${encodeURIComponent(agentKey)}/sessions/${encodeURIComponent(sessionId)}/targets`,
      { body, csrfToken }
    ),
  deleteSessionTarget: (agentKey: string, sessionId: string, alias: string, csrfToken?: string | null) =>
    apiWrite<{ deleted: boolean; targets: ExecutionTarget[] }>(
      `/agents/${encodeURIComponent(agentKey)}/sessions/${encodeURIComponent(sessionId)}/targets/${encodeURIComponent(alias)}`,
      { method: "DELETE", csrfToken }
    ),
  createSession: (agentKey: string, body: Record<string, unknown>, csrfToken?: string | null) =>
    apiWrite<{ session: SessionRow }>(`/agents/${encodeURIComponent(agentKey)}/sessions`, { body, csrfToken }),
  updateSession: (agentKey: string, sessionId: string, body: Record<string, unknown>, csrfToken?: string | null) =>
    apiWrite<{ session: SessionRow }>(`/agents/${encodeURIComponent(agentKey)}/sessions/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      body,
      csrfToken,
    }),
  updateSessionRuntimeConfig: (agentKey: string, sessionId: string, body: Record<string, unknown>, csrfToken?: string | null) =>
    apiWrite<{ session: SessionDetail }>(
      `/agents/${encodeURIComponent(agentKey)}/sessions/${encodeURIComponent(sessionId)}/runtime-config`,
      {
        method: "PATCH",
        body,
        csrfToken,
      }
    ),
  a2aBindings: (agentKey: string, sessionId: string, params: TableParams = {}) =>
    apiGet<PaginatedResponse<A2ABindingRow>>(
      `/agents/${encodeURIComponent(agentKey)}/sessions/${encodeURIComponent(sessionId)}/a2a-bindings${qs(params)}`
    ),
  bindA2ASession: (agentKey: string, sessionId: string, body: Record<string, unknown>, csrfToken?: string | null) =>
    apiWrite<{ bindings: A2ABindingRow[] }>(
      `/agents/${encodeURIComponent(agentKey)}/sessions/${encodeURIComponent(sessionId)}/a2a-bindings`,
      { body, csrfToken }
    ),
  deleteA2ABinding: (
    agentKey: string,
    sessionId: string,
    peerSessionId: string,
    body: Record<string, unknown>,
    csrfToken?: string | null
  ) =>
    apiWrite<{ deleted: boolean; reverseDeleted: boolean }>(
      `/agents/${encodeURIComponent(agentKey)}/sessions/${encodeURIComponent(sessionId)}/a2a-bindings/${encodeURIComponent(peerSessionId)}`,
      {
        method: "DELETE",
        body,
        csrfToken,
      }
    ),
  resetSession: (agentKey: string, sessionId: string, csrfToken?: string | null) =>
    apiWrite<{ session: SessionRow; previousThreadId: string }>(
      `/agents/${encodeURIComponent(agentKey)}/sessions/${encodeURIComponent(sessionId)}/reset`,
      { csrfToken }
    ),
  credentials: (agentKey: string, params: TableParams) =>
    apiGet<PaginatedResponse<CredentialRow>>(`/agents/${encodeURIComponent(agentKey)}/credentials${qs(params)}`),
  setCredential: (agentKey: string, body: Record<string, unknown>, csrfToken?: string | null) =>
    apiWrite<{ credential: CredentialRow }>(`/agents/${encodeURIComponent(agentKey)}/credentials`, { body, csrfToken }),
  deleteCredential: (agentKey: string, envKey: string, csrfToken?: string | null) =>
    apiWrite<{ deleted: boolean }>(`/agents/${encodeURIComponent(agentKey)}/credentials/${encodeURIComponent(envKey)}`, {
      method: "DELETE",
      csrfToken,
    }),
  wikiBinding: (agentKey: string) =>
    apiGet<{ binding: WikiBinding | null }>(`/agents/${encodeURIComponent(agentKey)}/wiki-binding`),
  setWikiBinding: (agentKey: string, body: Record<string, unknown>, csrfToken?: string | null) =>
    apiWrite<{ binding: WikiBinding }>(`/agents/${encodeURIComponent(agentKey)}/wiki-binding`, {
      method: "PUT",
      body,
      csrfToken,
    }),
  clearWikiBinding: (agentKey: string, csrfToken?: string | null) =>
    apiWrite<{ deleted: boolean }>(`/agents/${encodeURIComponent(agentKey)}/wiki-binding`, {
      method: "DELETE",
      csrfToken,
    }),
  connectors: (agentKey: string, params: TableParams) =>
    apiGet<PaginatedResponse<ConnectorRow>>(`/agents/${encodeURIComponent(agentKey)}/connectors${qs(params)}`),
  telegramSetupStatus: (agentKey: string, accountKey: string) =>
    apiGet<{ status: TelegramSetupStatus }>(`/agents/${encodeURIComponent(agentKey)}/telegram/setup-status?account_key=${encodeURIComponent(accountKey)}`),
  upsertConnector: (agentKey: string, body: Record<string, unknown>, csrfToken?: string | null) =>
    apiWrite<{ connector: ConnectorRow }>(`/agents/${encodeURIComponent(agentKey)}/connectors`, { body, csrfToken }),
  setConnectorEnabled: (agentKey: string, row: Pick<ConnectorRow, "source" | "accountKey">, enabled: boolean, csrfToken?: string | null) =>
    apiWrite<{ connector: ConnectorRow }>(
      `/agents/${encodeURIComponent(agentKey)}/connectors/${encodeURIComponent(row.source)}/${encodeURIComponent(row.accountKey)}/status`,
      {
        method: "PATCH",
        body: { enabled },
        csrfToken,
      }
    ),
  bindings: (agentKey: string, params: TableParams) =>
    apiGet<PaginatedResponse<BindingRow>>(`/agents/${encodeURIComponent(agentKey)}/bindings${qs(params)}`),
  bindConversation: (agentKey: string, body: Record<string, unknown>, csrfToken?: string | null) =>
    apiWrite<{ binding: BindingRow }>(`/agents/${encodeURIComponent(agentKey)}/bindings`, { body, csrfToken }),
  deleteBinding: (agentKey: string, row: BindingRow, csrfToken?: string | null) =>
    apiWrite<{ deleted: boolean }>(
      `/agents/${encodeURIComponent(agentKey)}/bindings/${encodeURIComponent(row.source)}/${encodeURIComponent(
        row.connectorKey
      )}/${encodeURIComponent(row.externalConversationId)}`,
      { method: "DELETE", csrfToken }
    ),
  emailRoutes: (agentKey: string, params: TableParams) =>
    apiGet<PaginatedResponse<EmailRouteRow>>(`/agents/${encodeURIComponent(agentKey)}/email/routes${qs(params)}`),
  setEmailRoute: (agentKey: string, body: Record<string, unknown>, csrfToken?: string | null) =>
    apiWrite<{ route: EmailRouteRow }>(`/agents/${encodeURIComponent(agentKey)}/email/routes`, { body, csrfToken }),
  deleteEmailRoute: (agentKey: string, row: Pick<EmailRouteRow, "accountKey" | "mailbox">, csrfToken?: string | null) =>
    apiWrite<{ deleted: boolean }>(
      `/agents/${encodeURIComponent(agentKey)}/email/routes/${encodeURIComponent(row.accountKey)}`,
      { method: "DELETE", body: { mailbox: row.mailbox }, csrfToken }
    ),
  emailAllowedRecipients: (agentKey: string, params: TableParams) =>
    apiGet<PaginatedResponse<EmailAllowedRecipientRow>>(`/agents/${encodeURIComponent(agentKey)}/email/allowlist${qs(params)}`),
  addEmailAllowedRecipient: (agentKey: string, body: Record<string, unknown>, csrfToken?: string | null) =>
    apiWrite<{ recipient: EmailAllowedRecipientRow }>(`/agents/${encodeURIComponent(agentKey)}/email/allowlist`, {
      body,
      csrfToken,
    }),
  deleteEmailAllowedRecipient: (agentKey: string, row: Pick<EmailAllowedRecipientRow, "accountKey" | "address">, csrfToken?: string | null) =>
    apiWrite<{ deleted: boolean }>(
      `/agents/${encodeURIComponent(agentKey)}/email/allowlist/${encodeURIComponent(row.accountKey)}/${encodeURIComponent(row.address)}`,
      { method: "DELETE", csrfToken }
    ),
  discordActorPairings: (agentKey: string, params: TableParams) =>
    apiGet<PaginatedResponse<DiscordActorPairingRow>>(`/agents/${encodeURIComponent(agentKey)}/discord/actor-pairings${qs(params)}`),
  pairDiscordActor: (agentKey: string, body: Record<string, unknown>, csrfToken?: string | null) =>
    apiWrite<{ pairing: DiscordActorPairingRow }>(`/agents/${encodeURIComponent(agentKey)}/discord/actor-pairings`, {
      body,
      csrfToken,
    }),
  deleteDiscordActorPairing: (
    agentKey: string,
    row: Pick<DiscordActorPairingRow, "accountKey" | "externalActorId">,
    csrfToken?: string | null
  ) =>
    apiWrite<{ deleted: boolean }>(
      `/agents/${encodeURIComponent(agentKey)}/discord/actor-pairings/${encodeURIComponent(row.accountKey)}/${encodeURIComponent(row.externalActorId)}`,
      { method: "DELETE", csrfToken }
    ),
  channelActorPairings: (agentKey: string, params: TableParams) =>
    apiGet<PaginatedResponse<ChannelActorPairingRow>>(`/agents/${encodeURIComponent(agentKey)}/channel-actor-pairings${qs(params)}`),
  pairChannelActor: (agentKey: string, body: Record<string, unknown>, csrfToken?: string | null) =>
    apiWrite<{ pairing: ChannelActorPairingRow }>(`/agents/${encodeURIComponent(agentKey)}/channel-actor-pairings`, {
      body,
      csrfToken,
    }),
  deleteChannelActorPairing: (
    agentKey: string,
    row: Pick<ChannelActorPairingRow, "source" | "connectorKey" | "externalActorId">,
    csrfToken?: string | null
  ) =>
    apiWrite<{ deleted: boolean }>(
      `/agents/${encodeURIComponent(agentKey)}/channel-actor-pairings/${encodeURIComponent(row.source)}/${encodeURIComponent(
        row.connectorKey
      )}/${encodeURIComponent(row.externalActorId)}`,
      { method: "DELETE", csrfToken }
    ),
  skills: (agentKey: string, params: TableParams) =>
    apiGet<PaginatedResponse<SkillRow>>(`/agents/${encodeURIComponent(agentKey)}/skills${qs(params)}`),
  skill: (agentKey: string, skillKey: string) =>
    apiGet<{ skill: SkillRow }>(`/agents/${encodeURIComponent(agentKey)}/skills/${encodeURIComponent(skillKey)}`),
  setSkill: (agentKey: string, body: Record<string, unknown>, csrfToken?: string | null) =>
    apiWrite<{ skill: SkillRow }>(`/agents/${encodeURIComponent(agentKey)}/skills`, { body, csrfToken }),
  deleteSkill: (agentKey: string, skillKey: string, csrfToken?: string | null) =>
    apiWrite<{ deleted: boolean }>(`/agents/${encodeURIComponent(agentKey)}/skills/${encodeURIComponent(skillKey)}`, {
      method: "DELETE",
      csrfToken,
    }),
  subagents: (agentKey: string, params: TableParams) =>
    apiGet<PaginatedResponse<SubagentRow>>(`/agents/${encodeURIComponent(agentKey)}/subagents${qs(params)}`),
  subagent: (agentKey: string, slug: string) =>
    apiGet<{ subagent: SubagentRow }>(`/agents/${encodeURIComponent(agentKey)}/subagents/${encodeURIComponent(slug)}`),
  setSubagent: (agentKey: string, body: Record<string, unknown>, csrfToken?: string | null) =>
    apiWrite<{ subagent: SubagentRow }>(`/agents/${encodeURIComponent(agentKey)}/subagents`, { body, csrfToken }),
  setSubagentEnabled: (agentKey: string, slug: string, enabled: boolean, csrfToken?: string | null) =>
    apiWrite<{ subagent: SubagentRow }>(`/agents/${encodeURIComponent(agentKey)}/subagents/${encodeURIComponent(slug)}`, {
      method: "PATCH",
      body: { enabled },
      csrfToken,
    }),
  gatewaySources: (agentKey: string, params: TableParams) =>
    apiGet<PaginatedResponse<GatewaySourceRow>>(`/agents/${encodeURIComponent(agentKey)}/gateway/sources${qs(params)}`),
  createGatewaySource: (agentKey: string, body: Record<string, unknown>, csrfToken?: string | null) =>
    apiWrite<{ source: GatewaySourceRow; clientSecret: string }>(`/agents/${encodeURIComponent(agentKey)}/gateway/sources`, {
      body,
      csrfToken,
    }),
  rotateGatewaySource: (agentKey: string, sourceId: string, csrfToken?: string | null) =>
    apiWrite<{ source: GatewaySourceRow; clientSecret: string }>(
      `/agents/${encodeURIComponent(agentKey)}/gateway/sources/${encodeURIComponent(sourceId)}/rotate-secret`,
      { csrfToken }
    ),
  setGatewaySourceSuspended: (agentKey: string, sourceId: string, suspended: boolean, reason: string, csrfToken?: string | null) =>
    apiWrite<{ source: GatewaySourceRow }>(`/agents/${encodeURIComponent(agentKey)}/gateway/sources/${encodeURIComponent(sourceId)}`, {
      method: "PATCH",
      body: { suspended, reason },
      csrfToken,
    }),
  gatewayDevices: (agentKey: string, sourceId: string, params: TableParams = {}) =>
    apiGet<GatewayDevices>(
      `/agents/${encodeURIComponent(agentKey)}/gateway/sources/${encodeURIComponent(sourceId)}/devices${qs(params)}`
    ),
  registerGatewayDevice: (agentKey: string, sourceId: string, body: Record<string, unknown>, csrfToken?: string | null) =>
    apiWrite<{ device: GatewayDeviceRow; token: string }>(
      `/agents/${encodeURIComponent(agentKey)}/gateway/sources/${encodeURIComponent(sourceId)}/devices`,
      { body, csrfToken }
    ),
  setGatewayDeviceEnabled: (agentKey: string, sourceId: string, deviceId: string, enabled: boolean, csrfToken?: string | null) =>
    apiWrite<{ device: GatewayDeviceRow }>(
      `/agents/${encodeURIComponent(agentKey)}/gateway/sources/${encodeURIComponent(sourceId)}/devices/${encodeURIComponent(deviceId)}`,
      {
        method: "PATCH",
        body: { enabled },
        csrfToken,
      }
    ),
  gatewayEventTypes: (agentKey: string, sourceId: string, params: TableParams = {}) =>
    apiGet<PaginatedResponse<GatewayEventTypeRow>>(
      `/agents/${encodeURIComponent(agentKey)}/gateway/sources/${encodeURIComponent(sourceId)}/event-types${qs(params)}`
    ),
  upsertGatewayEventType: (agentKey: string, sourceId: string, body: Record<string, unknown>, csrfToken?: string | null) =>
    apiWrite<{ eventType: GatewayEventTypeRow }>(
      `/agents/${encodeURIComponent(agentKey)}/gateway/sources/${encodeURIComponent(sourceId)}/event-types`,
      { body, csrfToken }
    ),
  deleteGatewayEventType: (agentKey: string, sourceId: string, type: string, csrfToken?: string | null) =>
    apiWrite<{ deleted: boolean }>(
      `/agents/${encodeURIComponent(agentKey)}/gateway/sources/${encodeURIComponent(sourceId)}/event-types/${encodeURIComponent(type)}`,
      { method: "DELETE", csrfToken }
    ),
  gatewayEvents: (agentKey: string, params: TableParams & { sourceId?: string }) =>
    apiGet<PaginatedResponse<GatewayEventRow>>(`/agents/${encodeURIComponent(agentKey)}/gateway/events${qs(params)}`),
  sessionGatewayEvents: (agentKey: string, sessionId: string, params: TableParams) =>
    apiGet<PaginatedResponse<GatewayEventRow>>(
      `/agents/${encodeURIComponent(agentKey)}/sessions/${encodeURIComponent(sessionId)}/gateway-events${qs(params)}`
    ),
  briefing: (agentKey: string, sessionId: string) =>
    apiGet<{ briefing: Briefing }>(`/agents/${encodeURIComponent(agentKey)}/sessions/${encodeURIComponent(sessionId)}/briefing`),
  setBriefing: (agentKey: string, sessionId: string, content: string, csrfToken?: string | null) =>
    apiWrite<{ briefing: Briefing }>(`/agents/${encodeURIComponent(agentKey)}/sessions/${encodeURIComponent(sessionId)}/briefing`, {
      method: "PUT",
      body: { content },
      csrfToken,
    }),
  deleteBriefing: (agentKey: string, sessionId: string, csrfToken?: string | null) =>
    apiWrite<{ briefing: Briefing }>(`/agents/${encodeURIComponent(agentKey)}/sessions/${encodeURIComponent(sessionId)}/briefing`, {
      method: "DELETE",
      body: { confirm: "clear-session-briefing" },
      csrfToken,
    }),
  heartbeat: (agentKey: string, sessionId: string) =>
    apiGet<{ heartbeat: Heartbeat }>(`/agents/${encodeURIComponent(agentKey)}/sessions/${encodeURIComponent(sessionId)}/heartbeat`),
  updateHeartbeat: (agentKey: string, sessionId: string, body: Record<string, unknown>, csrfToken?: string | null) =>
    apiWrite<{ heartbeat: Heartbeat }>(`/agents/${encodeURIComponent(agentKey)}/sessions/${encodeURIComponent(sessionId)}/heartbeat`, {
      method: "PATCH",
      body,
      csrfToken,
    }),
  runtime: (agentKey: string, sessionId: string, params: TableParams = {}) =>
    apiGet<{ runtimeActivity: RuntimeActivity }>(
      `/agents/${encodeURIComponent(agentKey)}/sessions/${encodeURIComponent(sessionId)}/runtime-activity${qs(params)}`
    ),
  modelCallTraces: (params: TableParams = {}) =>
    apiGet<{ modelCallTraces: PaginatedResponse<ModelCallTraceSummary> }>(
      `/model-call-traces${qs(params)}`
    ),
  modelCallTrace: (traceId: string) =>
    apiGet<{ modelCallTrace: ModelCallTraceDetail }>(
      `/model-call-traces/${encodeURIComponent(traceId)}`
    ),
  scheduledTasks: (agentKey: string, sessionId: string, params: TableParams = {}) =>
    apiGet<{ scheduledTasks: ScheduledTasks }>(
      `/agents/${encodeURIComponent(agentKey)}/sessions/${encodeURIComponent(sessionId)}/scheduled-tasks${qs(params)}`
    ),
  createScheduledTask: (agentKey: string, sessionId: string, body: Record<string, unknown>, csrfToken?: string | null) =>
    apiWrite<{ scheduledTask: ScheduledTask }>(
      `/agents/${encodeURIComponent(agentKey)}/sessions/${encodeURIComponent(sessionId)}/scheduled-tasks`,
      { body, csrfToken }
    ),
  updateScheduledTask: (agentKey: string, sessionId: string, taskId: string, body: Record<string, unknown>, csrfToken?: string | null) =>
    apiWrite<{ scheduledTask: ScheduledTask }>(
      `/agents/${encodeURIComponent(agentKey)}/sessions/${encodeURIComponent(sessionId)}/scheduled-tasks/${encodeURIComponent(taskId)}`,
      { method: "PATCH", body, csrfToken }
    ),
  cancelScheduledTask: (agentKey: string, sessionId: string, taskId: string, reason: string, csrfToken?: string | null) =>
    apiWrite<{ scheduledTask: ScheduledTask }>(
      `/agents/${encodeURIComponent(agentKey)}/sessions/${encodeURIComponent(sessionId)}/scheduled-tasks/${encodeURIComponent(taskId)}`,
      { method: "DELETE", body: { reason }, csrfToken }
    ),
  watches: (agentKey: string, sessionId: string, params: TableParams = {}) =>
    apiGet<{ watches: Watches }>(
      `/agents/${encodeURIComponent(agentKey)}/sessions/${encodeURIComponent(sessionId)}/watches${qs(params)}`
    ),
  updateWatch: (agentKey: string, sessionId: string, watchId: string, body: Record<string, unknown>, csrfToken?: string | null) =>
    apiWrite<{ watch: WatchRow }>(
      `/agents/${encodeURIComponent(agentKey)}/sessions/${encodeURIComponent(sessionId)}/watches/${encodeURIComponent(watchId)}`,
      { method: "PATCH", body, csrfToken }
    ),
  disableWatch: (agentKey: string, sessionId: string, watchId: string, reason: string, csrfToken?: string | null) =>
    apiWrite<{ watch: WatchRow }>(
      `/agents/${encodeURIComponent(agentKey)}/sessions/${encodeURIComponent(sessionId)}/watches/${encodeURIComponent(watchId)}`,
      { method: "DELETE", body: { reason }, csrfToken }
    ),
  audit: (params: TableParams & { eventType?: string; agentKey?: string; targetSessionId?: string }) =>
    apiGet<PaginatedResponse<AuditEvent>>(`/audit-events${qs(params)}`),
}
