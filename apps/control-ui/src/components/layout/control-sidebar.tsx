import * as React from "react"
import { Link, useLocation } from "react-router-dom"
import {
  Bot,
  ChevronsUpDown,
  GitBranch,
  LogOut,
  UserRound,
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
import { useAgent } from "@/features/control/api/queries"
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
              href={sessionTabPath(context.agentKey, sessionId, DEFAULT_SESSION_TAB)}
            />
          ) : null}
        </SidebarGroupContent>
      </SidebarGroup>
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
