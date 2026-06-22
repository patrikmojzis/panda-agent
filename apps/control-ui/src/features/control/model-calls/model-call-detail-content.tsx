import * as React from "react"
import { Link } from "react-router-dom"
import {
  ArrowLeft,
  Clock,
  Gauge,
  MessageSquare,
  RefreshCw,
  Search,
  Server,
  Wrench,
} from "lucide-react"

import { sessionPath } from "@/app/control-routes"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { DetailField, DetailPanel } from "@/features/control/detail-primitives"
import { StatusBadge, humanize, short } from "@/features/control/control-display"
import {
  formatBytes,
  formatDate,
  formatDuration,
} from "@/features/control/formatting"
import {
  friendlySessionLabel,
  shortSessionId,
} from "@/features/control/session-labels"
import { cn } from "@/lib/utils"
import type {
  ModelCallTraceDetail,
  ModelCallTraceSummary,
} from "@/lib/api"

import {
  buildModelCallTraceViewModel,
  formatSanitizedJson,
  previewForValue,
  sanitizeDisplayString,
  type ModelCallTraceViewModel,
  type TraceSpan,
  type TraceSpanKind,
  type TraceSpanStatus,
} from "./model-call-trace-view-model"

const PROMPT_CACHE_REDACTION_PATTERN = /^\[redacted:([^:]+):sha256:([a-f0-9]{16})\]$/
const FILTERS: Array<{ label: string; value: SpanFilter }> = [
  { label: "All", value: "all" },
  { label: "Tools", value: "tools" },
  { label: "Errors", value: "errors" },
  { label: "Messages", value: "messages" },
  { label: "Context", value: "context" },
]

type SpanFilter = "all" | "tools" | "errors" | "messages" | "context"

export function modelCallDetailPath(traceId: string) {
  return `/model-calls/${encodeURIComponent(traceId)}`
}

export function ModelCallTraceDebugger({
  trace,
  refreshing = false,
  onRefresh,
}: {
  trace: ModelCallTraceDetail
  refreshing?: boolean
  onRefresh?: () => void
}) {
  const viewModel = React.useMemo(() => buildModelCallTraceViewModel(trace), [trace])
  const [filter, setFilter] = React.useState<SpanFilter>("all")
  const [query, setQuery] = React.useState("")
  const [selectedSpanId, setSelectedSpanId] = React.useState(viewModel.selectedDefaultId ?? "")

  React.useEffect(() => {
    setSelectedSpanId(viewModel.selectedDefaultId ?? "")
  }, [trace.id, viewModel.selectedDefaultId])

  const filteredSpans = React.useMemo(
    () => viewModel.spans.filter((span) => spanMatches(span, filter, query)),
    [filter, query, viewModel.spans]
  )
  const selectedSpan =
    viewModel.spans.find((span) => span.id === selectedSpanId) ??
    filteredSpans[0] ??
    viewModel.spans[0] ??
    null

  return (
    <div className="grid min-w-0 max-w-full gap-4">
      <TraceStickyHeader trace={trace} refreshing={refreshing} onRefresh={onRefresh} />
      <TraceSummaryCards trace={trace} viewModel={viewModel} />
      <TriageStrip trace={trace} viewModel={viewModel} onSelectSpan={setSelectedSpanId} />
      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(21rem,28rem)]">
        <section className="grid min-w-0 gap-3" aria-label="Model call timeline">
          <TimelineToolbar
            filter={filter}
            query={query}
            spans={viewModel.spans}
            filteredCount={filteredSpans.length}
            onFilterChange={setFilter}
            onQueryChange={setQuery}
            onSelectSpan={setSelectedSpanId}
            viewModel={viewModel}
          />
          <div className="grid min-w-0 gap-2">
            {filteredSpans.length > 0 ? (
              filteredSpans.map((span) => (
                <TimelineSpanCard
                  key={span.id}
                  span={span}
                  selected={selectedSpan?.id === span.id}
                  onSelect={() => setSelectedSpanId(span.id)}
                />
              ))
            ) : (
              <div className="border p-6 text-sm text-muted-foreground" role="status">
                No timeline spans match this filter/search.
              </div>
            )}
          </div>
        </section>
        <SpanInspector span={selectedSpan} />
      </div>
      <RawTraceDetails trace={trace} />
    </div>
  )
}

function TraceStickyHeader({
  trace,
  refreshing,
  onRefresh,
}: {
  trace: ModelCallTraceDetail
  refreshing: boolean
  onRefresh?: () => void
}) {
  return (
    <div className="sticky top-14 z-10 -mx-3 border-b bg-background/95 px-3 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/85 md:-mx-5 md:px-5">
      <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <div className="mb-1 flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted-foreground uppercase">
            <Link to="/model-calls" className="hover:text-foreground">
              Model Calls
            </Link>
            <span>/</span>
            <code className="truncate">{short(trace.id)}</code>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <StatusBadge status={trace.status} />
            <h1 className="min-w-0 break-words text-lg font-semibold tracking-normal">
              {trace.provider}/{trace.model}
            </h1>
            <Badge variant="outline">{humanize(trace.mode)}</Badge>
          </div>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{formatDate(trace.startedAt) ?? "No start time"}</span>
            <span>{formatDuration(trace.durationMs) ?? "No duration"}</span>
            <span>{usageSummary(trace.usage)}</span>
            <span className="min-w-0 break-all">Trace <code>{trace.id}</code></span>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link to="/model-calls">
              <ArrowLeft className="size-4" />
              Back
            </Link>
          </Button>
          {onRefresh ? (
            <Button variant="outline" size="sm" onClick={onRefresh} disabled={refreshing}>
              <RefreshCw className={cn("size-4", refreshing ? "animate-spin" : null)} />
              Refresh
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function TraceSummaryCards({
  trace,
  viewModel,
}: {
  trace: ModelCallTraceDetail
  viewModel: ModelCallTraceViewModel
}) {
  const slowest = viewModel.summary.slowestSpan
  const failing = viewModel.summary.failingSpan

  return (
    <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-5">
      <SummaryCard
        icon={<Gauge className="size-4" />}
        label="Outcome"
        value={<StatusBadge status={trace.status} />}
        detail={failing ? `${failing.title}: ${failing.preview ?? "failed"}` : "No failing span detected"}
      />
      <SummaryCard
        icon={<Clock className="size-4" />}
        label="Timing"
        value={formatDuration(trace.durationMs) ?? "-"}
        detail={
          slowest
            ? `Slowest known: ${slowest.title} (${formatDuration(slowest.durationMs) ?? "-"})`
            : formatDuration(trace.durationMs)
              ? `No per-step timing captured; whole-call duration is ${formatDuration(trace.durationMs)}.`
              : "No per-step or whole-call timing captured."
        }
      />
      <SummaryCard
        icon={<Server className="size-4" />}
        label="Model / Provider"
        value={trace.provider}
        detail={trace.model}
        monoDetail
      />
      <SummaryCard
        icon={<MessageSquare className="size-4" />}
        label="Usage / Cost"
        value={usageSummary(trace.usage)}
        detail="Input/output/cache tokens when provider usage is captured"
      />
      <SummaryCard
        icon={<Wrench className="size-4" />}
        label="Tools"
        value={`${viewModel.summary.toolCalls} call${viewModel.summary.toolCalls === 1 ? "" : "s"}`}
        detail={`${viewModel.summary.toolErrors} error${viewModel.summary.toolErrors === 1 ? "" : "s"} · ${viewModel.summary.messageCount} message spans`}
      />
      <SummaryCard
        className="sm:col-span-2 xl:col-span-5"
        label="Related run context"
        value={<TraceContext trace={trace} />}
        detail={
          <div className="mt-2 grid min-w-0 gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <SmallField label="Started" value={formatDate(trace.startedAt) ?? "-"} />
            <SmallField label="Finished" value={formatDate(trace.finishedAt) ?? "-"} />
            <SmallField label="Turn" value={trace.turn !== null ? String(trace.turn) : "-"} />
            <SmallField label="Call index" value={trace.callIndex !== null ? `#${trace.callIndex}` : "-"} />
            <SmallField label="Run" value={<CodeValue value={trace.runId} short />} />
            <SmallField label="Thread" value={<CodeValue value={trace.threadId} short />} />
            <SmallField label="Expires" value={formatDate(trace.expiresAt) ?? "-"} />
            <SmallField label="Prompt cache" value={<RedactedValue value={trace.promptCacheKey} />} />
          </div>
        }
      />
    </div>
  )
}

function TriageStrip({
  trace,
  viewModel,
  onSelectSpan,
}: {
  trace: ModelCallTraceDetail
  viewModel: ModelCallTraceViewModel
  onSelectSpan: (spanId: string) => void
}) {
  const failing = viewModel.summary.failingSpan
  const slowest = viewModel.summary.slowestSpan
  return (
    <div className="flex min-w-0 flex-col gap-2 border bg-muted/20 p-3 text-sm lg:flex-row lg:items-center lg:justify-between">
      <div className="min-w-0 space-y-1">
        <div className="font-medium">Operator triage</div>
        <div className="min-w-0 text-muted-foreground">
          {failing ? (
            <span>Failing step: <strong className="font-medium text-foreground">{failing.title}</strong></span>
          ) : (
            <span>No failed step found in the sanitized trace.</span>
          )}{" "}
          {slowest ? (
            <span>Slowest known step: <strong className="font-medium text-foreground">{slowest.title}</strong>.</span>
          ) : formatDuration(trace.durationMs) ? (
            <span>No per-step timings are captured; whole-call duration is {formatDuration(trace.durationMs)}.</span>
          ) : (
            <span>No per-step or whole-call timing is captured for this trace.</span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={!failing}
          onClick={() => failing && onSelectSpan(failing.id)}
        >
          Jump to failed
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!slowest}
          onClick={() => slowest && onSelectSpan(slowest.id)}
        >
          Jump to slowest
        </Button>
      </div>
    </div>
  )
}

function TimelineToolbar({
  filter,
  filteredCount,
  query,
  spans,
  viewModel,
  onFilterChange,
  onQueryChange,
  onSelectSpan,
}: {
  filter: SpanFilter
  filteredCount: number
  query: string
  spans: TraceSpan[]
  viewModel: ModelCallTraceViewModel
  onFilterChange: (filter: SpanFilter) => void
  onQueryChange: (query: string) => void
  onSelectSpan: (spanId: string) => void
}) {
  return (
    <DetailPanel
      title="Trace timeline"
      action={
        <span className="text-xs text-muted-foreground">
          {filteredCount}/{spans.length} spans
        </span>
      }
    >
      <div className="grid min-w-0 gap-3">
        <div className="flex min-w-0 flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 flex-wrap gap-2">
            {FILTERS.map((item) => (
              <Button
                key={item.value}
                type="button"
                variant={filter === item.value ? "secondary" : "outline"}
                size="sm"
                onClick={() => onFilterChange(item.value)}
              >
                {item.label}
              </Button>
            ))}
          </div>
          <div className="relative min-w-0 lg:w-72">
            <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
            <Input
              aria-label="Search timeline"
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="Search safe previews"
              className="h-9 pl-8 text-sm"
            />
          </div>
        </div>
        <div className="flex min-w-0 flex-wrap gap-2 text-xs text-muted-foreground">
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs"
            disabled={!viewModel.summary.failingSpan}
            onClick={() => viewModel.summary.failingSpan && onSelectSpan(viewModel.summary.failingSpan.id)}
          >
            Failed
          </Button>
          <span>·</span>
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs"
            disabled={!viewModel.summary.slowestSpan}
            onClick={() => viewModel.summary.slowestSpan && onSelectSpan(viewModel.summary.slowestSpan.id)}
          >
            Slowest
          </Button>
          <span>· Raw JSON is below the debugger, collapsed by default.</span>
        </div>
      </div>
    </DetailPanel>
  )
}

function TimelineSpanCard({
  span,
  selected,
  onSelect,
}: {
  span: TraceSpan
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "grid min-w-0 gap-3 border p-3 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        selected ? "border-primary bg-muted/50" : "hover:bg-muted/30"
      )}
      aria-pressed={selected}
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Badge variant="outline" className="tabular-nums">#{span.order}</Badge>
            <SpanStatusBadge status={span.status} />
            <Badge variant="secondary">{kindLabel(span.kind)}</Badge>
            <span className="min-w-0 break-words text-sm font-medium">{span.title}</span>
          </div>
          {span.subtitle ? (
            <div className="mt-1 min-w-0 break-words text-xs text-muted-foreground">
              {span.subtitle}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          {span.durationMs !== null ? <Badge variant="outline">{formatDuration(span.durationMs)}</Badge> : null}
          {span.metrics.slice(0, 2).map((metric) => (
            <Badge key={`${metric.label}:${metric.value}`} variant="outline">
              {metric.value}
            </Badge>
          ))}
        </div>
      </div>
      {span.preview ? <ReadablePreview value={span.preview} /> : null}
      {span.tool ? <ToolPairPreview span={span} /> : null}
      {span.badges.length > 0 ? (
        <div className="flex min-w-0 flex-wrap gap-1">
          {span.badges.map((badge) => (
            <Badge key={badge} variant={badge === "Redacted" ? "secondary" : "outline"} className="max-w-full min-w-0">
              <span className="truncate">{badge}</span>
            </Badge>
          ))}
        </div>
      ) : null}
    </button>
  )
}

function ToolPairPreview({ span }: { span: TraceSpan }) {
  const tool = span.tool
  if (!tool) return null
  return (
    <div className="grid min-w-0 gap-2 md:grid-cols-2">
      <MiniPayloadPreview
        label="Arguments"
        value={tool.argumentsPreview ?? "No arguments captured"}
        meta={tool.argumentsSize !== null ? formatBytes(tool.argumentsSize) : undefined}
        mono
      />
      <MiniPayloadPreview
        label={tool.isError ? "Error result" : "Result"}
        value={tool.resultPreview ?? "No paired result in this trace"}
        meta={tool.resultSize !== null ? formatBytes(tool.resultSize) : undefined}
        muted={!tool.resultPreview}
      />
    </div>
  )
}

function SpanInspector({ span }: { span: TraceSpan | null }) {
  if (!span) {
    return (
      <aside className="min-w-0 xl:sticky xl:top-32 xl:self-start">
        <DetailPanel title="Inspector">
          <div className="text-sm text-muted-foreground">Select a timeline span to inspect it.</div>
        </DetailPanel>
      </aside>
    )
  }

  return (
    <aside className="min-w-0 xl:sticky xl:top-32 xl:self-start">
      <DetailPanel title="Inspector" action={<SpanStatusBadge status={span.status} />}>
        <div className="grid min-w-0 gap-4">
          <div className="grid min-w-0 gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Badge variant="outline" className="tabular-nums">#{span.order}</Badge>
              <Badge variant="secondary">{kindLabel(span.kind)}</Badge>
              <span className="min-w-0 break-words text-sm font-semibold">{span.title}</span>
            </div>
            {span.subtitle ? (
              <div className="text-sm text-muted-foreground">{span.subtitle}</div>
            ) : null}
            {span.preview ? <ReadablePreview value={span.preview} className="max-h-40" /> : null}
          </div>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
            {span.metrics.map((metric) => (
              <DetailField key={`${metric.label}:${metric.value}`} label={metric.label} value={metric.value} />
            ))}
            {span.tool?.callId ? (
              <DetailField label="Tool call id" value={<CodeValue value={span.tool.callId} />} />
            ) : null}
            {span.role ? <DetailField label="Role" value={humanize(span.role)} /> : null}
            {span.source ? <DetailField label="Source" value={span.source} /> : null}
          </div>
          {span.tool ? <ToolInspectorSections span={span} /> : <PayloadSection title="Payload" value={span.raw} />}
          <details className="grid min-w-0 gap-2">
            <summary className="cursor-pointer select-none text-xs text-muted-foreground">
              Raw selected span JSON
            </summary>
            <SanitizedJsonBlock value={span.raw} />
          </details>
        </div>
      </DetailPanel>
    </aside>
  )
}

function ToolInspectorSections({ span }: { span: TraceSpan }) {
  const tool = span.tool
  if (!tool) return null
  return (
    <div className="grid min-w-0 gap-3">
      <PayloadSection title="Arguments" value={tool.arguments} emptyLabel="No arguments captured." json />
      <PayloadSection
        title={tool.isError ? "Result error" : "Result"}
        value={tool.result}
        emptyLabel="No paired result is present in this trace."
      />
      <BashToolDetails span={span} />
      <div className="grid min-w-0 gap-2 border bg-muted/20 p-3 text-xs text-muted-foreground">
        <div className="font-medium text-foreground">Pairing</div>
        <div>
          {tool.callId ? (
            <>Call/result were paired automatically by <code>{tool.callId}</code>.</>
          ) : (
            "No tool call id was available; this span was grouped by trace position."
          )}
        </div>
        <div>
          {tool.truncated ? "Trace contains truncation markers." : "No truncation marker detected."}{" "}
          {tool.redacted ? "Redaction marker detected." : "No redaction marker detected."}
        </div>
      </div>
    </div>
  )
}

function BashToolDetails({ span }: { span: TraceSpan }) {
  const tool = span.tool
  const raw = asRecord(span.raw)
  const call = asRecord(tool?.call) ?? asRecord(raw?.call)
  const result = asRecord(raw?.result)
  const args = asRecord(tool?.arguments) ?? asRecord(call?.arguments)
  const details = asRecord(result?.details) ?? asRecord(tool?.result)
  const command = firstString(args, ["command"]) ?? firstString(details, ["command"])
  const cwd = firstString(args, ["cwd"]) ?? firstString(details, ["cwd", "initialCwd", "finalCwd"])
  const stdout = firstString(details, ["stdout"])
  const stderr = firstString(details, ["stderr"])
  const exitCode = firstPrimitive(details, ["exitCode", "signal"])
  const status = firstPrimitive(details, ["status"])
  const timedOut = firstBoolean(details, ["timedOut", "aborted", "interrupted"])
  const stdoutChars = firstNumber(details, ["stdoutChars"])
  const stderrChars = firstNumber(details, ["stderrChars"])
  const stdoutTruncated = firstBoolean(details, ["stdoutTruncated"])
  const stderrTruncated = firstBoolean(details, ["stderrTruncated"])
  const looksLikeBash = tool?.name === "bash" || firstString(details, ["kind"]) === "bash" || Boolean(command || stdout || stderr || exitCode !== null)

  if (!looksLikeBash) return null

  return (
    <section className="grid min-w-0 gap-3 border bg-muted/20 p-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">Bash execution</h3>
        {exitCode !== null ? <Badge variant="outline">exit {String(exitCode)}</Badge> : null}
        {exitCode === null && status !== null ? <Badge variant="outline">{String(status)}</Badge> : null}
        {timedOut ? <Badge variant="destructive">Interrupted</Badge> : null}
      </div>
      <div className="grid min-w-0 gap-2 text-xs">
        {command ? (
          <div className="grid min-w-0 gap-1">
            <span className="text-muted-foreground">Command</span>
            <code className="max-h-24 overflow-auto whitespace-pre-wrap break-words border bg-background/60 p-2 [overflow-wrap:anywhere]">
              {sanitizeDisplayString(command)}
            </code>
          </div>
        ) : null}
        {cwd ? (
          <div className="min-w-0">
            <span className="text-muted-foreground">cwd </span>
            <code className="break-all">{sanitizeDisplayString(cwd)}</code>
          </div>
        ) : null}
      </div>
      <div className="grid min-w-0 gap-2 lg:grid-cols-2">
        <OutputPane
          label="stdout"
          value={stdout}
          chars={stdoutChars}
          truncated={stdoutTruncated}
        />
        <OutputPane
          label="stderr"
          value={stderr}
          chars={stderrChars}
          truncated={stderrTruncated}
        />
      </div>
    </section>
  )
}

function OutputPane({
  chars,
  label,
  truncated,
  value,
}: {
  chars: number | null
  label: string
  truncated: boolean
  value: string | null
}) {
  return (
    <div className="grid min-w-0 gap-1 border bg-background/60 p-2">
      <div className="flex min-w-0 items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{label}</span>
        <span className="flex shrink-0 items-center gap-1">
          {chars !== null ? <span className="tabular-nums">{formatNumberCompact(chars)} chars</span> : null}
          {truncated ? <Badge variant="secondary">Truncated</Badge> : null}
        </span>
      </div>
      {value ? (
        <pre className="max-h-48 max-w-full overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed [overflow-wrap:anywhere]">
          {sanitizeDisplayString(value)}
        </pre>
      ) : (
        <div className="text-xs text-muted-foreground">No {label} captured.</div>
      )}
    </div>
  )
}

function PayloadSection({
  title,
  value,
  emptyLabel = "No payload captured.",
  json = false,
}: {
  title: string
  value: unknown
  emptyLabel?: string
  json?: boolean
}) {
  const preview = previewForValue(value)
  if (!preview) {
    return (
      <section className="grid min-w-0 gap-2 border bg-muted/20 p-3">
        <h3 className="text-sm font-medium">{title}</h3>
        <div className="text-sm text-muted-foreground">{emptyLabel}</div>
      </section>
    )
  }

  return (
    <section className="grid min-w-0 gap-2 border bg-muted/20 p-3">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <h3 className="text-sm font-medium">{title}</h3>
        <Badge variant="outline">{formatBytes(new TextEncoder().encode(formatSanitizedJson(value)).length)}</Badge>
      </div>
      {json ? <SanitizedJsonBlock value={value} compact /> : <ReadablePreview value={preview} className="max-h-32" />}
      <details className="grid min-w-0 gap-2">
        <summary className="cursor-pointer select-none text-xs text-muted-foreground">
          Expand full sanitized payload
        </summary>
        {json ? <SanitizedJsonBlock value={value} /> : <ReadableFullValue value={value} />}
      </details>
    </section>
  )
}

function RawTraceDetails({ trace }: { trace: ModelCallTraceDetail }) {
  return (
    <details className="grid min-w-0 gap-2 border p-3">
      <summary className="cursor-pointer select-none text-sm font-medium">
        Sanitized raw trace JSON
      </summary>
      <div className="text-xs text-muted-foreground">
        Raw trace remains available for fallback debugging, but prompt-cache fields are redacted again in the UI before rendering.
      </div>
      <SanitizedJsonBlock value={trace} />
    </details>
  )
}

function SummaryCard({
  className,
  detail,
  icon,
  label,
  monoDetail = false,
  value,
}: {
  className?: string
  detail?: React.ReactNode
  icon?: React.ReactNode
  label: string
  monoDetail?: boolean
  value: React.ReactNode
}) {
  return (
    <div className={cn("grid min-w-0 gap-2 border p-3", className)}>
      <div className="flex min-w-0 items-center gap-2 text-xs font-medium text-muted-foreground uppercase">
        {icon}
        <span>{label}</span>
      </div>
      <div className="min-w-0 break-words text-sm font-semibold">{value}</div>
      {detail ? (
        <div className={cn("min-w-0 break-words text-xs text-muted-foreground", monoDetail ? "font-mono" : null)}>
          {detail}
        </div>
      ) : null}
    </div>
  )
}

function SmallField({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 min-w-0 break-words text-xs font-medium">{value}</div>
    </div>
  )
}

function MiniPayloadPreview({
  label,
  meta,
  mono = false,
  muted = false,
  value,
}: {
  label: string
  meta?: string
  mono?: boolean
  muted?: boolean
  value: string
}) {
  return (
    <div className="grid min-w-0 gap-1 border bg-background/60 p-2">
      <div className="flex min-w-0 items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{label}</span>
        {meta ? <span className="tabular-nums">{meta}</span> : null}
      </div>
      <div className={cn(
        "max-h-20 min-w-0 overflow-hidden break-words text-xs leading-relaxed [overflow-wrap:anywhere]",
        mono ? "font-mono" : null,
        muted ? "text-muted-foreground" : null,
      )}>
        {sanitizeDisplayString(value)}
      </div>
    </div>
  )
}

function ReadablePreview({ value, className }: { value: string; className?: string }) {
  return (
    <div className={cn(
      "max-w-full overflow-auto whitespace-pre-wrap break-words text-sm leading-relaxed [overflow-wrap:anywhere]",
      className,
    )}>
      {sanitizeDisplayString(value)}
    </div>
  )
}

function ReadableFullValue({ value }: { value: unknown }) {
  if (typeof value === "string") {
    return (
      <div className="max-h-80 max-w-full overflow-auto whitespace-pre-wrap break-words border bg-background/60 p-3 text-sm leading-relaxed [overflow-wrap:anywhere]">
        {sanitizeDisplayString(value)}
      </div>
    )
  }
  return <SanitizedJsonBlock value={value} />
}

function SanitizedJsonBlock({
  compact = false,
  value,
}: {
  compact?: boolean
  value: unknown
}) {
  return (
    <pre className={cn(
      "max-w-full overflow-auto whitespace-pre-wrap break-words border bg-background/60 p-3 font-mono text-xs leading-relaxed [overflow-wrap:anywhere]",
      compact ? "max-h-40" : "max-h-96",
    )}>
      {formatSanitizedJson(value)}
    </pre>
  )
}

function SpanStatusBadge({ status }: { status: TraceSpanStatus }) {
  return <Badge variant={spanStatusVariant(status)}>{spanStatusLabel(status)}</Badge>
}

function spanStatusVariant(status: TraceSpanStatus): React.ComponentProps<typeof Badge>["variant"] {
  if (status === "failed") return "destructive"
  if (status === "pending") return "secondary"
  return "outline"
}

function spanStatusLabel(status: TraceSpanStatus) {
  if (status === "ok") return "Ok"
  if (status === "failed") return "Failed"
  if (status === "pending") return "Pending"
  return "Info"
}

function kindLabel(kind: TraceSpanKind) {
  if (kind === "metadata") return "Metadata"
  return humanize(kind)
}

export function ProviderModel({ trace }: { trace: ModelCallTraceSummary }) {
  return (
    <div className="grid min-w-0 gap-1">
      <span className="break-words font-medium">{trace.provider}</span>
      <code className="break-all text-xs text-muted-foreground">{trace.model}</code>
    </div>
  )
}

export function TraceContext({ trace }: { trace: ModelCallTraceSummary }) {
  const items = [
    trace.agentKey ? { label: "Agent", value: trace.agentKey } : null,
    trace.sessionId
      ? {
          label: "Session",
          value: sessionContextLabel(trace),
          title: trace.sessionId,
        }
      : null,
    trace.runId ? { label: "Run", value: trace.runId } : null,
    trace.threadId ? { label: "Thread", value: trace.threadId } : null,
    trace.turn !== null ? { label: "Turn", value: String(trace.turn) } : null,
    trace.callIndex !== null ? { label: "Call", value: `#${trace.callIndex}` } : null,
  ].filter((item): item is { label: string; value: string; title?: string } => Boolean(item))

  if (items.length === 0) return <span className="text-muted-foreground">-</span>

  return (
    <div className="flex min-w-0 max-w-full flex-wrap gap-1">
      {items.map((item) => (
        <span
          key={`${item.label}:${item.value}`}
          className="inline-flex max-w-full min-w-0 items-center gap-1 border px-1.5 py-0.5 text-xs"
          title={item.title ?? item.value}
        >
          <span className="shrink-0 text-muted-foreground">{item.label}</span>
          <code className="min-w-0 truncate">{shortContextValue(item.value)}</code>
        </span>
      ))}
      <SessionLink trace={trace} />
    </div>
  )
}

function SessionLink({ trace }: { trace: ModelCallTraceSummary }) {
  if (!trace.agentKey || !trace.sessionId) return null
  return (
    <Button variant="link" size="sm" className="h-auto p-0 text-xs" asChild>
      <Link to={sessionPath(trace.agentKey, trace.sessionId)}>Open session</Link>
    </Button>
  )
}

function sessionContextLabel(trace: ModelCallTraceSummary) {
  if (!trace.sessionId) return ""
  const label = friendlySessionLabel({
    id: trace.sessionId,
    label: trace.sessionLabel,
    displayName: trace.sessionDisplayName,
    alias: trace.sessionAlias,
    kind: trace.sessionKind,
  })
  return `${label} · ${shortSessionId(trace.sessionId)}`
}

function CodeValue({ value, short: shorten = false }: { value?: string | null; short?: boolean }) {
  if (!value) return "-"
  return (
    <code className="break-all text-xs" title={value}>
      {shorten ? shortContextValue(value) : value}
    </code>
  )
}

function RedactedValue({ value }: { value?: string | null }) {
  if (!value) return "-"
  const match = PROMPT_CACHE_REDACTION_PATTERN.exec(value)
  return (
    <span className="inline-flex max-w-full flex-wrap items-center gap-1">
      <Badge variant="secondary">Redacted</Badge>
      <code className="break-all text-xs text-muted-foreground">
        {match ? `${match[1]} · sha256:${match[2]}` : "opaque value hidden"}
      </code>
    </span>
  )
}

export function usageSummary(value: unknown) {
  const usage = asRecord(value)
  if (!usage) return "-"
  const input = firstNumber(usage, ["input", "inputTokens", "promptTokens"])
  const output = firstNumber(usage, ["output", "outputTokens", "completionTokens"])
  const total = firstNumber(usage, ["totalTokens", "total", "tokens"])
  const cost = usageCostSummary(value)
  const parts = [
    input !== null ? `in ${input.toLocaleString()}` : null,
    output !== null ? `out ${output.toLocaleString()}` : null,
    total !== null ? `total ${total.toLocaleString()}` : null,
    cost,
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(" · ") : "-"
}

function usageCostSummary(value: unknown) {
  const usage = asRecord(value)
  const cost = asRecord(usage?.cost)
  if (!cost) return null
  const total = firstNumber(cost, ["total"])
  if (total !== null) return formatUsd(total)

  const components = ["input", "output", "cacheRead", "cacheWrite"]
    .map((key) => firstNumber(cost, [key]))
    .filter((entry): entry is number => entry !== null)
  if (components.length === 0) return null
  return formatUsd(components.reduce((sum, entry) => sum + entry, 0))
}

function formatUsd(value: number) {
  const abs = Math.abs(value)
  const maximumFractionDigits = abs > 0 && abs < 0.01 ? 6 : abs < 1 ? 4 : 2
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits,
  }).format(value)
}

function spanMatches(span: TraceSpan, filter: SpanFilter, query: string) {
  if (filter === "tools" && span.kind !== "tool") return false
  if (filter === "errors" && span.status !== "failed") return false
  if (filter === "messages" && span.kind !== "message" && span.kind !== "response") return false
  if (filter === "context" && span.kind !== "context" && span.kind !== "metadata") return false
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return true
  return spanSearchText(span).includes(normalizedQuery)
}

function spanSearchText(span: TraceSpan) {
  return [
    span.title,
    span.subtitle,
    span.preview,
    span.kind,
    span.status,
    span.role,
    span.source,
    span.tool?.name,
    span.tool?.callId,
    ...span.badges,
    ...span.metrics.flatMap((metric) => [metric.label, metric.value]),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
}

function shortContextValue(value: string) {
  if (value.startsWith("#")) return value
  return value.length > 42 ? `${value.slice(0, 24)}…${value.slice(-10)}` : value
}

function firstString(record: Record<string, unknown> | null | undefined, keys: string[]) {
  if (!record) return null
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) return value
    if (typeof value === "number" && Number.isFinite(value)) return String(value)
  }
  return null
}

function firstPrimitive(record: Record<string, unknown> | null | undefined, keys: string[]) {
  if (!record) return null
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) return value
    if (typeof value === "number" && Number.isFinite(value)) return value
    if (typeof value === "boolean") return value
  }
  return null
}

function firstBoolean(record: Record<string, unknown> | null | undefined, keys: string[]) {
  if (!record) return false
  return keys.some((key) => record[key] === true)
}

function firstNumber(record: Record<string, unknown> | null | undefined, keys: string[]) {
  if (!record) return null
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return null
}

function formatNumberCompact(value: number) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
