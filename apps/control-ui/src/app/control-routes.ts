import type { LucideIcon } from "lucide-react"
import {
  Activity,
  BookOpen,
  Bot,
  CalendarClock,
  Eye,
  FileText,
  GitBranch,
  History,
  Home,
  KeyRound,
  Link2,
  Network,
  Plug,
  RadioTower,
  ShieldCheck,
  UserCheck,
  Users,
  Wrench,
} from "lucide-react"

import type { AgentDetail } from "@/lib/api"

export type ConsoleNavItem = {
  icon: LucideIcon
  id: "home" | "agents" | "identities"
  label: string
  path: string
}

export type ControlTabDefinition = {
  count?: (agent: AgentDetail | undefined) => number | undefined
  icon: LucideIcon
  label: string
  value: string
}

export const DEFAULT_AGENT_TAB = "sessions"
export const DEFAULT_SESSION_TAB = "briefing"

export const CONSOLE_NAVIGATION: ConsoleNavItem[] = [
  { id: "home", path: "/", label: "Home", icon: Home },
  { id: "agents", path: "/agents", label: "Agents", icon: Bot },
  { id: "identities", path: "/identities", label: "Identities", icon: UserCheck },
]

export const AGENT_RESOURCE_TABS: ControlTabDefinition[] = [
  {
    value: "sessions",
    label: "Sessions",
    icon: GitBranch,
    count: (agent) => agent?.sessionCount,
  },
  {
    value: "skills",
    label: "Skills",
    icon: Wrench,
    count: (agent) => agent?.skillCount,
  },
  {
    value: "subagents",
    label: "Subagents",
    icon: Users,
    count: (agent) => agent?.subagentCount,
  },
  {
    value: "connectors",
    label: "Connectors",
    icon: Plug,
    count: (agent) => agent?.connectorCount,
  },
  { value: "bindings", label: "Bindings", icon: Link2 },
  {
    value: "credentials",
    label: "Credentials",
    icon: KeyRound,
    count: (agent) => agent?.credentialCount,
  },
  {
    value: "gateway",
    label: "Gateway",
    icon: RadioTower,
    count: (agent) => agent?.gatewaySourceCount,
  },
  {
    value: "access",
    label: "Access",
    icon: UserCheck,
    count: (agent) => agent?.pairingCount,
  },
  {
    value: "wiki",
    label: "Wiki",
    icon: BookOpen,
    count: (agent) => (agent?.wikiBindingSet ? 1 : 0),
  },
  { value: "audit", label: "Audit", icon: History },
]

export const PARENT_AGENT_SHORTCUT_TABS: ControlTabDefinition[] =
  AGENT_RESOURCE_TABS.filter((tab) =>
    ["sessions", "skills", "subagents", "connectors", "bindings"].includes(tab.value)
  ).map((tab) =>
    tab.value === "sessions" ? { ...tab, label: "All sessions" } : tab
  )

export const SESSION_RESOURCE_TABS: ControlTabDefinition[] = [
  { value: "briefing", label: "Briefing", icon: FileText },
  { value: "watches", label: "Watches", icon: Eye },
  { value: "automations", label: "Automations", icon: CalendarClock },
  { value: "bindings", label: "Channel Bindings", icon: Network },
  { value: "gateway", label: "Gateway Events", icon: RadioTower },
  { value: "a2a", label: "A2A", icon: Link2 },
  { value: "runtime", label: "Runtime", icon: Activity },
  { value: "audit", label: "Audit", icon: ShieldCheck },
]

export function agentPath(agentKey: string) {
  return `/agents/${encodeURIComponent(agentKey)}`
}

export function agentTabPath(agentKey: string, tab = DEFAULT_AGENT_TAB) {
  return `${agentPath(agentKey)}?tab=${encodeURIComponent(tab)}`
}

export function sessionPath(agentKey: string, sessionId: string) {
  return `${agentPath(agentKey)}/sessions/${encodeURIComponent(sessionId)}`
}

export function sessionTabPath(
  agentKey: string,
  sessionId: string,
  tab = DEFAULT_SESSION_TAB
) {
  return `${sessionPath(agentKey, sessionId)}?tab=${encodeURIComponent(tab)}`
}

export function agentTabCount(
  agent: AgentDetail | undefined,
  tabValue: string
) {
  return AGENT_RESOURCE_TABS.find((tab) => tab.value === tabValue)?.count?.(
    agent
  )
}

export function filterConsoleNavigation(search: string) {
  const normalized = search.trim().toLowerCase()
  if (!normalized) return CONSOLE_NAVIGATION
  return CONSOLE_NAVIGATION.filter((item) =>
    item.label.toLowerCase().includes(normalized)
  )
}

export function isConsoleNavActive(pathname: string, path: string) {
  if (path === "/") return pathname === "/"
  return pathname === path || pathname.startsWith(`${path}/`)
}

export function parseControlRouteContext(pathname: string) {
  const parts = pathname.split("/").filter(Boolean)
  if (parts[0] !== "agents" || !parts[1]) {
    return { agentKey: null, sessionId: null }
  }

  return {
    agentKey: safeDecode(parts[1]),
    sessionId:
      parts[2] === "sessions" && parts[3] ? safeDecode(parts[3]) : null,
  }
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
