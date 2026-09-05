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
  { label: "Provider context overflow", value: "provider_context_overflow" },
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
        response={activity && { data: activity.data, meta: activity.meta }}
        table={table}
        loading={runtime.isLoading}
        fetching={runtime.isFetching}
        showModelCallLink={auth.session?.role === "admin"}
      />
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

function runtimeStats(activity?: RuntimeActivity) {
  const summary = activity?.summary
  const completed = summary?.completed ?? 0
  const failed = summary?.failed ?? 0
  const terminal = completed + failed

  return {
    abortRequests: summary?.abortRequests ?? 0,
    averageDurationMs: summary?.averageDurationMs ?? null,
    completed,
    failed,
    failureRate:
      terminal > 0 ? `${Math.round((failed / terminal) * 100)}%` : "-",
    latestRun: summary?.latestRun ?? undefined,
    running: summary?.running ?? 0,
    total: summary?.total ?? 0,
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
