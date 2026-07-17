import * as React from "react"
import { useParams, useSearchParams } from "react-router-dom"
import {
  BookOpen,
  GitBranch,
  KeyRound,
  ListChecks,
  Link2,
  Mail,
  MoreHorizontal,
  Plug,
  Plus,
  RadioTower,
  Smartphone,
  UserPlus,
  Users,
  Wrench,
} from "lucide-react"

import {
  DetailPageContent,
  PageHeader,
  type DetailContentTab,
} from "@/components/common/shared/page-layout"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  AGENT_RESOURCE_TABS,
  DEFAULT_AGENT_TAB,
  agentTabCount,
} from "@/app/control-routes"
import { StatusBadge } from "@/features/control/control-display"
import { useAgent } from "@/features/control/api/queries"
import { AuditPanel } from "@/features/control/audit/audit-panel"
import {
  AccessPanel,
  BindingsPanel,
  ConnectorsPanel,
  CredentialsPanel,
  McpPanel,
  SkillsPanel,
  SubagentsPanel,
  WikiPanel,
} from "@/features/control/agent/agent-resource-panels"
import {
  useBindingSheet,
  useAgentPairingSheet,
  useCreateSessionSheet,
  useCredentialSheet,
  useDiscordConnectorSheet,
  useEmailConnectorSheet,
  useSkillSheet,
  useSubagentSheet,
  useWikiBindingSheet,
} from "@/features/control/forms/use-control-form-sheets"
import {
  useGatewayDeviceSheet,
  useGatewayEventTypeSheet,
  useGatewaySourceSheet,
} from "@/features/control/gateway/gateway-form-model"
import { GatewayPanel } from "@/features/control/gateway/gateway-panel"
import { SessionsPanel } from "@/features/control/session/sessions-panel"
import type { AgentDetail } from "@/lib/api"

function AgentPage() {
  const { agentKey = "" } = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const tab = searchParams.get("tab") ?? DEFAULT_AGENT_TAB
  const setTab = React.useCallback(
    (value: string) => setSearchParams({ tab: value }),
    [setSearchParams]
  )
  const agent = useAgent(agentKey)
  const agentDetail = agent.data?.agent
  const agentTabs = React.useMemo(
    () => agentDetailTabs(agentKey, agentDetail),
    [agentDetail, agentKey]
  )

  return (
    <div>
      <PageHeader
        title={agentDetail?.displayName ?? agentKey}
        breadcrumbs={[{ label: "Agents", to: "/agents" }, { label: agentKey }]}
        actions={
          <>
            {agentDetail ? <StatusBadge status={agentDetail.status} /> : null}
            <AgentHeaderActions
              activeTab={tab}
              agentKey={agentKey}
              disabled={!agentDetail}
              gatewaySourceCount={agentDetail?.gatewaySourceCount}
            />
          </>
        }
      />
      <DetailPageContent
        label="Agent sections"
        onValueChange={setTab}
        tabs={agentTabs}
        value={tab}
      />
    </div>
  )
}

type AgentHeaderAction = {
  disabled?: boolean
  icon: React.ComponentType<{ className?: string }>
  label: string
  onSelect: () => void
}

type AgentHeaderActionsMap = {
  addCredential: AgentHeaderAction
  addDiscord: AgentHeaderAction
  addEmail: AgentHeaderAction
  allowGatewayEventType: AgentHeaderAction
  bindConversation: AgentHeaderAction
  createGatewaySource: AgentHeaderAction
  createSkill: AgentHeaderAction
  createSubagent: AgentHeaderAction
  configureWiki: AgentHeaderAction
  newSession: AgentHeaderAction
  pairIdentity: AgentHeaderAction
  registerGatewayDevice: AgentHeaderAction
}

function AgentHeaderActions({
  activeTab,
  agentKey,
  disabled,
  gatewaySourceCount,
}: {
  activeTab: string
  agentKey: string
  disabled?: boolean
  gatewaySourceCount?: number
}) {
  const bindingSheet = useBindingSheet()
  const agentPairingSheet = useAgentPairingSheet()
  const createSessionSheet = useCreateSessionSheet()
  const credentialSheet = useCredentialSheet()
  const discordSheet = useDiscordConnectorSheet()
  const emailSheet = useEmailConnectorSheet()
  const gatewayDeviceSheet = useGatewayDeviceSheet()
  const gatewayEventTypeSheet = useGatewayEventTypeSheet()
  const gatewaySourceSheet = useGatewaySourceSheet()
  const skillSheet = useSkillSheet()
  const subagentSheet = useSubagentSheet()
  const wikiBindingSheet = useWikiBindingSheet()
  const context = { agentKey }
  const hasGatewaySources = (gatewaySourceCount ?? 0) > 0
  const actions = React.useMemo(
    () => ({
      addCredential: {
        disabled,
        icon: KeyRound,
        label: "Store credential",
        onSelect: () => credentialSheet.setOpen(true, { context }),
      },
      addDiscord: {
        disabled,
        icon: Plug,
        label: "Add Discord account",
        onSelect: () => discordSheet.setOpen(true, { context }),
      },
      addEmail: {
        disabled,
        icon: Mail,
        label: "Add email account",
        onSelect: () => emailSheet.setOpen(true, { context }),
      },
      bindConversation: {
        disabled,
        icon: Link2,
        label: "Bind conversation",
        onSelect: () => bindingSheet.setOpen(true, { context }),
      },
      createGatewaySource: {
        disabled,
        icon: RadioTower,
        label: "Create gateway source",
        onSelect: () => gatewaySourceSheet.setOpen(true, { context }),
      },
      createSkill: {
        disabled,
        icon: Wrench,
        label: "Create skill",
        onSelect: () => skillSheet.setOpen(true, { context }),
      },
      createSubagent: {
        disabled,
        icon: Users,
        label: "Create subagent",
        onSelect: () => subagentSheet.setOpen(true, { context }),
      },
      configureWiki: {
        disabled,
        icon: BookOpen,
        label: "Configure Wiki",
        onSelect: () => wikiBindingSheet.setOpen(true, { context }),
      },
      newSession: {
        disabled,
        icon: GitBranch,
        label: "New session",
        onSelect: () => createSessionSheet.setOpen(true, { context }),
      },
      pairIdentity: {
        disabled,
        icon: UserPlus,
        label: "Pair identity",
        onSelect: () => agentPairingSheet.setOpen(true, { context }),
      },
      registerGatewayDevice: {
        disabled: disabled || !hasGatewaySources,
        icon: Smartphone,
        label: "Register gateway device",
        onSelect: () => gatewayDeviceSheet.setOpen(true, { context }),
      },
      allowGatewayEventType: {
        disabled: disabled || !hasGatewaySources,
        icon: ListChecks,
        label: "Allow gateway event type",
        onSelect: () => gatewayEventTypeSheet.setOpen(true, { context }),
      },
    }),
    [
      agentKey,
      agentPairingSheet,
      bindingSheet,
      createSessionSheet,
      credentialSheet,
      disabled,
      discordSheet,
      emailSheet,
      gatewayDeviceSheet,
      gatewayEventTypeSheet,
      gatewaySourceSheet,
      hasGatewaySources,
      skillSheet,
      subagentSheet,
      wikiBindingSheet,
    ]
  )
  const primary = primaryAgentHeaderActions(
    activeTab,
    actions,
    hasGatewaySources
  )
  const primaryLabels = new Set(
    primary.flatMap((group) => group.actions.map((action) => action.label))
  )
  const moreGroups = agentHeaderActionGroups(actions)
    .map((group) => ({
      ...group,
      actions: group.actions.filter(
        (action) => !primaryLabels.has(action.label)
      ),
    }))
    .filter((group) => group.actions.length > 0)

  return (
    <>
      {primary.map((group) =>
        group.actions.length === 1 ? (
          <AgentActionButton
            key={group.label}
            action={group.actions[0]!}
            variant="default"
          />
        ) : (
          <AgentActionDropdownButton key={group.label} group={group} />
        )
      )}
      <AgentMoreActions groups={moreGroups} />
    </>
  )
}

type AgentHeaderActionGroup = {
  icon: React.ComponentType<{ className?: string }>
  label: string
  actions: AgentHeaderAction[]
}

function primaryAgentHeaderActions(
  activeTab: string,
  actions: AgentHeaderActionsMap,
  hasGatewaySources: boolean
): AgentHeaderActionGroup[] {
  switch (activeTab) {
    case "access":
      return [
        {
          label: actions.pairIdentity.label,
          icon: actions.pairIdentity.icon,
          actions: [actions.pairIdentity],
        },
      ]
    case "credentials":
      return [
        {
          label: actions.addCredential.label,
          icon: actions.addCredential.icon,
          actions: [actions.addCredential],
        },
      ]
    case "wiki":
      return [
        {
          label: actions.configureWiki.label,
          icon: actions.configureWiki.icon,
          actions: [actions.configureWiki],
        },
      ]
    case "connectors":
      return [
        {
          label: "Add account",
          icon: Plus,
          actions: [actions.addDiscord, actions.addEmail],
        },
      ]
    case "bindings":
      return [
        {
          label: actions.bindConversation.label,
          icon: actions.bindConversation.icon,
          actions: [actions.bindConversation],
        },
      ]
    case "skills":
      return [
        {
          label: actions.createSkill.label,
          icon: actions.createSkill.icon,
          actions: [actions.createSkill],
        },
      ]
    case "subagents":
      return [
        {
          label: actions.createSubagent.label,
          icon: actions.createSubagent.icon,
          actions: [actions.createSubagent],
        },
      ]
    case "gateway":
      return [
        {
          label: "Gateway action",
          icon: RadioTower,
          actions: hasGatewaySources
            ? [
                actions.registerGatewayDevice,
                actions.allowGatewayEventType,
                actions.createGatewaySource,
              ]
            : [
                actions.createGatewaySource,
                actions.registerGatewayDevice,
                actions.allowGatewayEventType,
              ],
        },
      ]
    case "audit":
      return []
    case "sessions":
    default:
      return [
        {
          label: actions.newSession.label,
          icon: actions.newSession.icon,
          actions: [actions.newSession],
        },
      ]
  }
}

function agentHeaderActionGroups(
  actions: AgentHeaderActionsMap
): AgentHeaderActionGroup[] {
  return [
    { label: "Sessions", icon: GitBranch, actions: [actions.newSession] },
    { label: "Access", icon: UserPlus, actions: [actions.pairIdentity] },
    {
      label: "Channels",
      icon: Link2,
      actions: [
        actions.bindConversation,
        actions.addDiscord,
        actions.addEmail,
      ],
    },
    {
      label: "Credentials",
      icon: KeyRound,
      actions: [actions.addCredential],
    },
    {
      label: "Wiki",
      icon: BookOpen,
      actions: [actions.configureWiki],
    },
    {
      label: "Capabilities",
      icon: Wrench,
      actions: [actions.createSkill, actions.createSubagent],
    },
    {
      label: "Gateway",
      icon: RadioTower,
      actions: [
        actions.createGatewaySource,
        actions.registerGatewayDevice,
        actions.allowGatewayEventType,
      ],
    },
  ]
}

function AgentActionButton({
  action,
  variant = "outline",
}: {
  action: AgentHeaderAction
  variant?: React.ComponentProps<typeof Button>["variant"]
}) {
  return (
    <Button
      type="button"
      variant={variant}
      size="sm"
      disabled={action.disabled}
      onClick={action.onSelect}
    >
      <action.icon className="size-3.5" />
      {action.label}
    </Button>
  )
}

function AgentActionDropdownButton({
  group,
}: {
  group: AgentHeaderActionGroup
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="sm"
          disabled={group.actions.every((action) => action.disabled)}
        >
          <group.icon className="size-3.5" />
          {group.label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>{group.label}</DropdownMenuLabel>
        <DropdownMenuGroup>
          {group.actions.map((action) => (
            <DropdownMenuItem
              key={action.label}
              disabled={action.disabled}
              onSelect={action.onSelect}
            >
              <action.icon className="size-4" />
              {action.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function AgentMoreActions({ groups }: { groups: AgentHeaderActionGroup[] }) {
  if (groups.length === 0) return null
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label="More agent actions"
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>More agent actions</DropdownMenuLabel>
        {groups.map((group) => (
          <React.Fragment key={group.label}>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[0.68rem] font-medium uppercase text-muted-foreground">
              {group.label}
            </DropdownMenuLabel>
            <DropdownMenuGroup>
              {group.actions.map((action) => (
                <DropdownMenuItem
                  key={action.label}
                  disabled={action.disabled}
                  onSelect={action.onSelect}
                >
                  <action.icon className="size-4" />
                  {action.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </React.Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function agentDetailTabs(
  agentKey: string,
  agent?: AgentDetail
): DetailContentTab[] {
  return AGENT_RESOURCE_TABS.map((tab) => ({
    value: tab.value,
    label: tab.label,
    count: agentTabCount(agent, tab.value),
    content: agentTabContent(agentKey, tab.value),
  }))
}

function agentTabContent(agentKey: string, value: string) {
  switch (value) {
    case "sessions":
      return <SessionsPanel agentKey={agentKey} />
    case "access":
      return <AccessPanel agentKey={agentKey} />
    case "mcp":
      return <McpPanel agentKey={agentKey} />
    case "credentials":
      return <CredentialsPanel agentKey={agentKey} />
    case "wiki":
      return <WikiPanel agentKey={agentKey} />
    case "connectors":
      return <ConnectorsPanel agentKey={agentKey} />
    case "bindings":
      return <BindingsPanel agentKey={agentKey} />
    case "skills":
      return <SkillsPanel agentKey={agentKey} />
    case "subagents":
      return <SubagentsPanel agentKey={agentKey} />
    case "gateway":
      return <GatewayPanel agentKey={agentKey} />
    case "audit":
      return <AuditPanel agentKey={agentKey} />
    default:
      return <SessionsPanel agentKey={agentKey} />
  }
}

export { AgentPage }
export default AgentPage
