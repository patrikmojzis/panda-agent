import * as React from "react"
import type { ColumnDef, ColumnFiltersState } from "@tanstack/react-table"
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  useModelCallTrace,
  useModelCallTraces,
} from "@/features/control/api/queries"
import {
  StatusBadge,
  humanize,
  mobileHiddenColumns,
  short,
} from "@/features/control/control-display"
import {
  DetailField,
  DetailPanel,
  TableError,
} from "@/features/control/detail-primitives"
import {
  formatDate,
  formatDuration,
} from "@/features/control/formatting"
import type {
  ModelCallTraceDetail,
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
  const table = useDataTableState(modelCallTableKey(initialFilters), {
    per_page: 25,
    columnFilters: initialColumnFilters(initialFilters),
  })
  const params = modelCallTraceParams(table.params)
  const traces = useModelCallTraces(params)
  const [selectedTrace, setSelectedTrace] = React.useState<ModelCallTraceSummary | null>(null)
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
      meta: { label: "Tokens", wrap: true, maxWidthClassName: "max-w-[12rem]" },
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
              onSelect: () => setSelectedTrace(row.original),
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
      <ModelCallTraceDetailsSheet
        trace={selectedTrace}
        setTrace={setSelectedTrace}
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

function ModelCallTraceDetailsSheet({
  trace,
  setTrace,
}: {
  trace: ModelCallTraceSummary | null
  setTrace: (trace: ModelCallTraceSummary | null) => void
}) {
  const detail = useModelCallTrace(trace?.id ?? "", { enabled: Boolean(trace?.id) })
  const fullTrace = detail.data?.modelCallTrace
  const visibleTrace = fullTrace ?? trace

  return (
    <Sheet open={Boolean(trace)} onOpenChange={(open) => !open && setTrace(null)}>
      <SheetContent className="gap-0 overflow-hidden data-[side=right]:w-full data-[side=right]:sm:max-w-4xl data-[side=right]:lg:max-w-5xl">
        <SheetHeader className="min-w-0 border-b pr-12">
          <SheetTitle>Model Call</SheetTitle>
          <SheetDescription className="min-w-0 break-words">
            {visibleTrace
              ? `${short(visibleTrace.id)} · ${visibleTrace.provider}/${visibleTrace.model} · ${humanize(visibleTrace.status)}`
              : "Sanitized model call trace"}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {detail.error && !fullTrace ? (
            <TableError error={detail.error} />
          ) : visibleTrace ? (
            <div className="grid min-w-0 gap-4">
              <TraceOverview trace={visibleTrace} />
              {fullTrace ? <TraceDetailSections trace={fullTrace} /> : null}
              {detail.isLoading ? (
                <div className="border p-3 text-sm text-muted-foreground">
                  Loading sanitized request and response details…
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function TraceOverview({
  trace,
  loading,
}: {
  trace: ModelCallTraceSummary
  loading?: boolean
}) {
  return (
    <DetailPanel title="Overview">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <DetailField label="Status" value={<StatusBadge status={trace.status} />} loading={loading} />
        <DetailField label="Mode" value={humanize(trace.mode)} loading={loading} />
        <DetailField label="Provider" value={trace.provider} loading={loading} />
        <DetailField label="Model" value={trace.model} loading={loading} />
        <DetailField label="Started" value={formatDate(trace.startedAt)} loading={loading} />
        <DetailField label="Finished" value={formatDate(trace.finishedAt)} loading={loading} />
        <DetailField label="Duration" value={formatDuration(trace.durationMs)} loading={loading} />
        <DetailField label="Tokens" value={usageSummary(trace.usage)} loading={loading} />
        <DetailField label="Agent" value={<CodeValue value={trace.agentKey} />} loading={loading} />
        <DetailField label="Session" value={<CodeValue value={trace.sessionId} />} loading={loading} />
        <DetailField label="Run" value={<CodeValue value={trace.runId} />} loading={loading} />
        <DetailField label="Thread" value={<CodeValue value={trace.threadId} />} loading={loading} />
        <DetailField label="Turn" value={trace.turn ?? "-"} loading={loading} />
        <DetailField label="Call index" value={trace.callIndex ?? "-"} loading={loading} />
        <DetailField label="Trace id" value={<CodeValue value={trace.id} />} loading={loading} />
        <DetailField label="Expires" value={formatDate(trace.expiresAt)} loading={loading} />
        <DetailField
          label="Prompt cache key"
          value={<RedactedValue value={trace.promptCacheKey} />}
          loading={loading}
        />
      </div>
    </DetailPanel>
  )
}

function TraceDetailSections({ trace }: { trace: ModelCallTraceDetail }) {
  const request = trace.request

  return (
    <>
      <DetailPanel title="Sanitized Request">
        <div className="grid min-w-0 gap-4">
          <TextBlock title="System prompt" value={request.systemPrompt} emptyLabel="No system prompt captured." />
          <JsonBlock title="LLM context sections" value={request.llmContextSections} emptyLabel="No LLM context sections captured." />
          {request.llmContextDump ? (
            <TextBlock title="LLM context dump" value={request.llmContextDump} />
          ) : null}
          <JsonBlock title="Projected messages" value={request.messages} emptyLabel="No projected messages captured." />
          <JsonBlock title="Tools / schema" value={request.tools} emptyLabel="No tools captured." />
        </div>
      </DetailPanel>
      <div className="grid min-w-0 gap-4 xl:grid-cols-3">
        <JsonBlock title="Response" value={trace.response} emptyLabel="No response captured." />
        <JsonBlock title="Error" value={trace.error} emptyLabel="No error captured." />
        <JsonBlock title="Usage" value={trace.usage} emptyLabel="No usage captured." />
      </div>
    </>
  )
}

function ProviderModel({ trace }: { trace: ModelCallTraceSummary }) {
  return (
    <div className="grid min-w-0 gap-1">
      <span className="break-words font-medium">{trace.provider}</span>
      <code className="break-all text-xs text-muted-foreground">{trace.model}</code>
    </div>
  )
}

function TraceContext({ trace }: { trace: ModelCallTraceSummary }) {
  const items = [
    trace.agentKey ? { label: "Agent", value: trace.agentKey } : null,
    trace.sessionId ? { label: "Session", value: trace.sessionId } : null,
    trace.runId ? { label: "Run", value: trace.runId } : null,
    trace.threadId ? { label: "Thread", value: trace.threadId } : null,
    trace.turn !== null ? { label: "Turn", value: String(trace.turn) } : null,
    trace.callIndex !== null ? { label: "Call", value: `#${trace.callIndex}` } : null,
  ].filter((item): item is { label: string; value: string } => Boolean(item))

  if (items.length === 0) return <span className="text-muted-foreground">-</span>

  return (
    <div className="flex min-w-0 max-w-full flex-wrap gap-1">
      {items.map((item) => (
        <span
          key={`${item.label}:${item.value}`}
          className="inline-flex max-w-full min-w-0 items-center gap-1 border px-1.5 py-0.5 text-xs"
          title={item.value}
        >
          <span className="shrink-0 text-muted-foreground">{item.label}</span>
          <code className="min-w-0 truncate">{shortContextValue(item.value)}</code>
        </span>
      ))}
    </div>
  )
}

function TextBlock({
  title,
  value,
  emptyLabel = "No content captured.",
}: {
  title: string
  value: unknown
  emptyLabel?: string
}) {
  if (value === null || value === undefined || value === "") {
    return <EmptyBlock title={title} emptyLabel={emptyLabel} />
  }
  const rendered = typeof value === "string" ? value : formatJson(value)
  return (
    <section className="grid min-w-0 gap-2">
      <h3 className="text-sm font-medium">{title}</h3>
      <pre className="max-h-80 max-w-full overflow-auto whitespace-pre-wrap break-words border bg-muted/30 p-3 font-mono text-xs leading-relaxed [overflow-wrap:anywhere]">
        {rendered}
      </pre>
    </section>
  )
}

function JsonBlock({
  title,
  value,
  emptyLabel = "No JSON captured.",
}: {
  title: string
  value: unknown
  emptyLabel?: string
}) {
  if (value === null || value === undefined || value === "") {
    return <EmptyBlock title={title} emptyLabel={emptyLabel} />
  }

  return (
    <section className="grid min-w-0 gap-2 border p-3">
      <h3 className="text-sm font-medium">{title}</h3>
      <pre className="max-h-96 max-w-full overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed [overflow-wrap:anywhere]">
        {formatJson(value)}
      </pre>
    </section>
  )
}

function EmptyBlock({ title, emptyLabel }: { title: string; emptyLabel: string }) {
  return (
    <section className="grid min-w-0 gap-2 border p-3">
      <h3 className="text-sm font-medium">{title}</h3>
      <div className="text-sm text-muted-foreground">{emptyLabel}</div>
    </section>
  )
}

function CodeValue({ value }: { value?: string | null }) {
  if (!value) return "-"
  return <code className="break-all text-xs">{value}</code>
}

function RedactedValue({ value }: { value?: string | null }) {
  if (!value) return "-"
  const match = /^\[redacted:([^:]+):sha256:([a-f0-9]{16})\]$/.exec(value)
  return (
    <span className="inline-flex max-w-full flex-wrap items-center gap-1">
      <Badge variant="secondary">Redacted</Badge>
      <code className="break-all text-xs text-muted-foreground">
        {match ? `${match[1]} · sha256:${match[2]}` : "opaque value hidden"}
      </code>
    </span>
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

function usageSummary(value: unknown) {
  const usage = asRecord(value)
  if (!usage) return "-"
  const input = firstNumber(usage, ["input", "inputTokens", "promptTokens"])
  const output = firstNumber(usage, ["output", "outputTokens", "completionTokens"])
  const total = firstNumber(usage, ["totalTokens", "total", "tokens"])
  const parts = [
    input !== null ? `in ${input.toLocaleString()}` : null,
    output !== null ? `out ${output.toLocaleString()}` : null,
    total !== null ? `total ${total.toLocaleString()}` : null,
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(" · ") : "-"
}

function firstNumber(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function shortContextValue(value: string) {
  if (value.startsWith("#")) return value
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value
}

function formatJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
