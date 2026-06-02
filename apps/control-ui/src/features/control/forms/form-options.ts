import * as React from "react"

import {
  useAgents,
  useAgentConnectors,
  useAgentSessions,
  useControlIdentities,
  useGatewaySources,
} from "@/features/control/api/queries"
import type { AgentSheetContext } from "@/features/control/forms/use-control-form-sheets"
import {
  sessionPickerLabel,
  shortSessionId,
} from "@/features/control/session-labels"
import type { AgentRow, ConnectorRow, GatewaySourceRow } from "@/lib/api"

export function useAgentOptions(isOpen: boolean, selectedAgentKey?: string) {
  const agents = useAgents(
    {
      per_page: 100,
      sort_by: "agentKey",
      sort_direction: "asc",
    },
    { enabled: isOpen, staleTime: 30_000 }
  )

  const options = React.useMemo(() => {
    const baseOptions = (agents.data?.data ?? []).map((agent) => ({
      label: agentPickerLabel(agent),
      value: agent.agentKey,
    }))
    if (
      selectedAgentKey &&
      !baseOptions.some((option) => option.value === selectedAgentKey)
    ) {
      return [
        {
          label: `Selected agent · ${selectedAgentKey}`,
          value: selectedAgentKey,
        },
        ...baseOptions,
      ]
    }
    return baseOptions
  }, [agents.data?.data, selectedAgentKey])

  return {
    isLoading: agents.isLoading,
    options,
  }
}

export function useSessionOptions(
  context: AgentSheetContext | undefined,
  isOpen: boolean,
  selectedSessionId?: string
) {
  const agentKey = context?.agentKey ?? ""
  const sessions = useAgentSessions(
    agentKey,
    {
      per_page: 100,
      sort_by: "updatedAt",
      sort_direction: "desc",
    },
    { enabled: Boolean(isOpen && agentKey), staleTime: 30_000 }
  )

  const options = React.useMemo(() => {
    const baseOptions = (sessions.data?.data ?? []).map((session) => ({
      label: sessionPickerLabel(session),
      value: session.id,
    }))
    if (
      selectedSessionId &&
      !baseOptions.some((option) => option.value === selectedSessionId)
    ) {
      return [
        {
          label: `Selected session · ${shortSessionId(selectedSessionId)}`,
          value: selectedSessionId,
        },
        ...baseOptions,
      ]
    }
    return baseOptions
  }, [selectedSessionId, sessions.data?.data])

  return {
    isLoading: sessions.isLoading,
    options,
  }
}

export function useConnectorOptions(
  context: AgentSheetContext | undefined,
  isOpen: boolean,
  selectedConnectorKey?: string,
  source = "discord"
) {
  const agentKey = context?.agentKey ?? ""
  const connectors = useAgentConnectors(
    agentKey,
    {
      per_page: 100,
      sort_by: "accountKey",
      sort_direction: "asc",
    },
    { enabled: Boolean(isOpen && agentKey), staleTime: 30_000 }
  )

  const options = React.useMemo(() => {
    const baseOptions = (connectors.data?.data ?? [])
      .filter((connector) => connector.source === source)
      .map((connector) => ({
        label: connectorPickerLabel(connector),
        value: connector.connectorKey,
      }))
    if (
      selectedConnectorKey &&
      !baseOptions.some((option) => option.value === selectedConnectorKey)
    ) {
      return [
        {
          label: `Selected connector · ${selectedConnectorKey}`,
          value: selectedConnectorKey,
        },
        ...baseOptions,
      ]
    }
    return baseOptions
  }, [connectors.data?.data, selectedConnectorKey, source])

  return {
    isLoading: connectors.isLoading,
    options,
  }
}

export function useEmailAccountOptions(
  context: AgentSheetContext | undefined,
  isOpen: boolean,
  selectedAccountKey?: string
) {
  const agentKey = context?.agentKey ?? ""
  const connectors = useAgentConnectors(
    agentKey,
    {
      per_page: 100,
      sort_by: "accountKey",
      sort_direction: "asc",
      source: "email",
    },
    { enabled: Boolean(isOpen && agentKey), staleTime: 30_000 }
  )

  const options = React.useMemo(() => {
    const baseOptions = (connectors.data?.data ?? [])
      .filter((connector) => connector.source === "email")
      .map((connector) => ({
        label: emailAccountPickerLabel(connector),
        value: connector.accountKey,
      }))
    if (
      selectedAccountKey &&
      !baseOptions.some((option) => option.value === selectedAccountKey)
    ) {
      return [
        {
          label: `Selected account · ${selectedAccountKey}`,
          value: selectedAccountKey,
        },
        ...baseOptions,
      ]
    }
    return baseOptions
  }, [connectors.data?.data, selectedAccountKey])

  return {
    isLoading: connectors.isLoading,
    options,
  }
}

export function useDiscordAccountOptions(
  context: AgentSheetContext | undefined,
  isOpen: boolean,
  selectedAccountKey?: string
) {
  const agentKey = context?.agentKey ?? ""
  const connectors = useAgentConnectors(
    agentKey,
    {
      per_page: 100,
      sort_by: "accountKey",
      sort_direction: "asc",
      source: "discord",
    },
    { enabled: Boolean(isOpen && agentKey), staleTime: 30_000 }
  )

  const options = React.useMemo(() => {
    const baseOptions = (connectors.data?.data ?? [])
      .filter((connector) => connector.source === "discord")
      .map((connector) => ({
        label: discordAccountPickerLabel(connector),
        value: connector.accountKey,
      }))
    if (
      selectedAccountKey &&
      !baseOptions.some((option) => option.value === selectedAccountKey)
    ) {
      return [
        {
          label: `Selected account · ${selectedAccountKey}`,
          value: selectedAccountKey,
        },
        ...baseOptions,
      ]
    }
    return baseOptions
  }, [connectors.data?.data, selectedAccountKey])

  return {
    isLoading: connectors.isLoading,
    options,
  }
}

export function useIdentityOptions(isOpen: boolean, selectedIdentityId?: string) {
  const identities = useControlIdentities(
    {
      per_page: 100,
      sort_by: "handle",
      sort_direction: "asc",
      status: "active",
    },
    { enabled: isOpen, staleTime: 30_000 }
  )

  const options = React.useMemo(() => {
    const baseOptions = (identities.data?.data ?? []).map((identity) => ({
      label: identityPickerLabel(identity),
      value: identity.id,
    }))
    if (
      selectedIdentityId &&
      !baseOptions.some((option) => option.value === selectedIdentityId)
    ) {
      return [
        {
          label: `Selected identity · ${selectedIdentityId}`,
          value: selectedIdentityId,
        },
        ...baseOptions,
      ]
    }
    return baseOptions
  }, [identities.data?.data, selectedIdentityId])

  return {
    isLoading: identities.isLoading,
    options,
  }
}

export function useGatewaySourceOptions(
  context: AgentSheetContext | undefined,
  isOpen: boolean,
  selectedSourceId?: string
) {
  const agentKey = context?.agentKey ?? ""
  const sources = useGatewaySources(
    agentKey,
    {
      per_page: 100,
      sort_by: "sourceId",
      sort_direction: "asc",
    },
    { enabled: Boolean(isOpen && agentKey), staleTime: 30_000 }
  )

  const options = React.useMemo(() => {
    const baseOptions = (sources.data?.data ?? []).map((source) => ({
      label: gatewaySourcePickerLabel(source),
      value: source.sourceId,
    }))
    if (
      selectedSourceId &&
      !baseOptions.some((option) => option.value === selectedSourceId)
    ) {
      return [
        {
          label: `Selected source · ${selectedSourceId}`,
          value: selectedSourceId,
        },
        ...baseOptions,
      ]
    }
    return baseOptions
  }, [selectedSourceId, sources.data?.data])

  return {
    isLoading: sources.isLoading,
    options,
  }
}

function connectorPickerLabel(connector: ConnectorRow) {
  const name = connector.displayName?.trim() || connector.accountKey
  const account =
    name === connector.accountKey ? connector.source : connector.accountKey
  return `${name} · ${account} · ${connector.connectorKey}`
}

function agentPickerLabel(agent: AgentRow) {
  const name = agent.displayName.trim()
  return name && name !== agent.agentKey ? `${name} · ${agent.agentKey}` : agent.agentKey
}

function emailAccountPickerLabel(connector: ConnectorRow) {
  const name = connector.displayName?.trim() || connector.accountKey
  const address = connector.email?.fromAddress ?? connector.externalUsername
  return address ? `${name} · ${address}` : name
}

function discordAccountPickerLabel(connector: ConnectorRow) {
  const name = connector.displayName?.trim() || connector.accountKey
  return `${name} · ${connector.accountKey} · ${connector.connectorKey}`
}

function identityPickerLabel(identity: { handle: string; displayName: string }) {
  return identity.displayName.trim()
    ? `${identity.displayName} · ${identity.handle}`
    : identity.handle
}

function gatewaySourcePickerLabel(source: GatewaySourceRow) {
  const name = source.name?.trim() || source.sourceId
  const route = source.sessionId ? `session ${shortSessionId(source.sessionId)}` : "agent default"
  return `${name} · ${source.sourceId} · ${route}`
}
