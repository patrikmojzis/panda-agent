import { useQuery } from "@tanstack/react-query"

import { controlApi, type TableParams } from "@/lib/api"
import { controlKeys } from "@/features/control/api/query-key-factory"

type QueryFlags = {
  enabled?: boolean
  staleTime?: number
}

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

export function keepPrevious<T>(previous: T | undefined) {
  return previous
}

export function useControlSession(enabled: boolean) {
  return useQuery({
    queryKey: controlKeys.me(),
    queryFn: controlApi.me,
    enabled,
    retry: false,
  })
}

export function useControlSearch(search: string, options?: QueryFlags) {
  const perPage = 8
  return useQuery({
    queryKey: controlKeys.search(search, perPage),
    queryFn: () => controlApi.search({ search, per_page: perPage }),
    enabled: options?.enabled,
    staleTime: options?.staleTime,
  })
}

export function useWorkFailures(params: FailureParams) {
  return useQuery({
    queryKey: controlKeys.failures.list(params),
    queryFn: () => controlApi.failures(params),
    placeholderData: keepPrevious,
  })
}

export function useWorkFailureSummary(params: FailureParams) {
  return useQuery({
    queryKey: controlKeys.failures.summary(params),
    queryFn: () => controlApi.failures(params),
    placeholderData: keepPrevious,
  })
}

export function useAgents(params: TableParams, options?: QueryFlags) {
  return useQuery({
    queryKey: controlKeys.agents.list(params),
    queryFn: () => controlApi.agents(params),
    enabled: options?.enabled,
    placeholderData: keepPrevious,
    staleTime: options?.staleTime,
  })
}

export function useControlIdentities(params: TableParams, options?: QueryFlags) {
  return useQuery({
    queryKey: controlKeys.identities.list(params),
    queryFn: () => controlApi.identities(params),
    enabled: options?.enabled,
    placeholderData: keepPrevious,
    staleTime: options?.staleTime,
  })
}

export function useAgent(agentKey: string, options?: QueryFlags) {
  return useQuery({
    queryKey: controlKeys.agents.detail(agentKey),
    queryFn: () => controlApi.agent(agentKey),
    enabled: options?.enabled ?? Boolean(agentKey),
    staleTime: options?.staleTime,
  })
}

export function useAgentPairings(
  agentKey: string,
  params: TableParams,
  options?: QueryFlags
) {
  return useQuery({
    queryKey: controlKeys.agents.pairings(agentKey, params),
    queryFn: () => controlApi.agentPairings(agentKey, params),
    enabled: options?.enabled ?? Boolean(agentKey),
    placeholderData: keepPrevious,
    staleTime: options?.staleTime,
  })
}

export function useAgentSessions(
  agentKey: string,
  params: TableParams,
  options?: QueryFlags
) {
  return useQuery({
    queryKey: controlKeys.agents.sessions(agentKey, params),
    queryFn: () => controlApi.sessions(agentKey, params),
    enabled: options?.enabled ?? Boolean(agentKey),
    placeholderData: keepPrevious,
    staleTime: options?.staleTime,
  })
}

export function useAgentCredentials(
  agentKey: string,
  params: TableParams,
  options?: QueryFlags
) {
  return useQuery({
    queryKey: controlKeys.agents.credentials(agentKey, params),
    queryFn: () => controlApi.credentials(agentKey, params),
    enabled: options?.enabled ?? Boolean(agentKey),
    placeholderData: keepPrevious,
    staleTime: options?.staleTime,
  })
}

export function useAgentWikiBinding(agentKey: string, options?: QueryFlags) {
  return useQuery({
    queryKey: controlKeys.agents.wikiBinding(agentKey),
    queryFn: () => controlApi.wikiBinding(agentKey),
    enabled: options?.enabled ?? Boolean(agentKey),
    staleTime: options?.staleTime,
  })
}

export function useAgentConnectors(
  agentKey: string,
  params: TableParams,
  options?: QueryFlags
) {
  return useQuery({
    queryKey: controlKeys.agents.connectors(agentKey, params),
    queryFn: () => controlApi.connectors(agentKey, params),
    enabled: options?.enabled ?? Boolean(agentKey),
    placeholderData: keepPrevious,
    staleTime: options?.staleTime,
  })
}

export function useTelegramSetupStatus(agentKey: string, accountKey: string, options?: QueryFlags) {
  return useQuery({
    queryKey: controlKeys.agents.telegramSetup(agentKey, accountKey),
    queryFn: () => controlApi.telegramSetupStatus(agentKey, accountKey),
    enabled: options?.enabled ?? Boolean(agentKey && accountKey),
    staleTime: options?.staleTime,
  })
}

export function useAgentBindings(agentKey: string, params: TableParams) {
  return useQuery({
    queryKey: controlKeys.agents.bindings(agentKey, params),
    queryFn: () => controlApi.bindings(agentKey, params),
    enabled: Boolean(agentKey),
    placeholderData: keepPrevious,
  })
}

export function useAgentEmailRoutes(agentKey: string, params: TableParams) {
  return useQuery({
    queryKey: controlKeys.agents.emailRoutes(agentKey, params),
    queryFn: () => controlApi.emailRoutes(agentKey, params),
    enabled: Boolean(agentKey),
    placeholderData: keepPrevious,
  })
}

export function useAgentEmailAllowedRecipients(agentKey: string, params: TableParams) {
  return useQuery({
    queryKey: controlKeys.agents.emailAllowedRecipients(agentKey, params),
    queryFn: () => controlApi.emailAllowedRecipients(agentKey, params),
    enabled: Boolean(agentKey),
    placeholderData: keepPrevious,
  })
}

export function useAgentDiscordActorPairings(agentKey: string, params: TableParams) {
  return useQuery({
    queryKey: controlKeys.agents.discordActorPairings(agentKey, params),
    queryFn: () => controlApi.discordActorPairings(agentKey, params),
    enabled: Boolean(agentKey),
    placeholderData: keepPrevious,
  })
}

export function useAgentChannelActorPairings(agentKey: string, params: TableParams) {
  return useQuery({
    queryKey: controlKeys.agents.channelActorPairings(agentKey, params),
    queryFn: () => controlApi.channelActorPairings(agentKey, params),
    enabled: Boolean(agentKey),
    placeholderData: keepPrevious,
  })
}

export function useAgentSkills(agentKey: string, params: TableParams) {
  return useQuery({
    queryKey: controlKeys.agents.skills(agentKey, params),
    queryFn: () => controlApi.skills(agentKey, params),
    enabled: Boolean(agentKey),
    placeholderData: keepPrevious,
  })
}

export function useAgentSubagents(agentKey: string, params: TableParams) {
  return useQuery({
    queryKey: controlKeys.agents.subagents(agentKey, params),
    queryFn: () => controlApi.subagents(agentKey, params),
    enabled: Boolean(agentKey),
    placeholderData: keepPrevious,
  })
}

export function useGatewaySources(
  agentKey: string,
  params: TableParams,
  options?: QueryFlags
) {
  return useQuery({
    queryKey: controlKeys.agents.gatewaySources(agentKey, params),
    queryFn: () => controlApi.gatewaySources(agentKey, params),
    enabled: options?.enabled ?? Boolean(agentKey),
    placeholderData: keepPrevious,
    staleTime: options?.staleTime,
  })
}

export function useGatewayDevices(
  agentKey: string,
  sourceId: string,
  params: TableParams = {},
  options?: QueryFlags
) {
  return useQuery({
    queryKey: controlKeys.agents.gatewayDevices(agentKey, sourceId, params),
    queryFn: () => controlApi.gatewayDevices(agentKey, sourceId, params),
    enabled: options?.enabled ?? Boolean(agentKey && sourceId),
    placeholderData: keepPrevious,
    staleTime: options?.staleTime,
  })
}

export function useGatewayEventTypes(
  agentKey: string,
  sourceId: string,
  params: TableParams,
  options?: QueryFlags
) {
  return useQuery({
    queryKey: controlKeys.agents.gatewayEventTypes(agentKey, sourceId, params),
    queryFn: () => controlApi.gatewayEventTypes(agentKey, sourceId, params),
    enabled: options?.enabled ?? Boolean(agentKey && sourceId),
    staleTime: options?.staleTime,
  })
}

export function useGatewayEvents(
  agentKey: string,
  params: TableParams & { sourceId?: string },
  options?: QueryFlags
) {
  return useQuery({
    queryKey: controlKeys.agents.gatewayEvents(agentKey, params),
    queryFn: () => controlApi.gatewayEvents(agentKey, params),
    enabled: options?.enabled ?? Boolean(agentKey),
    placeholderData: keepPrevious,
  })
}

export function useSessionGatewayEvents(
  agentKey: string,
  sessionId: string,
  params: TableParams,
  options?: QueryFlags
) {
  return useQuery({
    queryKey: controlKeys.sessions.gatewayEvents(agentKey, sessionId, params),
    queryFn: () => controlApi.sessionGatewayEvents(agentKey, sessionId, params),
    enabled: options?.enabled ?? Boolean(agentKey && sessionId),
    placeholderData: keepPrevious,
  })
}

export function useScopedGatewayEvents(
  agentKey: string,
  sessionId: string | undefined,
  params: TableParams
) {
  return useQuery({
    queryKey: sessionId
      ? controlKeys.sessions.gatewayEvents(agentKey, sessionId, params)
      : controlKeys.agents.gatewayEvents(agentKey, params),
    queryFn: () =>
      sessionId
        ? controlApi.sessionGatewayEvents(agentKey, sessionId, params)
        : controlApi.gatewayEvents(agentKey, params),
    enabled: Boolean(agentKey),
    placeholderData: keepPrevious,
  })
}

export function useRuntimeActivity(
  agentKey: string,
  sessionId: string,
  params: TableParams
) {
  return useQuery({
    queryKey: controlKeys.sessions.runtime(agentKey, sessionId, params),
    queryFn: () => controlApi.runtime(agentKey, sessionId, params),
    enabled: Boolean(agentKey && sessionId),
    placeholderData: keepPrevious,
  })
}

export function useA2ABindings(
  agentKey: string,
  sessionId: string,
  params: TableParams
) {
  return useQuery({
    queryKey: controlKeys.sessions.a2aBindings(agentKey, sessionId, params),
    queryFn: () => controlApi.a2aBindings(agentKey, sessionId, params),
    enabled: Boolean(agentKey && sessionId),
    placeholderData: keepPrevious,
  })
}

export function useBriefing(agentKey: string, sessionId: string) {
  return useQuery({
    queryKey: controlKeys.sessions.briefing(agentKey, sessionId),
    queryFn: () => controlApi.briefing(agentKey, sessionId),
    enabled: Boolean(agentKey && sessionId),
  })
}

export function useHeartbeat(agentKey: string, sessionId: string) {
  return useQuery({
    queryKey: controlKeys.sessions.heartbeat(agentKey, sessionId),
    queryFn: () => controlApi.heartbeat(agentKey, sessionId),
    enabled: Boolean(agentKey && sessionId),
  })
}

export function useScheduledTasks(
  agentKey: string,
  sessionId: string,
  params: TableParams = {}
) {
  return useQuery({
    queryKey: controlKeys.sessions.scheduledTasks(agentKey, sessionId, params),
    queryFn: () => controlApi.scheduledTasks(agentKey, sessionId, params),
    enabled: Boolean(agentKey && sessionId),
    placeholderData: keepPrevious,
  })
}

export function useWatches(
  agentKey: string,
  sessionId: string,
  params: TableParams = {}
) {
  return useQuery({
    queryKey: controlKeys.sessions.watches(agentKey, sessionId, params),
    queryFn: () => controlApi.watches(agentKey, sessionId, params),
    enabled: Boolean(agentKey && sessionId),
    placeholderData: keepPrevious,
  })
}

export function useSessionDetail(
  agentKey: string,
  sessionId: string,
  options?: QueryFlags
) {
  return useQuery({
    queryKey: controlKeys.agents.session(agentKey, sessionId),
    queryFn: () => controlApi.session(agentKey, sessionId),
    enabled: options?.enabled ?? Boolean(agentKey && sessionId),
    staleTime: options?.staleTime,
  })
}

export function useSkillDetail(
  agentKey: string,
  skillKey: string,
  options?: QueryFlags
) {
  return useQuery({
    queryKey: controlKeys.agents.skill(agentKey, skillKey),
    queryFn: () => controlApi.skill(agentKey, skillKey),
    enabled: options?.enabled ?? Boolean(agentKey && skillKey),
  })
}

export function useSubagentDetail(
  agentKey: string,
  slug: string,
  options?: QueryFlags
) {
  return useQuery({
    queryKey: controlKeys.agents.subagent(agentKey, slug),
    queryFn: () => controlApi.subagent(agentKey, slug),
    enabled: options?.enabled ?? Boolean(agentKey && slug),
  })
}

export function useAuditEvents(params: AuditParams) {
  return useQuery({
    queryKey: controlKeys.audit.list(params),
    queryFn: () => controlApi.audit(params),
    placeholderData: keepPrevious,
  })
}
