import * as React from "react"
import type { ColumnDef } from "@tanstack/react-table"
import { useNavigate } from "react-router-dom"
import { AlertTriangle, ExternalLink, Eye } from "lucide-react"

import {
  Cell,
  DataTableView,
  RowActionsMenu,
  TableSelectFilter,
  renderColumnHeader,
  type DataTableState,
  useDataTableState,
} from "@/components/common/data-table"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { useRuntimeActivity } from "@/features/control/api/queries"
import { TodosPanel } from "@/features/control/session/todos-panel"
import { useAuth } from "@/lib/auth"
import {
  humanize,
  mobileHiddenColumns,
  short,
  StatusBadge,
  TruncatedText,
} from "@/features/control/control-display"
import {
  type PaginatedResponse,
  type RuntimeActivity,
  type RuntimeRun,
  type TableParams,
} from "@/lib/api"
import {
  formatDate,
  formatDuration,
} from "@/features/control/formatting"
import {
  DetailField,
  DetailPanel,
  TableError,
} from "@/features/control/detail-primitives"

const runtimeStatusFilterOptions = [
  { label: "Queued", value: "queued" },
  { label: "Running", value: "running" },
  { label: "Completed", value: "completed" },
  { label: "Failed", value: "failed" },
  { label: "Cancelled", value: "cancelled" },
]

const runtimeFailureCategoryFilterOptions = [
  { label: "Provider abort", value: "provider_abort" },
  { label: "Provider timeout", value: "provider_timeout" },
  { label: "Provider server error", value: "provider_server_error" },
  {
    label: "Provider transport terminated",
    value: "provider_transport_terminated",
  },
  { label: "Provider transport network", value: "provider_transport_network" },
  { label: "Provider error", value: "provider_error" },
]

export function RuntimePanel({
  agentKey,
  sessionId,
}: {
  agentKey: string
  sessionId: string
}) {
  const table = useDataTableState(
    `agent:${agentKey}:session:${sessionId}:runtime-runs`,
    {
      per_page: 10,
      sort_by: "startedAt",
      sort_direction: "desc",
    }
  )
  const auth = useAuth()
  const runtime = useRuntimeActivity(agentKey, sessionId, table.params)
  const activity = runtime.data?.runtimeActivity
  const stats = runtimeStats(activity)
  if (runtime.error) return <TableError error={runtime.error} />

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <DetailPanel title="Run Health">
          {stats.failed > 0 ? (
            <RuntimeFailureFocus
              failed={stats.failed}
              failureRate={stats.failureRate}
              latestRun={stats.latestRun}
              onShowFailed={() => setTableFilter(table, "status", "failed")}
            />
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <DetailField
              loading={runtime.isLoading}
              label="Current"
              value={
                <StatusBadge status={stats.running > 0 ? "running" : "idle"} />
              }
            />
            <DetailField
              loading={runtime.isLoading}
              label="Runs"
              value={stats.total.toLocaleString()}
            />
            <DetailField
              loading={runtime.isLoading}
              label="Completed"
              value={stats.completed.toLocaleString()}
            />
            <DetailField
              loading={runtime.isLoading}
              label="Failed"
              value={
                stats.failed > 0 ? (
                  <span className="text-destructive">
                    {stats.failed.toLocaleString()}
                  </span>
                ) : (
                  "0"
                )
              }
            />
            <DetailField
              loading={runtime.isLoading}
              label="Failure rate"
              value={stats.failureRate}
            />
            <DetailField
              loading={runtime.isLoading}
              label="Average duration"
              value={formatDuration(stats.averageDurationMs)}
            />
            <DetailField
              loading={runtime.isLoading}
              label="Abort requests"
              value={stats.abortRequests.toLocaleString()}
            />
            <DetailField
              loading={runtime.isLoading}
              label="Latest started"
              value={formatDate(activity?.summary?.latestStartedAt)}
            />
            <DetailField
              loading={runtime.isLoading}
              label="Latest finished"
              value={formatDate(activity?.summary?.latestFinishedAt)}
            />
          </div>
        </DetailPanel>
        <DetailPanel title="Latest Run">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
            <DetailField
              loading={runtime.isLoading}
              label="Status"
              value={
                stats.latestRun ? (
                  <StatusBadge status={stats.latestRun.status} />
                ) : (
                  "-"
                )
              }
            />
            <DetailField
              loading={runtime.isLoading}
              label="Run"
              value={
                stats.latestRun ? (
                  <code>{short(stats.latestRun.id)}</code>
                ) : (
                  "-"
                )
              }
            />
            <DetailField
              loading={runtime.isLoading}
              label="Started"
              value={formatDate(stats.latestRun?.startedAt)}
            />
            <DetailField
              loading={runtime.isLoading}
              label="Duration"
              value={formatDuration(stats.latestRun?.durationMs)}
            />
            <DetailField
              loading={runtime.isLoading}
              label="Failure"
              value={runtimeFailureLabel(stats.latestRun)}
            />
          </div>
        </DetailPanel>
      </div>
      <RuntimeRunsTable
        response={runtimeTableResponse(activity, table.params)}
        table={table}
        loading={runtime.isLoading}
        fetching={runtime.isFetching}
        showModelCallLink={auth.session?.role === "admin"}
      />
      <TodosPanel agentKey={agentKey} sessionId={sessionId} />
    </div>
  )
}

function RuntimeRunsTable({
  response,
  table,
  loading,
  fetching,
  error,
  showModelCallLink = false,
}: {
  response?: PaginatedResponse<RuntimeRun>
  table: DataTableState
  loading?: boolean
  fetching?: boolean
  error?: unknown
  showModelCallLink?: boolean
}) {
  const navigate = useNavigate()
  const [selectedRun, setSelectedRun] = React.useState<RuntimeRun | null>(null)
  const columns: ColumnDef<RuntimeRun>[] = [
    {
      accessorKey: "id",
      meta: { label: "Run" },
      header: renderColumnHeader,
      enableSorting: true,
      enableHiding: false,
      cell: ({ row }) => <Cell highlighted>{short(row.original.id)}</Cell>,
    },
    {
      accessorKey: "status",
      meta: { label: "Status" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    },
    {
      accessorKey: "startedAt",
      meta: { label: "Started", valueType: "datetime", align: "right" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => <Cell>{formatDate(row.original.startedAt)}</Cell>,
    },
    {
      accessorKey: "durationMs",
      meta: { label: "Duration", valueType: "number" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => <Cell>{formatDuration(row.original.durationMs)}</Cell>,
    },
    {
      accessorKey: "finishedAt",
      meta: { label: "Finished", valueType: "datetime", align: "right" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => <Cell>{formatDate(row.original.finishedAt)}</Cell>,
    },
    {
      accessorKey: "errorSummary",
      meta: { label: "Failure", maxWidthClassName: "max-w-[28rem]" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => (
        <TruncatedText value={runtimeFailureLabel(row.original)} />
      ),
    },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      enableHiding: false,
      meta: { linkEnabled: false, align: "right" },
      cell: ({ row }) => (
        <RowActionsMenu
          triggerLabel={`Open actions for runtime run ${short(row.original.id)}`}
          actions={[
            {
              label: "Inspect",
              icon: <Eye className="size-4" />,
              onSelect: () => setSelectedRun(row.original),
            },
            ...(showModelCallLink
              ? [
                  {
                    label: "View model calls",
                    icon: <ExternalLink className="size-4" />,
                    onSelect: () =>
                      navigate(`/model-calls?run_id=${encodeURIComponent(row.original.id)}`),
                  },
                ]
              : []),
          ]}
        />
      ),
    },
  ]

  return (
    <>
      <DataTableView
        columns={columns}
        response={response}
        state={table}
        error={error}
        filters={
          <RuntimeRunFilters
            state={table}
            statusOptions={runtimeStatusFilterOptions}
            failureOptions={runtimeFailureCategoryFilterOptions}
          />
        }
        isFetching={fetching}
        isLoading={loading}
        rowKey={(row) => row.id}
        emptyLabel="No runtime runs for this session."
        mobileColumnVisibility={mobileHiddenColumns("startedAt", "finishedAt")}
      />
      <RuntimeRunDetailsSheet
        run={selectedRun}
        setRun={setSelectedRun}
      />
    </>
  )
}

function RuntimeRunDetailsSheet({
  run,
  setRun,
}: {
  run: RuntimeRun | null
  setRun: (run: RuntimeRun | null) => void
}) {
  return (
    <Sheet open={Boolean(run)} onOpenChange={(open) => !open && setRun(null)}>
      <SheetContent className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-md">
        <SheetHeader className="border-b pr-12">
          <SheetTitle>Runtime Run</SheetTitle>
          <SheetDescription>
            {run ? `${short(run.id)} - ${humanize(run.status)}` : "Runtime run details"}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {run ? (
            <div className="grid gap-4">
              <DetailPanel title="Execution">
                <div className="grid gap-3 sm:grid-cols-2">
                  <DetailField label="Status" value={<StatusBadge status={run.status} />} />
                  <DetailField label="Duration" value={formatDuration(run.durationMs)} />
                  <DetailField label="Started" value={formatDate(run.startedAt)} />
                  <DetailField label="Finished" value={formatDate(run.finishedAt)} />
                  <DetailField
                    label="Abort requested"
                    value={formatDate(run.abortRequestedAt)}
                  />
                  <DetailField label="Failure" value={runtimeFailureLabel(run)} />
                </div>
              </DetailPanel>
              <DetailPanel title="Identifiers">
                <DetailField
                  label="Run id"
                  value={<code className="break-all">{run.id}</code>}
                />
              </DetailPanel>
            </div>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function RuntimeFailureFocus({
  failed,
  failureRate,
  latestRun,
  onShowFailed,
}: {
  failed: number
  failureRate: string
  latestRun?: RuntimeRun
  onShowFailed: () => void
}) {
  return (
    <div className="mb-3 flex min-w-0 flex-col gap-3 border border-destructive/30 bg-destructive/5 p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 gap-3">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div className="min-w-0">
          <div className="font-medium text-destructive">
            {failed.toLocaleString()} failed runtime runs
          </div>
          <div className="mt-1 min-w-0 truncate text-xs text-muted-foreground">
            {failureRate} failure rate
            {latestRun
              ? ` - latest ${short(latestRun.id)} at ${formatDate(latestRun.startedAt) ?? "-"}`
              : ""}
          </div>
          {latestRun?.errorSummary ? (
            <div className="mt-1 min-w-0 truncate text-xs text-foreground" title={latestRun.errorSummary}>
              {latestRun.errorSummary}
            </div>
          ) : null}
        </div>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="shrink-0 border-destructive/30 text-destructive hover:text-destructive"
        onClick={onShowFailed}
      >
        Show failed runs
      </Button>
    </div>
  )
}

function runtimeFailureLabel(run?: RuntimeRun | null) {
  if (!run) return "-"
  if (run.errorSummary) return run.errorSummary
  const category = humanize(run.failureCategory)
  if (category !== "-") return category
  return run.status === "failed" ? "Failed" : "-"
}

function RuntimeRunFilters({
  state,
  statusOptions,
  failureOptions,
}: {
  state: DataTableState
  statusOptions: Array<{ label: string; value: string }>
  failureOptions: Array<{ label: string; value: string }>
}) {
  return (
    <>
      <TableSelectFilter
        state={state}
        id="status"
        label="Status"
        allLabel="All statuses"
        options={statusOptions}
        triggerClassName="w-36"
      />
      {failureOptions.length > 0 ? (
        <TableSelectFilter
          state={state}
          id="failure_category"
          label="Failure"
          allLabel="All failures"
          options={failureOptions}
          triggerClassName="w-40"
        />
      ) : null}
    </>
  )
}

function runtimeRows(activity?: RuntimeActivity) {
  return activity?.data ?? activity?.runs ?? []
}

function runtimeTableResponse(
  activity?: RuntimeActivity,
  params?: TableParams
): PaginatedResponse<RuntimeRun> | undefined {
  if (!activity) return undefined
  if (activity.data && activity.meta) {
    return { data: activity.data, meta: activity.meta }
  }

  const rows = fallbackRuntimeRows(runtimeRows(activity), params)
  const perPage = positiveNumber(params?.per_page, 10)
  const lastPage = Math.max(1, Math.ceil(rows.length / perPage))
  const currentPage = Math.min(positiveNumber(params?.page, 1), lastPage)
  const offset = (currentPage - 1) * perPage
  return {
    data: rows.slice(offset, offset + perPage),
    meta: {
      current_page: currentPage,
      last_page: lastPage,
      per_page: perPage,
      total: rows.length,
    },
  }
}

function fallbackRuntimeRows(rows: RuntimeRun[], params?: TableParams) {
  const search =
    typeof params?.search === "string" ? params.search.trim().toLowerCase() : ""
  const status = typeof params?.status === "string" ? params.status : ""
  const failureCategory =
    typeof params?.failure_category === "string" ? params.failure_category : ""
  const sortBy =
    typeof params?.sort_by === "string" ? params.sort_by : undefined
  const sortDirection = params?.sort_direction === "asc" ? "asc" : "desc"

  const filtered = rows.filter((run) => {
    if (status && run.status !== status) return false
    if (failureCategory && run.failureCategory !== failureCategory) {
      return false
    }
    if (!search) return true
    return [
      run.id,
      run.status,
      run.failureCategory,
      run.errorSummary,
      run.startedAt,
      run.finishedAt,
    ]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(search))
  })

  if (!sortBy) return filtered

  return [...filtered].sort((left, right) => {
    const leftValue = runtimeRunSortValue(left, sortBy)
    const rightValue = runtimeRunSortValue(right, sortBy)
    const result = compareNullable(leftValue, rightValue)
    return sortDirection === "asc" ? result : -result
  })
}

function runtimeRunSortValue(run: RuntimeRun, sortBy: string) {
  switch (sortBy) {
    case "durationMs":
      return run.durationMs
    case "failureCategory":
      return run.failureCategory
    case "errorSummary":
      return run.errorSummary
    case "finishedAt":
      return run.finishedAt
    case "id":
      return run.id
    case "status":
      return run.status
    case "startedAt":
      return run.startedAt
    default:
      return undefined
  }
}

function runtimeStats(activity?: RuntimeActivity) {
  const rows = runtimeRows(activity)
  const completed =
    activity?.summary?.completed ??
    rows.filter((run) => run.status === "completed").length
  const failed =
    activity?.summary?.failed ??
    rows.filter((run) => run.status === "failed").length
  const terminal = completed + failed
  const latestRun = activity?.summary?.latestRun ?? rows[0]

  return {
    abortRequests:
      activity?.summary?.abortRequests ??
      rows.filter((run) => Boolean(run.abortRequestedAt)).length,
    averageDurationMs:
      activity?.summary?.averageDurationMs ?? averageRunDuration(rows),
    completed,
    failed,
    failureRate:
      terminal > 0 ? `${Math.round((failed / terminal) * 100)}%` : "-",
    latestRun,
    running:
      activity?.summary?.running ??
      rows.filter((run) => run.status === "running").length,
    total: activity?.summary?.total ?? activity?.meta?.total ?? rows.length,
  }
}

function setTableFilter(
  state: DataTableState,
  id: string,
  value: string | number
) {
  state.setColumnFilters((previous) => [
    ...previous.filter((filter) => filter.id !== id),
    { id, value },
  ])
}

function averageRunDuration(rows: RuntimeRun[]) {
  const durations = rows
    .map((run) => run.durationMs)
    .filter((duration): duration is number => typeof duration === "number")
  if (durations.length === 0) return null
  const total = durations.reduce((sum, duration) => sum + duration, 0)
  return Math.round(total / durations.length)
}

function positiveNumber(value: unknown, fallback: number) {
  const parsed = typeof value === "number" ? value : Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function compareNullable(left: unknown, right: unknown) {
  if (left === right) return 0
  if (left === null || left === undefined) return -1
  if (right === null || right === undefined) return 1
  if (typeof left === "number" && typeof right === "number") {
    return left - right
  }
  return String(left).localeCompare(String(right))
}
