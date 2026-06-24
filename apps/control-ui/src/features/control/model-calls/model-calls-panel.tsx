import * as React from "react"
import type { ColumnDef, ColumnFiltersState } from "@tanstack/react-table"
import { Link as RouterLink, useLocation, useNavigate } from "react-router-dom"
import { AlertTriangle, Clock, Eye, Filter, Link as LinkIcon, RotateCcw } from "lucide-react"

import {
  Cell,
  DataTableView,
  RowActionsMenu,
  TableSelectFilter,
  renderColumnHeader,
  type DataTableState,
  useDataTableState,
} from "@/components/common/data-table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useModelCallTraces } from "@/features/control/api/queries"
import {
  StatusBadge,
  humanize,
  mobileHiddenColumns,
  short,
} from "@/features/control/control-display"
import {
  formatDate,
  formatDuration,
  formatNumber,
} from "@/features/control/formatting"
import {
  modelCallFailureGroups,
  modelCallDetailPath,
  modelCallsListFilterPath,
  traceErrorLabel,
  traceErrorSummary,
  usageSummary,
} from "@/features/control/model-calls/model-call-display"
import { TraceContext } from "@/features/control/model-calls/model-call-context"
import type {
  ModelCallTraceFailureGroup,
  ModelCallTraceList,
  ModelCallTraceSummary,
  TableParams,
} from "@/lib/api"
import { cn } from "@/lib/utils"

const statusFilterOptions = [
  { label: "Completed", value: "completed" },
  { label: "Failed", value: "failed" },
]

const modeFilterOptions = [
  { label: "Complete", value: "complete" },
  { label: "Stream", value: "stream" },
]

type InitialModelCallFilters = {
  agentKey?: string
  mode?: string
  runId?: string
  sessionId?: string
  status?: string
}

export function ModelCallsPanel({
  initialFilters,
}: {
  initialFilters?: InitialModelCallFilters
}) {
  const location = useLocation()
  const navigate = useNavigate()
  const initialStatus = initialFilters?.status ?? ""
  const initialMode = initialFilters?.mode ?? ""
  const initialAgentKey = initialFilters?.agentKey ?? ""
  const initialSessionId = initialFilters?.sessionId ?? ""
  const initialRunId = initialFilters?.runId ?? ""
  const urlFilterKey = [
    initialStatus,
    initialMode,
    initialAgentKey,
    initialSessionId,
    initialRunId,
  ].join(":")
  const urlColumnFilters = React.useMemo(
    () => initialColumnFilters({
      agentKey: initialAgentKey,
      mode: initialMode,
      runId: initialRunId,
      sessionId: initialSessionId,
      status: initialStatus,
    }),
    [initialAgentKey, initialMode, initialRunId, initialSessionId, initialStatus]
  )
  const initialTableState = React.useMemo(
    () => ({ per_page: 25, columnFilters: urlColumnFilters }),
    [urlColumnFilters]
  )
  const table = useDataTableState("model-call-traces", initialTableState)
  const params = modelCallTraceParams(table.params)
  const traces = useModelCallTraces(params)
  const listPath = modelCallsListFilterPath(params)
  const skipNextUrlSync = React.useRef(false)
  const lastUrlFilterKey = React.useRef<string | null>(null)

  React.useEffect(() => {
    if (lastUrlFilterKey.current === urlFilterKey) return
    lastUrlFilterKey.current = urlFilterKey
    if (columnFiltersEqual(table.columnFilters, urlColumnFilters)) return
    skipNextUrlSync.current = true
    table.setColumnFilters(urlColumnFilters)
    table.setPagination((previous) =>
      previous.pageIndex === 0 ? previous : { ...previous, pageIndex: 0 }
    )
  }, [table, urlColumnFilters, urlFilterKey])

  React.useEffect(() => {
    if (skipNextUrlSync.current) {
      skipNextUrlSync.current = false
      return
    }
    const currentPath = `${location.pathname}${location.search}`
    if (currentPath === listPath) return
    const timeout = window.setTimeout(() => {
      navigate(listPath, { replace: true })
    }, 300)
    return () => window.clearTimeout(timeout)
  }, [listPath, location.pathname, location.search, navigate])

  const columns: ColumnDef<ModelCallTraceSummary>[] = [
    {
      id: "call",
      meta: { label: "Call", wrap: true, maxWidthClassName: "max-w-[24rem]" },
      header: renderColumnHeader,
      enableSorting: false,
      cell: ({ row }) => <ModelCallOverview trace={row.original} />,
    },
    {
      id: "context",
      meta: { label: "Context", wrap: true, maxWidthClassName: "max-w-[34rem]" },
      header: renderColumnHeader,
      enableSorting: false,
      cell: ({ row }) => <TraceContext trace={row.original} showSessionLink={false} />,
    },
    {
      id: "error",
      meta: { label: "Error", wrap: true, maxWidthClassName: "max-w-[22rem]" },
      header: renderColumnHeader,
      enableSorting: false,
      cell: ({ row }) => <ModelCallError trace={row.original} />,
    },
    {
      id: "usage",
      meta: { label: "Tokens / Cost", wrap: true, maxWidthClassName: "max-w-[14rem]" },
      header: renderColumnHeader,
      enableSorting: false,
      cell: ({ row }) => <Cell>{usageSummary(row.original.usage)}</Cell>,
    },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      enableHiding: false,
      meta: { linkEnabled: false, align: "right" },
      cell: ({ row }) => (
        <RowActionsMenu
          triggerLabel={`Open actions for model call ${short(row.original.id)}`}
          actions={[
            {
              label: "Inspect",
              icon: <Eye className="size-4" />,
              onSelect: () => navigate(modelCallDetailPath(row.original.id)),
            },
          ]}
        />
      ),
    },
  ]

  return (
    <div className="grid min-w-0 gap-3">
      <ModelCallListSnapshot
        response={traces.data?.modelCallTraces}
        state={table}
        listPath={listPath}
      />
      <DataTableView
        columns={columns}
        response={traces.data?.modelCallTraces}
        state={table}
        error={traces.error}
        filters={<ModelCallTraceFilters state={table} />}
        getLink={(trace) => modelCallDetailPath(trace.id)}
        isFetching={traces.isFetching}
        isLoading={traces.isLoading}
        isPlaceholderData={traces.isPlaceholderData}
        onRetry={() => void traces.refetch()}
        rowKey={(row) => row.id}
        showSearch={false}
        emptyLabel="No model call traces"
        emptyDescription="Traces are retained briefly and only after model calls are recorded."
        mobileColumnVisibility={mobileHiddenColumns("usage")}
      />
    </div>
  )
}

function ModelCallListSnapshot({
  listPath,
  response,
  state,
}: {
  listPath: string
  response?: ModelCallTraceList
  state: DataTableState
}) {
  const rows = React.useMemo(() => response?.data ?? [], [response?.data])
  const visibleFailures = rows.filter((trace) => trace.status === "failed").length
  const latest = latestModelCallTrace(rows)
  const latestFailure = latestModelCallTrace(rows, (trace) => trace.status === "failed")
  const backendFailureGroups = response?.failureGroups
  const failureGroups = React.useMemo(
    () => backendFailureGroups ?? modelCallFailureGroups(rows),
    [backendFailureGroups, rows]
  )
  const failureGroupScope = backendFailureGroups ? "All matching traces" : "Loaded page sample"
  const isFailedOnly = tableFilterValue(state, "status") === "failed"
  const hasScopedFilters = hasModelCallFilters(state)

  return (
    <div className="grid min-w-0 gap-4 border bg-background p-4 shadow-sm">
      <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SnapshotMetric
          label="Matching traces"
          value={formatNumber(response?.meta.total) ?? "-"}
          detail={response ? `${rows.length} loaded on this page` : "Loading"}
          prominent
        />
        <SnapshotMetric
          label="Visible failures"
          value={String(visibleFailures)}
          detail={visibleFailures > 0 ? "Failed on this page" : "No failures loaded"}
          destructive={visibleFailures > 0}
        />
        <SnapshotMetric
          label="Latest loaded"
          value={formatDate(latest?.startedAt) ?? "-"}
          detail={latest ? `${latest.provider}/${latest.model}` : "No loaded rows"}
        />
        <SnapshotMetric
          label="Trace policy"
          value="Sanitized"
          detail="Prompt/cache identifiers stay redacted"
        />
      </div>
      <FailureGroups groups={failureGroups} scope={failureGroupScope} />
      <div className="flex min-w-0 flex-wrap gap-2 border-t pt-3">
        {latestFailure ? (
          <Button variant="default" size="sm" asChild>
            <RouterLink to={modelCallDetailPath(latestFailure.id) + "?filter=attention"}>
              <AlertTriangle className="size-4" />
              Latest failure
            </RouterLink>
          </Button>
        ) : (
          <Button variant="outline" size="sm" disabled>
            <AlertTriangle className="size-4" />
            Latest failure
          </Button>
        )}
        {latest ? (
          <Button variant="outline" size="sm" asChild>
            <RouterLink to={modelCallDetailPath(latest.id)}>
              <Eye className="size-4" />
              Latest call
            </RouterLink>
          </Button>
        ) : null}
        <Button
          variant={isFailedOnly ? "secondary" : "outline"}
          size="sm"
          disabled={isFailedOnly}
          onClick={() => setTableFilter(state, "status", "failed")}
        >
          <Filter className="size-4" />
          Failed only
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!hasScopedFilters}
          onClick={() => clearModelCallFilters(state)}
        >
          <RotateCcw className="size-4" />
          Clear filters
        </Button>
        <Button variant="outline" size="sm" asChild>
          <RouterLink to={listPath}>
            <LinkIcon className="size-4" />
            Permalink
          </RouterLink>
        </Button>
      </div>
    </div>
  )
}

function FailureGroups({
  groups,
  scope,
}: {
  groups: readonly ModelCallTraceFailureGroup[]
  scope: string
}) {
  if (groups.length === 0) {
    return (
      <div className="grid min-w-0 gap-2 border-t pt-3">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <div className="text-xs font-medium text-muted-foreground uppercase">Failure groups</div>
          <div className="text-xs text-muted-foreground">{scope}</div>
        </div>
        <div className="border bg-muted/20 p-3 text-xs text-muted-foreground">
          No failed calls match this scope.
        </div>
      </div>
    )
  }

  return (
    <div className="grid min-w-0 gap-3 border-t pt-3">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="text-xs font-medium text-muted-foreground uppercase">Failure groups</div>
        <div className="text-xs text-muted-foreground">{scope}</div>
      </div>
      <div className="grid min-w-0 gap-2 lg:grid-cols-3">
        {groups.map((group) => (
          <div
            key={`${group.representative.id}:${group.label}`}
            className="grid min-w-0 gap-3 border border-l-4 border-l-destructive bg-destructive/5 p-3"
          >
            <div className="flex min-w-0 items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <Badge variant="destructive" className="tabular-nums">
                    {failureCountLabel(group.count)}
                  </Badge>
                  <span className="min-w-0 truncate text-xs font-medium text-muted-foreground uppercase">
                    {humanize(group.label)}
                  </span>
                </div>
                <div
                  className="mt-2 line-clamp-2 break-words text-sm font-medium leading-snug [overflow-wrap:anywhere]"
                  title={group.summary}
                >
                  {group.summary}
                </div>
              </div>
              <Button variant="ghost" size="sm" asChild>
                <RouterLink to={`${modelCallDetailPath(group.representative.id)}?filter=attention`}>
                  <Eye className="size-4" />
                  Inspect
                </RouterLink>
              </Button>
            </div>
            <div className="flex min-w-0 flex-wrap gap-x-2 gap-y-1 border-t pt-2 text-xs text-muted-foreground">
              <span className="min-w-0 truncate">
                {group.representative.provider}/{group.representative.model}
              </span>
              <span>{formatDate(group.latestStartedAt) ?? "-"}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function SnapshotMetric({
  destructive = false,
  detail,
  label,
  prominent = false,
  value,
}: {
  destructive?: boolean
  detail: string
  label: string
  prominent?: boolean
  value: string
}) {
  return (
    <div
      className={cn(
        "grid min-w-0 gap-1 border bg-muted/20 p-3",
        prominent ? "border-primary/30 bg-primary/5" : null,
        destructive ? "border-destructive/35 bg-destructive/5" : null
      )}
    >
      <div className="text-xs font-medium text-muted-foreground uppercase">{label}</div>
      <div
        className={cn(
          "min-w-0 break-words font-semibold tabular-nums",
          prominent ? "text-lg" : "text-base",
          destructive ? "text-destructive" : null
        )}
      >
        {value}
      </div>
      <div className="truncate text-xs text-muted-foreground" title={detail}>
        {detail}
      </div>
    </div>
  )
}

function failureCountLabel(count: number) {
  return `${count} call${count === 1 ? "" : "s"}`
}

function ModelCallOverview({ trace }: { trace: ModelCallTraceSummary }) {
  return (
    <div className="grid min-w-0 gap-1">
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        <StatusBadge status={trace.status} />
        <Badge variant="outline">{humanize(trace.mode)}</Badge>
        {trace.status === "failed" ? (
          <AlertTriangle className="size-3.5 text-destructive" aria-hidden="true" />
        ) : null}
      </div>
      <div className="min-w-0">
        <span className="break-words font-medium">{trace.provider}</span>
        <code className="ml-1 break-all text-xs text-muted-foreground">{trace.model}</code>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span>{formatDate(trace.startedAt) ?? "No start"}</span>
        <span className="inline-flex items-center gap-1">
          <Clock className="size-3" aria-hidden="true" />
          {formatDuration(trace.durationMs) ?? "-"}
        </span>
        <span className="min-w-0 break-all">
          Trace <code>{short(trace.id)}</code>
        </span>
      </div>
    </div>
  )
}

function ModelCallError({ trace }: { trace: ModelCallTraceSummary }) {
  const summary = traceErrorSummary(trace.error)
  if (!summary) return <Cell className="text-muted-foreground">-</Cell>
  const label = traceErrorLabel(trace.error)

  return (
    <div className="grid min-w-0 gap-1">
      {label ? (
        <Badge variant="destructive" className="max-w-full min-w-0">
          <span className="truncate">{humanize(label)}</span>
        </Badge>
      ) : null}
      <div className="min-w-0 break-words text-xs leading-relaxed text-destructive [overflow-wrap:anywhere]">
        {summary}
      </div>
    </div>
  )
}

function ModelCallTraceFilters({ state }: { state: DataTableState }) {
  return (
    <>
      <TableSelectFilter
        state={state}
        id="status"
        label="Status"
        allLabel="All statuses"
        options={statusFilterOptions}
        triggerClassName="w-36"
      />
      <TableSelectFilter
        state={state}
        id="mode"
        label="Mode"
        allLabel="All modes"
        options={modeFilterOptions}
        triggerClassName="w-32"
      />
      <TableTextFilter
        state={state}
        id="agent_key"
        label="Agent"
        placeholder="Agent key"
      />
      <TableTextFilter
        state={state}
        id="session_id"
        label="Session"
        placeholder="Session ID"
      />
      <TableTextFilter
        state={state}
        id="run_id"
        label="Run"
        placeholder="Run ID"
      />
    </>
  )
}

function TableTextFilter({
  state,
  id,
  label,
  placeholder,
}: {
  state: DataTableState
  id: string
  label: string
  placeholder: string
}) {
  const inputId = `model-call-filter-${id}`
  const value = tableFilterValue(state, id)

  return (
    <div className="grid min-w-0 gap-1">
      <Label htmlFor={inputId} className="sr-only">
        {label}
      </Label>
      <Input
        id={inputId}
        value={value}
        onChange={(event) => setTableFilter(state, id, event.target.value)}
        placeholder={placeholder}
        className="h-8 w-36 max-w-full text-xs"
      />
    </div>
  )
}

function modelCallTraceParams(params: TableParams): TableParams {
  const rest = { ...params }
  delete rest.search
  delete rest.sort_by
  delete rest.sort_direction
  return rest
}

function initialColumnFilters(initialFilters?: InitialModelCallFilters): ColumnFiltersState {
  const filters: ColumnFiltersState = []
  if (initialFilters?.status) filters.push({ id: "status", value: initialFilters.status })
  if (initialFilters?.mode) filters.push({ id: "mode", value: initialFilters.mode })
  if (initialFilters?.agentKey) filters.push({ id: "agent_key", value: initialFilters.agentKey })
  if (initialFilters?.sessionId) filters.push({ id: "session_id", value: initialFilters.sessionId })
  if (initialFilters?.runId) filters.push({ id: "run_id", value: initialFilters.runId })
  return filters
}

function columnFiltersEqual(left: ColumnFiltersState, right: ColumnFiltersState) {
  if (left.length !== right.length) return false
  const leftEntries = columnFilterEntries(left)
  const rightEntries = columnFilterEntries(right)
  return leftEntries.every((entry, index) => entry === rightEntries[index])
}

function columnFilterEntries(filters: ColumnFiltersState) {
  return filters
    .map((filter) => `${filter.id}:${typeof filter.value === "string" ? filter.value : ""}`)
    .sort()
}

function tableFilterValue(state: DataTableState, id: string) {
  const value = state.columnFilters.find((filter) => filter.id === id)?.value
  return typeof value === "string" ? value : ""
}

function setTableFilter(state: DataTableState, id: string, value: string) {
  state.setColumnFilters((previous) => {
    const withoutFilter = previous.filter((filter) => filter.id !== id)
    const nextValue = value.trim()
    return nextValue ? [...withoutFilter, { id, value: nextValue }] : withoutFilter
  })
  state.setPagination((previous) =>
    previous.pageIndex === 0 ? previous : { ...previous, pageIndex: 0 }
  )
}

function clearModelCallFilters(state: DataTableState) {
  state.setColumnFilters([])
  state.setPagination((previous) =>
    previous.pageIndex === 0 ? previous : { ...previous, pageIndex: 0 }
  )
}

function hasModelCallFilters(state: DataTableState) {
  return state.columnFilters.some((filter) =>
    ["status", "mode", "agent_key", "session_id", "run_id"].includes(filter.id)
  )
}

function latestModelCallTrace(
  rows: readonly ModelCallTraceSummary[],
  predicate: (trace: ModelCallTraceSummary) => boolean = () => true
) {
  return rows.reduce<ModelCallTraceSummary | null>((latest, trace) => {
    if (!predicate(trace)) return latest
    if (!latest) return trace
    return timestampMs(trace.startedAt) > timestampMs(latest.startedAt) ? trace : latest
  }, null)
}

function timestampMs(value: string | null | undefined) {
  if (!value) return 0
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : 0
}
