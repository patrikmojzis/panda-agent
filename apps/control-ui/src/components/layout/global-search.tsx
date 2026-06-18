import * as React from "react"
import { useNavigate } from "react-router-dom"
import {
  AlertTriangle,
  Bot,
  GitBranch,
  KeyRound,
  Link2,
  Plug,
  RadioTower,
  Search,
  Smartphone,
  UserCheck,
  Wrench,
} from "lucide-react"

import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  filterConsoleNavigation,
} from "@/app/control-routes"
import { useControlSearch } from "@/features/control/api/queries"
import {
  friendlySessionLabel,
  shortSessionId,
} from "@/features/control/session-labels"
import { formatDate } from "@/features/control/formatting"
import { useIsMobile } from "@/hooks/use-mobile"
import { useAuth } from "@/lib/auth"
import type { GlobalSearchResult } from "@/lib/api"
import { cn } from "@/lib/utils"

const searchResultIcons = {
  agent: Bot,
  session: GitBranch,
  identity: UserCheck,
  work_failure: AlertTriangle,
  credential: KeyRound,
  connector: Plug,
  binding: Link2,
  gateway_source: RadioTower,
  gateway_device: Smartphone,
  skill: Wrench,
  subagent: Wrench,
} satisfies Record<
  GlobalSearchResult["kind"],
  React.ComponentType<{ className?: string }>
>

const searchResultKindLabels = {
  agent: "agent",
  session: "session",
  identity: "identity",
  work_failure: "failure",
  credential: "credential",
  connector: "connector",
  binding: "binding",
  gateway_source: "gateway",
  gateway_device: "device",
  skill: "skill",
  subagent: "subagent",
} satisfies Record<GlobalSearchResult["kind"], string>

type SearchResultGroupDefinition = {
  id: string
  label: string
  kinds: readonly GlobalSearchResult["kind"][]
}

const searchResultGroupDefinitions: SearchResultGroupDefinition[] = [
  {
    id: "attention",
    label: "Work needing attention",
    kinds: ["work_failure"],
  },
  {
    id: "workspace",
    label: "Workspaces",
    kinds: ["agent", "session", "identity"],
  },
  {
    id: "channels",
    label: "Channels and accounts",
    kinds: ["connector", "binding", "credential"],
  },
  {
    id: "capabilities",
    label: "Capabilities",
    kinds: ["skill", "subagent"],
  },
  {
    id: "gateway",
    label: "Gateway",
    kinds: ["gateway_source", "gateway_device"],
  },
]

function GlobalSearch() {
  const auth = useAuth()
  const navigate = useNavigate()
  const isMobile = useIsMobile()
  const [query, setQuery] = React.useState("")
  const [open, setOpen] = React.useState(false)
  const searchQuery = query.trim()
  const canSearch = searchQuery.length >= 2
  const search = useControlSearch(searchQuery, { enabled: canSearch })
  const results = search.data?.data ?? []
  const groupedResults = React.useMemo(
    () => groupSearchResults(results),
    [results]
  )
  const navigationResults = React.useMemo(() => {
    return filterConsoleNavigation(searchQuery, auth.session?.role)
  }, [auth.session?.role, searchQuery])

  React.useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      if (
        event.key.toLowerCase() !== "k" ||
        (!event.metaKey && !event.ctrlKey)
      )
        return
      event.preventDefault()
      setOpen(true)
    }

    document.addEventListener("keydown", handleShortcut)
    return () => document.removeEventListener("keydown", handleShortcut)
  }, [])

  function navigateTo(route: string) {
    setQuery("")
    setOpen(false)
    navigate(route)
  }

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen)
    if (!nextOpen) setQuery("")
  }

  function openResult(result: GlobalSearchResult) {
    navigateTo(result.targetRoute)
  }

  function fallbackSearch() {
    const trimmed = query.trim()
    if (!trimmed) return
    navigateTo(`/agents?search=${encodeURIComponent(trimmed)}`)
  }

  const content = (
    <Command
      shouldFilter={false}
      className={cn(
        isMobile
          ? "min-h-0 flex-1 rounded-none bg-background"
          : "h-[22rem] rounded-none border-0"
      )}
    >
      <CommandInput
        autoFocus
        value={query}
        onValueChange={setQuery}
        placeholder="Search agents, sessions, and resources"
      />
      <CommandList
        className={cn(
          isMobile &&
            "max-h-none min-h-0 flex-1 overscroll-contain touch-pan-y pb-3"
        )}
      >
        {navigationResults.length > 0 ? (
          <CommandGroup heading="Navigation">
            {navigationResults.map((item) => (
              <CommandItem
                key={item.id}
                value={`nav-${item.label}`}
                className={cn(isMobile && "min-h-12 px-4")}
                onSelect={() => navigateTo(item.path)}
              >
                <item.icon className="size-4 text-muted-foreground" />
                <span>{item.label}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}

        {!canSearch ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">
            Type at least 2 characters to search resources.
          </div>
        ) : search.isLoading ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">
            Searching
          </div>
        ) : results.length > 0 ? (
          groupedResults.map((group) => (
            <CommandGroup key={group.id} heading={group.label}>
              {group.results.map((result, index) => (
                <GlobalSearchResultRow
                  key={result.id}
                  result={result}
                  onSelect={() => openResult(result)}
                  value={`result-${group.id}-${index}-${searchResultTitle(result)}-${searchResultSubtitle(result)}`}
                />
              ))}
            </CommandGroup>
          ))
        ) : canSearch && navigationResults.length === 0 ? (
          <CommandEmpty>No results</CommandEmpty>
        ) : null}

        {canSearch && results.length === 0 && !search.isLoading ? (
          <CommandGroup>
            <CommandItem
              value={`agents-search-${searchQuery}`}
              onSelect={fallbackSearch}
            >
              <Search className="size-4 text-muted-foreground" />
              <span className="min-w-0 truncate">
                Search agents for "{searchQuery}"
              </span>
            </CommandItem>
          </CommandGroup>
        ) : null}
      </CommandList>
    </Command>
  )

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="hidden min-w-44 flex-1 justify-start gap-2 shadow-none sm:inline-flex sm:max-w-md"
        aria-label="Search"
        onClick={() => setOpen(true)}
      >
        <Search className="size-4 text-muted-foreground" />
        <span className="mr-auto min-w-0 truncate text-muted-foreground">
          Search agents, sessions, and resources
        </span>
        <Kbd>⌘ K</Kbd>
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="sm:hidden"
        aria-label="Search"
        onClick={() => setOpen(true)}
      >
        <Search className="size-4" />
      </Button>

      {isMobile ? (
        <Sheet open={open} onOpenChange={handleOpenChange}>
          <SheetContent
            side="left"
            className="gap-0 overflow-hidden p-0 data-[side=left]:w-full data-[side=left]:sm:max-w-none"
          >
            <SheetHeader className="sr-only">
              <SheetTitle>Search</SheetTitle>
              <SheetDescription>Search across Control.</SheetDescription>
            </SheetHeader>
            <div className="flex h-full min-h-0 flex-1 flex-col pt-2">
              {content}
            </div>
          </SheetContent>
        </Sheet>
      ) : (
        <CommandDialog
          open={open}
          onOpenChange={handleOpenChange}
          title="Search"
          description="Search across Control."
          className="w-[min(32rem,calc(100vw-1.5rem))]"
        >
          {content}
        </CommandDialog>
      )}
    </>
  )
}

function GlobalSearchResultRow({
  result,
  onSelect,
  value,
}: {
  result: GlobalSearchResult
  onSelect: () => void
  value: string
}) {
  const Icon = searchResultIcons[result.kind]
  const title = searchResultTitle(result)
  const subtitle = searchResultSubtitle(result)
  const context = searchResultContext(result)
  return (
    <CommandItem
      value={value}
      className={cn(
        "items-start gap-2 px-2 py-2"
      )}
      onSelect={onSelect}
    >
      <Icon className="mt-0.5 size-4 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{title}</span>
        <span className="block truncate text-muted-foreground">{subtitle}</span>
        <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[0.68rem] leading-4 text-muted-foreground">
          <span className="truncate">{searchResultDestination(result)}</span>
          {context.map((item) => (
            <span key={item} className="truncate">
              {item}
            </span>
          ))}
        </span>
      </span>
      <CommandShortcut className="ml-2 tracking-normal">
        <Badge variant={searchResultBadgeVariant(result)}>
          {searchResultKindLabels[result.kind]}
        </Badge>
      </CommandShortcut>
    </CommandItem>
  )
}

function groupSearchResults(results: readonly GlobalSearchResult[]) {
  return searchResultGroupDefinitions
    .map((group) => ({
      ...group,
      results: results.filter((result) => group.kinds.includes(result.kind)),
    }))
    .filter((group) => group.results.length > 0)
}

function searchResultBadgeVariant(result: GlobalSearchResult) {
  if (
    result.kind === "work_failure" &&
    result.subtitle.toLowerCase().startsWith("critical")
  ) {
    return "destructive"
  }
  return "outline"
}

function searchResultTitle(result: GlobalSearchResult) {
  if (result.kind !== "session") return result.title
  return friendlySessionLabel({
    id: result.sessionId,
    kind: searchResultSessionKind(result.subtitle),
    label: result.title,
  })
}

function searchResultSubtitle(result: GlobalSearchResult) {
  if (result.kind !== "session" || !result.sessionId) return result.subtitle
  return `${result.subtitle} · ${shortSessionId(result.sessionId)}`
}

function searchResultContext(result: GlobalSearchResult) {
  const context: string[] = []
  if (result.agentKey && !result.subtitle.includes(result.agentKey)) {
    context.push(`Agent ${result.agentKey}`)
  }
  if (result.sessionId && result.kind !== "session") {
    context.push(`Session ${shortSessionId(result.sessionId)}`)
  }
  const updated = formatDate(result.updatedAt)
  if (updated) context.push(updated)
  return context
}

function searchResultDestination(result: GlobalSearchResult) {
  const tab = routeTab(result.targetRoute)
  if (tab) return `${humanizeTab(tab)} tab`
  if (result.targetRoute.includes("/sessions/")) return "Session workspace"
  if (result.targetRoute.startsWith("/agents/")) return "Agent workspace"
  return "Console"
}

function routeTab(route: string) {
  return route.match(/[?&]tab=([^&]+)/)?.[1]
}

function humanizeTab(value: string) {
  return value
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

function searchResultSessionKind(subtitle: string) {
  const kind = subtitle.split("·").at(-1)?.trim()
  return kind === "main" || kind === "branch" ? kind : undefined
}

export { GlobalSearch }
export default GlobalSearch
