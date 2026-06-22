import type { ColumnDef, ColumnFiltersState } from "@tanstack/react-table"
import { useNavigate } from "react-router-dom"
import { Eye } from "lucide-react"

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
} from "@/features/control/formatting"
import {
  ProviderModel,
  TraceContext,
  modelCallDetailPath,
  usageSummary,
} from "@/features/control/model-calls/model-call-detail-content"
import type {
  ModelCallTraceSummary,
  TableParams,
} from "@/lib/api"

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
  const navigate = useNavigate()
  const table = useDataTableState(modelCallTableKey(initialFilters), {
    per_page: 25,
    columnFilters: initialColumnFilters(initialFilters),
  })
  const params = modelCallTraceParams(table.params)
  const traces = useModelCallTraces(params)
  const columns: ColumnDef<ModelCallTraceSummary>[] = [
    {
      accessorKey: "startedAt",
      meta: { label: "Started", valueType: "datetime", align: "right" },
      header: renderColumnHeader,
      enableSorting: false,
      cell: ({ row }) => <Cell>{formatDate(row.original.startedAt)}</Cell>,
    },
    {
      accessorKey: "finishedAt",
      meta: { label: "Finished", valueType: "datetime", align: "right" },
      header: renderColumnHeader,
      enableSorting: false,
      cell: ({ row }) => <Cell>{formatDate(row.original.finishedAt)}</Cell>,
    },
    {
      id: "providerModel",
      meta: { label: "Provider / Model", wrap: true, maxWidthClassName: "max-w-[18rem]" },
      header: renderColumnHeader,
      enableSorting: false,
      cell: ({ row }) => <ProviderModel trace={row.original} />,
    },
    {
      id: "state",
      meta: { label: "State" },
      header: renderColumnHeader,
      enableSorting: false,
      cell: ({ row }) => (
        <div className="flex min-w-0 flex-wrap gap-1">
          <StatusBadge status={row.original.status} />
          <Badge variant="outline">{humanize(row.original.mode)}</Badge>
        </div>
      ),
    },
    {
      id: "context",
      meta: { label: "Context", wrap: true, maxWidthClassName: "max-w-[28rem]" },
      header: renderColumnHeader,
      enableSorting: false,
      cell: ({ row }) => <TraceContext trace={row.original} />,
    },
    {
      accessorKey: "durationMs",
      meta: { label: "Duration", valueType: "number", align: "right" },
      header: renderColumnHeader,
      enableSorting: false,
      cell: ({ row }) => <Cell>{formatDuration(row.original.durationMs)}</Cell>,
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
      <div className="border p-3 text-xs text-muted-foreground">
        Admin-only debugger for sanitized model call traces. Prompt/cache identifiers and secret-like payloads are redacted at the API boundary. Text filters match exact IDs/keys, not full-text search.
      </div>
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
        mobileColumnVisibility={mobileHiddenColumns("startedAt", "finishedAt", "durationMs", "usage")}
      />
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

function modelCallTableKey(initialFilters?: InitialModelCallFilters) {
  return [
    "model-call-traces",
    initialFilters?.status ?? "",
    initialFilters?.mode ?? "",
    initialFilters?.agentKey ?? "",
    initialFilters?.sessionId ?? "",
    initialFilters?.runId ?? "",
  ].join(":")
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
