import * as React from "react"
import { Link, useLocation } from "react-router-dom"
import {
  Activity,
  BookOpen,
  Bot,
  CalendarClock,
  ChevronsUpDown,
  FileText,
  GitBranch,
  KeyRound,
  Link2,
  ListChecks,
  LogOut,
  Mail,
  MoreHorizontal,
  Plug,
  Plus,
  RadioTower,
  SlidersHorizontal,
  Smartphone,
  Users,
  UserRound,
  Wrench,
} from "lucide-react"

import {
  AGENT_RESOURCE_TABS,
  CONSOLE_NAVIGATION,
  DEFAULT_AGENT_TAB,
  DEFAULT_SESSION_TAB,
  PARENT_AGENT_SHORTCUT_TABS,
  SESSION_RESOURCE_TABS,
  agentPath,
  agentTabCount,
  agentTabPath,
  isConsoleNavActive,
  parseControlRouteContext,
  sessionTabPath,
} from "@/app/control-routes"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
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
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar"
import {
  useAgent,
  useBriefing,
  useHeartbeat,
  useSessionDetail,
} from "@/features/control/api/queries"
import {
  briefingDefaults,
  briefingToFormValues,
  heartbeatConfigToFormValues,
  runtimeConfigToFormValues,
} from "@/features/control/forms/form-values"
import {
  useBindingSheet,
  useBriefingSheet,
  useCreateSessionSheet,
  useCredentialSheet,
  useDiscordConnectorSheet,
  useEmailConnectorSheet,
  useHeartbeatConfigSheet,
  useRuntimeConfigSheet,
  useScheduledTaskSheet,
  useSkillSheet,
  useSubagentSheet,
  useWikiBindingSheet,
} from "@/features/control/forms/use-control-form-sheets"
import {
  useGatewayDeviceSheet,
  useGatewayEventTypeSheet,
  useGatewaySourceSheet,
} from "@/features/control/gateway/gateway-form-model"
import { shortSessionId } from "@/features/control/session-labels"
import { useAuth } from "@/lib/auth"

export function ControlSidebar() {
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-b group-data-[collapsible=icon]:items-center">
        <SidebarBrand />
      </SidebarHeader>
      <SidebarContent>
        <ConsoleNavigation />
        <ContextSidebarSections />
      </SidebarContent>
      <SidebarFooter className="border-t group-data-[collapsible=icon]:items-center">
        <SidebarOperatorMenu />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}

function SidebarBrand() {
  return (
    <Link
      to="/"
      aria-label="Panda Control home"
      title="Panda Control"
      className="flex h-10 min-w-0 items-center gap-2 px-2 text-sm font-semibold transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
    >
      <img src="/control.svg" alt="" className="size-5 shrink-0" />
      <span className="truncate group-data-[collapsible=icon]:hidden">
        Control
      </span>
    </Link>
  )
}

function ConsoleNavigation() {
  const location = useLocation()

  return (
    <SidebarGroup>
      <SidebarGroupLabel className="group-data-[collapsible=icon]:hidden">
        Console
      </SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {CONSOLE_NAVIGATION.map((item) => (
            <SidebarMenuItem key={item.id}>
              <SidebarMenuButton
                asChild
                tooltip={item.label}
                aria-label={item.label}
                isActive={isConsoleNavActive(location.pathname, item.path)}
                className="group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:[&>span]:hidden"
              >
                <Link to={item.path}>
                  <item.icon className="size-4" />
                  <span>{item.label}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}

function SidebarOperatorMenu() {
  const auth = useAuth()
  const { isMobile } = useSidebar()
  const session = auth.session
  const identityLabel = session?.identityId ?? "Operator"
  const roleLabel = session?.role === "scoped" ? "Scoped" : "Admin"
  const expiresLabel = session?.expiresAt
    ? formatSessionExpiry(session.expiresAt)
    : "Session unavailable"

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              tooltip={identityLabel}
              aria-label="Operator session"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0"
            >
              <Avatar size="sm" className="rounded-md">
                <AvatarFallback className="rounded-md font-mono text-[0.65rem] uppercase">
                  {operatorInitials(identityLabel)}
                </AvatarFallback>
              </Avatar>
              <div className="grid min-w-0 flex-1 text-left text-sm leading-tight group-data-[collapsible=icon]:hidden">
                <span className="truncate font-medium">{identityLabel}</span>
                <span className="truncate text-xs text-sidebar-foreground/60">
                  {roleLabel} control session
                </span>
              </div>
              <ChevronsUpDown className="ml-auto size-4 text-sidebar-foreground/60 group-data-[collapsible=icon]:hidden" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side={isMobile ? "bottom" : "right"}
            align="end"
            sideOffset={4}
            className="w-(--radix-dropdown-menu-trigger-width) min-w-64"
          >
            <DropdownMenuLabel className="p-0 font-normal">
              <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                <Avatar size="sm" className="rounded-md">
                  <AvatarFallback className="rounded-md font-mono text-[0.65rem] uppercase">
                    {operatorInitials(identityLabel)}
                  </AvatarFallback>
                </Avatar>
                <div className="grid min-w-0 flex-1 leading-tight">
                  <span className="truncate font-medium">{identityLabel}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {expiresLabel}
                  </span>
                </div>
                <Badge variant="outline" className="h-5 px-1.5 text-[0.65rem]">
                  {roleLabel}
                </Badge>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled>
              <UserRound className="size-4" />
              {session?.id ?? "No active session"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void auth.logout()}>
              <LogOut className="size-4" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

function ContextSidebarSections() {
  const location = useLocation()
  const context = parseControlRouteContext(location.pathname)
  const agent = useAgent(context.agentKey ?? "", {
    enabled: Boolean(context.agentKey),
    staleTime: 30_000,
  })
  if (!context.agentKey) return null

  const activeTab =
    new URLSearchParams(location.search).get("tab") ??
    (context.sessionId ? DEFAULT_SESSION_TAB : DEFAULT_AGENT_TAB)
  const sessionId = context.sessionId
  const sessionLabel = sessionId ? `Session ${shortSessionId(sessionId)}` : null
  const agentItems = sessionId ? PARENT_AGENT_SHORTCUT_TABS : AGENT_RESOURCE_TABS

  return (
    <>
      <SidebarGroup>
        <SidebarGroupLabel
          title={context.agentKey}
          className="group-data-[collapsible=icon]:hidden"
        >
          Workspace
        </SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarContextHeader
            eyebrow="Agent"
            title={context.agentKey}
            detail={sessionId ? "Open agent" : "Active scope"}
            icon={Bot}
            href={agentPath(context.agentKey)}
          />
          {sessionId ? (
            <SidebarContextHeader
              eyebrow="Session"
              title={sessionLabel}
              detail="Current runtime lane"
              icon={GitBranch}
              href={sessionTabPath(context.agentKey, sessionId, "overview")}
            />
          ) : null}
        </SidebarGroupContent>
      </SidebarGroup>
      <ContextSidebarActions
        activeTab={activeTab}
        agentKey={context.agentKey}
        gatewaySourceCount={agent.data?.agent?.gatewaySourceCount}
        sessionId={sessionId}
      />
      <SidebarTabGroup
        label={sessionId ? "Parent agent" : "Agent workspace"}
        tabs={agentItems.map((item) => ({
          active: !sessionId && activeTab === item.value,
          count: agentTabCount(agent.data?.agent, item.value),
          href: agentTabPath(context.agentKey, item.value),
          icon: item.icon,
          label: item.label,
          value: item.value,
        }))}
      />
      {sessionId ? (
        <SidebarTabGroup
          label="Session workspace"
          tabs={SESSION_RESOURCE_TABS.map((item) => ({
            active: activeTab === item.value,
            href: sessionTabPath(context.agentKey, sessionId, item.value),
            icon: item.icon,
            label: item.label,
            value: item.value,
          }))}
        />
      ) : null}
    </>
  )
}

function operatorInitials(value: string) {
  const normalized = value.trim()
  if (!normalized) return "OP"
  const parts = normalized.split(/[-_\s@.]+/).filter(Boolean)
  const initials = parts.slice(0, 2).map((part) => part[0]).join("")
  return (initials || normalized.slice(0, 2)).toUpperCase()
}

function formatSessionExpiry(value: string) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return "Session expiry unknown"
  return `Expires ${date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })}`
}

type SidebarTab = {
  active: boolean
  count?: number
  href: string
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string
}

function SidebarTabGroup({ label, tabs }: { label: string; tabs: SidebarTab[] }) {
  return (
    <SidebarGroup>
      <SidebarGroupLabel className="group-data-[collapsible=icon]:hidden">
        {label}
      </SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {tabs.map((item) => (
            <ContextSidebarItem
              key={item.value}
              href={item.href}
              icon={item.icon}
              label={item.label}
              active={item.active}
              suffix={<ResourceCountBadge value={item.count} />}
            />
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}

type SidebarQuickAction = {
  disabled?: boolean
  icon: React.ComponentType<{ className?: string }>
  label: string
  onSelect: () => void
}

type SidebarActionModel = {
  label: string
  primary: SidebarQuickAction[]
  secondaryLabel: string
  secondary: SidebarActionGroup[]
}

type SidebarActionGroup = {
  label: string
  actions: SidebarQuickAction[]
}

function ContextSidebarActions({
  activeTab,
  agentKey,
  gatewaySourceCount,
  sessionId,
}: {
  activeTab: string
  agentKey: string
  gatewaySourceCount?: number
  sessionId: string | null
}) {
  const bindingSheet = useBindingSheet()
  const briefingSheet = useBriefingSheet()
  const createSessionSheet = useCreateSessionSheet()
  const credentialSheet = useCredentialSheet()
  const discordConnectorSheet = useDiscordConnectorSheet()
  const emailConnectorSheet = useEmailConnectorSheet()
  const gatewayDeviceSheet = useGatewayDeviceSheet()
  const gatewayEventTypeSheet = useGatewayEventTypeSheet()
  const gatewaySourceSheet = useGatewaySourceSheet()
  const heartbeatConfigSheet = useHeartbeatConfigSheet()
  const runtimeConfigSheet = useRuntimeConfigSheet()
  const scheduledTaskSheet = useScheduledTaskSheet()
  const skillSheet = useSkillSheet()
  const subagentSheet = useSubagentSheet()
  const wikiBindingSheet = useWikiBindingSheet()
  const { isMobile, setOpenMobile } = useSidebar()
  const context = sessionId ? { agentKey, sessionId } : { agentKey }
  const sessionDetail = useSessionDetail(agentKey, sessionId ?? "", {
    enabled: Boolean(sessionId),
    staleTime: 30_000,
  })
  const briefing = useBriefing(agentKey, sessionId ?? "")
  const heartbeat = useHeartbeat(agentKey, sessionId ?? "")
  const sessionEntity = sessionDetail.data?.session
  const briefingEntity = briefing.data?.briefing
  const heartbeatEntity = heartbeat.data?.heartbeat
  const hasGatewaySources = (gatewaySourceCount ?? 0) > 0
  const briefingIsSet = Boolean(
    briefingEntity?.wasSet || sessionEntity?.briefingSet
  )
  const newSessionAction: SidebarQuickAction = {
    icon: Plus,
    label: "New session",
    onSelect: () => createSessionSheet.setOpen(true, { context }),
  }
  const bindConversationAction: SidebarQuickAction = {
    icon: Link2,
    label: "Bind conversation",
    onSelect: () =>
      bindingSheet.setOpen(true, {
        context,
        defaultData: sessionId ? { sessionId } : undefined,
      }),
  }
  const addDiscordAction: SidebarQuickAction = {
    icon: Plug,
    label: "Add Discord account",
    onSelect: () => discordConnectorSheet.setOpen(true, { context }),
  }
  const addEmailAction: SidebarQuickAction = {
    icon: Mail,
    label: "Add email account",
    onSelect: () => emailConnectorSheet.setOpen(true, { context }),
  }
  const addCredentialAction: SidebarQuickAction = {
    icon: KeyRound,
    label: "Add credential",
    onSelect: () => credentialSheet.setOpen(true, { context }),
  }
  const createSkillAction: SidebarQuickAction = {
    icon: Wrench,
    label: "Create skill",
    onSelect: () => skillSheet.setOpen(true, { context }),
  }
  const createSubagentAction: SidebarQuickAction = {
    icon: Users,
    label: "Create subagent",
    onSelect: () => subagentSheet.setOpen(true, { context }),
  }
  const configureWikiAction: SidebarQuickAction = {
    icon: BookOpen,
    label: "Configure Wiki",
    onSelect: () => wikiBindingSheet.setOpen(true, { context }),
  }
  const createGatewaySourceAction: SidebarQuickAction = {
    icon: RadioTower,
    label: "Create gateway source",
    onSelect: () => gatewaySourceSheet.setOpen(true, { context }),
  }
  const registerGatewayDeviceAction: SidebarQuickAction = {
    disabled: !hasGatewaySources,
    icon: Smartphone,
    label: "Register gateway device",
    onSelect: () => gatewayDeviceSheet.setOpen(true, { context }),
  }
  const allowGatewayEventTypeAction: SidebarQuickAction = {
    disabled: !hasGatewaySources,
    icon: ListChecks,
    label: "Allow gateway event type",
    onSelect: () => gatewayEventTypeSheet.setOpen(true, { context }),
  }
  const newAutomationAction: SidebarQuickAction = {
    icon: CalendarClock,
    label: "New automation",
    onSelect: () =>
      scheduledTaskSheet.setOpen(true, {
        context,
      }),
  }
  const briefingAction: SidebarQuickAction = {
    disabled: !sessionId || briefing.isLoading || Boolean(briefing.error),
    icon: FileText,
    label: briefingIsSet ? "Edit briefing" : "Add briefing",
    onSelect: () =>
      briefingSheet.setOpen(true, {
        context,
        defaultData: briefingEntity
          ? briefingToFormValues(briefingEntity)
          : briefingDefaults,
        entity: briefingEntity,
      }),
  }
  const runtimeDefaultsAction: SidebarQuickAction = {
    disabled: !sessionEntity,
    icon: SlidersHorizontal,
    label: "Runtime defaults",
    onSelect: () =>
      runtimeConfigSheet.setOpen(true, {
        context,
        defaultData: sessionEntity
          ? runtimeConfigToFormValues(sessionEntity)
          : undefined,
        entity: sessionEntity,
      }),
  }
  const wakePolicyAction: SidebarQuickAction = {
    disabled: !heartbeatEntity,
    icon: Activity,
    label: "Wake policy",
    onSelect: () =>
      heartbeatConfigSheet.setOpen(true, {
        context,
        defaultData: heartbeatEntity
          ? heartbeatConfigToFormValues(heartbeatEntity)
          : undefined,
        entity: heartbeatEntity,
      }),
  }
  const agentPrimaryActions = agentPrimarySidebarActions(activeTab, {
    addCredential: addCredentialAction,
    addDiscord: addDiscordAction,
    addEmail: addEmailAction,
    allowGatewayEventType: allowGatewayEventTypeAction,
    bindConversation: bindConversationAction,
    configureWiki: configureWikiAction,
    createGatewaySource: createGatewaySourceAction,
    createSkill: createSkillAction,
    createSubagent: createSubagentAction,
    hasGatewaySources,
    newSession: newSessionAction,
    registerGatewayDevice: registerGatewayDeviceAction,
  })
  const sessionPrimaryActions = sessionPrimarySidebarActions(activeTab, {
    bindConversation: bindConversationAction,
    briefing: briefingAction,
    newAutomation: newAutomationAction,
    runtimeDefaults: runtimeDefaultsAction,
    wakePolicy: wakePolicyAction,
  })
  const actionModel: SidebarActionModel = sessionId
    ? {
        label: "Session actions",
        primary: sessionPrimaryActions,
        secondaryLabel: "Configure session",
        secondary: withoutPrimaryActions(
          [
            {
              label: "Session context",
              actions: [briefingAction],
            },
            {
              label: "Runtime",
              actions: [runtimeDefaultsAction, wakePolicyAction],
            },
            {
              label: "Channel",
              actions: [bindConversationAction],
            },
            {
              label: "Automation",
              actions: [newAutomationAction],
            },
          ],
          sessionPrimaryActions
        ),
      }
    : {
        label: "Agent actions",
        primary: agentPrimaryActions,
        secondaryLabel: "More agent actions",
        secondary: withoutPrimaryActions(
          [
            {
              label: "Sessions",
              actions: [newSessionAction],
            },
            {
              label: "Channels and accounts",
              actions: [
                bindConversationAction,
                addDiscordAction,
                addEmailAction,
                addCredentialAction,
              ],
            },
            {
              label: "Capabilities",
              actions: [createSkillAction, createSubagentAction],
            },
            {
              label: "Knowledge",
              actions: [configureWikiAction],
            },
            {
              label: "Gateway",
              actions: [
                createGatewaySourceAction,
                registerGatewayDeviceAction,
                allowGatewayEventTypeAction,
              ],
            },
          ],
          agentPrimaryActions
        ),
      }

  function runAction(action: SidebarQuickAction) {
    action.onSelect()
    if (isMobile) setOpenMobile(false)
  }

  return (
    <SidebarGroup>
      <SidebarGroupLabel className="group-data-[collapsible=icon]:hidden">
        {actionModel.label}
      </SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {actionModel.primary.map((action) => (
            <SidebarActionItem
              key={action.label}
              action={action}
              onSelect={() => runAction(action)}
            />
          ))}
          <SidebarOverflowActions
            groups={actionModel.secondary}
            label={actionModel.secondaryLabel}
            onSelect={runAction}
          />
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}

function agentPrimarySidebarActions(
  activeTab: string,
  actions: {
    addCredential: SidebarQuickAction
    addDiscord: SidebarQuickAction
    addEmail: SidebarQuickAction
    allowGatewayEventType: SidebarQuickAction
    bindConversation: SidebarQuickAction
    configureWiki: SidebarQuickAction
    createGatewaySource: SidebarQuickAction
    createSkill: SidebarQuickAction
    createSubagent: SidebarQuickAction
    hasGatewaySources: boolean
    newSession: SidebarQuickAction
    registerGatewayDevice: SidebarQuickAction
  }
) {
  switch (activeTab) {
    case "credentials":
      return [actions.addCredential]
    case "connectors":
      return [actions.addDiscord, actions.addEmail]
    case "bindings":
      return [actions.bindConversation]
    case "skills":
      return [actions.createSkill]
    case "subagents":
      return [actions.createSubagent]
    case "wiki":
      return [actions.configureWiki]
    case "gateway":
      return actions.hasGatewaySources
        ? [actions.registerGatewayDevice, actions.allowGatewayEventType]
        : [actions.createGatewaySource]
    case "audit":
      return []
    case "sessions":
    default:
      return [actions.newSession]
  }
}

function sessionPrimarySidebarActions(
  activeTab: string,
  actions: {
    bindConversation: SidebarQuickAction
    briefing: SidebarQuickAction
    newAutomation: SidebarQuickAction
    runtimeDefaults: SidebarQuickAction
    wakePolicy: SidebarQuickAction
  }
) {
  switch (activeTab) {
    case "briefing":
      return [actions.briefing]
    case "automations":
      return [actions.newAutomation]
    case "bindings":
      return [actions.bindConversation]
    case "runtime":
      return [actions.runtimeDefaults]
    case "overview":
      return [actions.runtimeDefaults, actions.wakePolicy]
    default:
      return []
  }
}

function withoutPrimaryActions(
  groups: SidebarActionGroup[],
  primary: SidebarQuickAction[]
) {
  const primaryLabels = new Set(primary.map((action) => action.label))
  return groups
    .map((group) => ({
      ...group,
      actions: group.actions.filter(
        (action) => !primaryLabels.has(action.label)
      ),
    }))
    .filter((group) => group.actions.length > 0)
}

function SidebarActionItem({
  action,
  onSelect,
}: {
  action: SidebarQuickAction
  onSelect: () => void
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        type="button"
        tooltip={action.label}
        aria-label={action.label}
        disabled={action.disabled}
        className="group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:[&>span]:hidden"
        onClick={onSelect}
      >
        <action.icon className="size-4" />
        <span>{action.label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

function SidebarOverflowActions({
  groups,
  label,
  onSelect,
}: {
  groups: SidebarActionGroup[]
  label: string
  onSelect: (action: SidebarQuickAction) => void
}) {
  const visibleGroups = groups
    .map((group) => ({
      ...group,
      actions: group.actions.filter(Boolean),
    }))
    .filter((group) => group.actions.length > 0)

  if (visibleGroups.length === 0) return null

  return (
    <SidebarMenuItem>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton
            type="button"
            tooltip={label}
            aria-label={label}
            className="group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:[&>span]:hidden"
          >
            <MoreHorizontal className="size-4" />
            <span>{label}</span>
          </SidebarMenuButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start" className="w-56">
          <DropdownMenuLabel>{label}</DropdownMenuLabel>
          {visibleGroups.map((group) => (
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
                    onSelect={() => onSelect(action)}
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
    </SidebarMenuItem>
  )
}

function SidebarContextHeader({
  detail,
  eyebrow,
  href,
  icon: Icon,
  title,
}: {
  detail?: string | null
  eyebrow: string
  href?: string
  icon: React.ComponentType<{ className?: string }>
  title?: string | null
}) {
  if (!title) return null

  const content = (
    <div className="flex min-w-0 items-center gap-2">
      <Icon className="size-4 shrink-0 text-sidebar-foreground/70" />
      <div className="min-w-0">
        <div className="text-[0.68rem] font-medium uppercase text-sidebar-foreground/55">
          {eyebrow}
        </div>
        <div className="truncate text-sm font-semibold leading-5">{title}</div>
        {detail ? (
          <div className="truncate text-xs leading-4 text-sidebar-foreground/60">
            {detail}
          </div>
        ) : null}
      </div>
    </div>
  )

  const className =
    "mb-2 block rounded-none border bg-sidebar-accent/35 px-2 py-2 text-sidebar-foreground transition-colors group-data-[collapsible=icon]:hidden"
  const titleText = detail ? `${title} · ${detail}` : title

  if (href) {
    return (
      <Link
        to={href}
        className={`${className} hover:bg-sidebar-accent hover:text-sidebar-accent-foreground`}
        title={titleText}
      >
        {content}
      </Link>
    )
  }

  return (
    <div className={className} title={titleText}>
      {content}
    </div>
  )
}

function ContextSidebarItem({
  active,
  href,
  icon: Icon,
  label,
  suffix,
}: {
  active: boolean
  href: string
  icon: React.ComponentType<{ className?: string }>
  label: string
  suffix?: React.ReactNode
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        tooltip={label}
        aria-label={label}
        isActive={active}
        className="group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:[&>span]:hidden"
      >
        <Link to={href}>
          <Icon className="size-4" />
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {suffix}
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

function ResourceCountBadge({ value }: { value?: number }) {
  if (typeof value !== "number") return null
  return (
    <Badge
      variant="secondary"
      className="ml-auto h-5 min-w-5 justify-center px-1 text-[0.65rem] font-normal tabular-nums group-data-[collapsible=icon]:hidden"
    >
      {value > 999 ? "999+" : value}
    </Badge>
  )
}
