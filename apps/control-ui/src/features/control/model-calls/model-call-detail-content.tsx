import * as React from "react"
import { Link, useSearchParams } from "react-router-dom"
import {
  Activity,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Copy,
  DatabaseZap,
  Filter,
  GitCompareArrows,
  RefreshCw,
  Search,
} from "lucide-react"
import { toast } from "sonner"

import { sessionTabPath } from "@/app/control-routes"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { DetailField, DetailPanel } from "@/features/control/detail-primitives"
import { StatusBadge, humanize, short } from "@/features/control/control-display"
import {
  formatBytes,
  formatDate,
  formatDuration,
} from "@/features/control/formatting"
import { cn } from "@/lib/utils"
import type {
  ModelCallTraceDetail,
  ModelCallTraceSummary,
} from "@/lib/api"

import { TraceContext } from "./model-call-context"
import {
  bashExecutionHeadline,
  buildDebugReport,
  extractBashExecutionDetails,
  modelCallDetailPath,
  modelCallsListPath,
  readableContextContent,
  shortModelCallContextValue,
  traceDebugFindings,
  traceErrorSummary,
  usageSummary,
  usageBreakdown,
  usageTokenCounts,
} from "./model-call-display"
import {
  buildModelCallTraceViewModel,
  formatSanitizedJson,
  previewForValue,
  sanitizeDisplayString,
  type ModelCallTraceViewModel,
  type TraceSpan,
  type TraceSpanKind,
  type TraceSpanStatus,
  type TraceTriageItem,
} from "./model-call-trace-view-model"

const PROMPT_CACHE_REDACTION_PATTERN = /^\[redacted:([^:]+):sha256:([a-f0-9]{16})\]$/
const FILTERS: Array<{ label: string; value: SpanFilter }> = [
  { label: "All", value: "all" },
  { label: "Actions", value: "actions" },
  { label: "Tools", value: "tools" },
  { label: "Messages", value: "messages" },
  { label: "Attention", value: "attention" },
  { label: "Errors", value: "errors" },
  { label: "Context", value: "context" },
]

type SpanFilter = "actions" | "all" | "attention" | "tools" | "errors" | "messages" | "context"
type TraceView = "timeline" | "input" | "diff"
type TraceNavigation = {
  next: ModelCallTraceSummary | null
  previous: ModelCallTraceSummary | null
}

export function ModelCallTraceDebugger({
  compareTrace,
  comparing = false,
  relatedTraces = [],
  trace,
  refreshing = false,
  onRefresh,
}: {
  compareTrace?: ModelCallTraceDetail | null
  comparing?: boolean
  relatedTraces?: ModelCallTraceSummary[]
  trace: ModelCallTraceDetail
  refreshing?: boolean
  onRefresh?: () => void
}) {
  const [searchParams, setSearchParams] = useSearchParams()
  const viewModel = React.useMemo(() => buildModelCallTraceViewModel(trace), [trace])
  const compareViewModel = React.useMemo(
    () => compareTrace ? buildModelCallTraceViewModel(compareTrace) : null,
    [compareTrace]
  )
  const filter = parseSpanFilter(searchParams.get("filter"))
  const query = searchParams.get("q") ?? ""
  const activeView = parseTraceView(searchParams.get("view"))
  const selectedSpanParam = searchParams.get("span") ?? ""
  const navigation = React.useMemo(
    () => traceNavigation(trace, relatedTraces),
    [relatedTraces, trace]
  )
  const filterCounts = React.useMemo(() => spanFilterCounts(viewModel.spans), [viewModel.spans])
  const selectedSpanId = viewModel.spans.some((span) => span.id === selectedSpanParam)
    ? selectedSpanParam
    : (viewModel.selectedDefaultId ?? "")

  const filteredSpans = React.useMemo(
    () => viewModel.spans.filter((span) => spanMatches(span, filter, query)),
    [filter, query, viewModel.spans]
  )
  const hasTimelineFilter = filter !== "all" || query.trim() !== ""

  function updateTraceParams(
    patches: Record<string, string | null>,
    options: { replace?: boolean } = { replace: true }
  ) {
    const next = new URLSearchParams(searchParams)
    for (const [key, value] of Object.entries(patches)) {
      if (value === null || value === "") {
        next.delete(key)
      } else {
        next.set(key, value)
      }
    }
    setSearchParams(next, { replace: options.replace ?? true })
  }

  function setFilter(nextFilter: SpanFilter) {
    const selected = viewModel.spans.find((span) => span.id === selectedSpanParam)
    updateTraceParams({
      filter: nextFilter === "all" ? null : nextFilter,
      span: selected && spanMatches(selected, nextFilter, query) ? selected.id : null,
    })
  }

  function setQuery(nextQuery: string) {
    const selected = viewModel.spans.find((span) => span.id === selectedSpanParam)
    updateTraceParams({
      q: nextQuery.trim() ? nextQuery : null,
      span: selected && spanMatches(selected, filter, nextQuery) ? selected.id : null,
    })
  }

  function setView(nextView: TraceView) {
    updateTraceParams({ view: nextView === "timeline" ? null : nextView })
  }

  function clearTimelineFilters() {
    updateTraceParams({ filter: null, q: null, span: null })
  }

  function selectSpan(
    spanId: string,
    options: { filter?: SpanFilter; clearQuery?: boolean } = {}
  ) {
    const span = viewModel.spans.find((item) => item.id === spanId)
    const nextFilter = options.filter ?? (
      span && !spanMatches(span, filter, query) ? "all" : filter
    )
    const nextQuery = options.clearQuery ? "" : (
      span && !spanMatches(span, nextFilter, query) ? "" : query
    )
    updateTraceParams({
      filter: nextFilter === "all" ? null : nextFilter,
      q: nextQuery.trim() ? nextQuery : null,
      span: spanId,
      view: null,
    })
  }

  const explicitlySelectedSpan = viewModel.spans.find((span) => span.id === selectedSpanParam) ?? null
  const selectedSpan =
    explicitlySelectedSpan ??
    filteredSpans.find((span) => span.id === selectedSpanId) ??
    filteredSpans[0] ??
    (hasTimelineFilter ? null : viewModel.spans[0]) ??
    null
  const selectedSpanPath = selectedSpan
    ? traceDetailPathWithSearch(trace.id, searchParams, { span: selectedSpan.id, view: null })
    : null

  return (
    <div className="grid min-w-0 max-w-full gap-4">
      <TraceStickyHeader
        trace={trace}
        navigation={navigation}
        searchParams={searchParams}
        compareTrace={compareTrace}
        comparing={comparing}
        refreshing={refreshing}
        onRefresh={onRefresh}
      />
      <CacheUsageOverview usage={trace.usage} />
      <ModelOutcomePanel viewModel={viewModel} onSelectSpan={selectSpan} />
      <TraceDebugOverview
        trace={trace}
        viewModel={viewModel}
        selectedSpan={selectedSpan}
        onSelectSpan={selectSpan}
      />
      <Tabs value={activeView} onValueChange={(value) => setView(parseTraceView(value))}>
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <TabsList variant="line">
            <TabsTrigger value="timeline">Timeline</TabsTrigger>
            <TabsTrigger value="input">Input shape</TabsTrigger>
            <TabsTrigger value="diff">Diff</TabsTrigger>
          </TabsList>
          <div className="text-xs text-muted-foreground">
            {explicitlySelectedSpan
              ? <>Selected <code>{explicitlySelectedSpan.id}</code></>
              : "Select a span to inspect"}
          </div>
        </div>
        <TabsContent value="timeline" className="mt-1">
          <section className="grid min-w-0 gap-3" aria-label="Model call timeline">
            <TimelineToolbar
              filter={filter}
              filterCounts={filterCounts}
              query={query}
              spans={viewModel.spans}
              filteredCount={filteredSpans.length}
              onFilterChange={setFilter}
              onQueryChange={setQuery}
              onSelectSpan={selectSpan}
              viewModel={viewModel}
            />
            <div className="grid min-w-0 gap-2">
              {filteredSpans.length > 0 ? (
                filteredSpans.map((span) => (
                  <TimelineSpanCard
                    key={span.id}
                    span={span}
                    selected={explicitlySelectedSpan?.id === span.id}
                    onSelect={() => selectSpan(span.id)}
                  />
                ))
              ) : (
                <div className="grid gap-3 border p-6 text-sm text-muted-foreground" role="status">
                  <div>No timeline spans match this filter/search.</div>
                  {hasTimelineFilter ? (
                    <div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={clearTimelineFilters}
                      >
                        Clear timeline filters
                      </Button>
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          </section>
          <SpanInspectorSheet
            span={explicitlySelectedSpan}
            spanPath={selectedSpanPath}
            onClose={() => updateTraceParams({ span: null })}
          />
        </TabsContent>
        <TabsContent value="input" className="mt-1">
          <InputShapeView trace={trace} viewModel={viewModel} />
        </TabsContent>
        <TabsContent value="diff" className="mt-1">
          <TraceDiffPanel
            trace={trace}
            viewModel={viewModel}
            compareTrace={compareTrace}
            compareViewModel={compareViewModel}
            comparing={comparing}
            navigation={navigation}
            searchParams={searchParams}
          />
        </TabsContent>
      </Tabs>
      <RawTraceDetails trace={trace} />
    </div>
  )
}

function TraceStickyHeader({
  compareTrace,
  comparing,
  navigation,
  searchParams,
  trace,
  refreshing,
  onRefresh,
}: {
  compareTrace?: ModelCallTraceDetail | null
  comparing: boolean
  navigation: TraceNavigation
  searchParams: URLSearchParams
  trace: ModelCallTraceDetail
  refreshing: boolean
  onRefresh?: () => void
}) {
  const listPath = modelCallsListPath(trace)
  const previousPath = navigation.previous
    ? traceDetailPathWithSearch(navigation.previous.id, searchParams, { compare: null, span: null })
    : null
  const nextPath = navigation.next
    ? traceDetailPathWithSearch(navigation.next.id, searchParams, { compare: null, span: null })
    : null
  const comparePath = navigation.previous
    ? traceDetailPathWithSearch(trace.id, searchParams, {
        compare: navigation.previous.id,
        span: null,
        view: "diff",
      })
    : null
  const clearComparePath = traceDetailPathWithSearch(trace.id, searchParams, {
    compare: null,
    view: null,
  })

  return (
    <div className="sticky top-14 z-10 -mx-3 border-b bg-background/95 px-3 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/85 md:-mx-5 md:px-5">
      <div className="grid min-w-0 gap-3">
        <div className="min-w-0">
          <div className="mb-1 flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted-foreground uppercase">
            <Link to={listPath} className="hover:text-foreground">
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
        <div className="flex min-w-0 flex-wrap gap-2">
          <TraceNavButton
            path={previousPath}
            label="Prev"
            icon={<ChevronLeft className="size-4" />}
            disabledLabel="No previous call"
          />
          <TraceNavButton
            path={nextPath}
            label="Next"
            icon={<ChevronRight className="size-4" />}
            disabledLabel="No next call"
          />
          {compareTrace ? (
            <Button variant="outline" size="sm" asChild>
              <Link to={clearComparePath}>
                <GitCompareArrows className="size-4" />
                Clear diff
              </Link>
            </Button>
          ) : comparePath ? (
            <Button variant="outline" size="sm" asChild>
              <Link to={comparePath}>
                <GitCompareArrows className="size-4" />
                Diff prev
              </Link>
            </Button>
          ) : (
            <Button variant="outline" size="sm" disabled>
              <GitCompareArrows className="size-4" />
              {comparing ? "Loading diff" : "Diff prev"}
            </Button>
          )}
          <Button variant="outline" size="sm" asChild>
            <Link to={listPath}>
              <ArrowLeft className="size-4" />
              Back
            </Link>
          </Button>
          <CopyTraceIdButton traceId={trace.id} />
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

function TraceNavButton({
  disabledLabel,
  icon,
  label,
  path,
}: {
  disabledLabel: string
  icon: React.ReactNode
  label: string
  path: string | null
}) {
  if (!path) {
    return (
      <Button variant="outline" size="sm" disabled title={disabledLabel}>
        {icon}
        {label}
      </Button>
    )
  }
  return (
    <Button variant="outline" size="sm" asChild>
      <Link to={path}>
        {icon}
        {label}
      </Link>
    </Button>
  )
}

function TraceDebugOverview({
  selectedSpan,
  trace,
  viewModel,
  onSelectSpan,
}: {
  selectedSpan: TraceSpan | null
  trace: ModelCallTraceDetail
  viewModel: ModelCallTraceViewModel
  onSelectSpan: (spanId: string, options?: { filter?: SpanFilter; clearQuery?: boolean }) => void
}) {
  const slowest = viewModel.summary.slowestSpan
  const failing = viewModel.summary.failingSpan
  const fallbackError = traceErrorSummary(trace.error)
  const focusTitle = failing
    ? failing.title
    : trace.status === "failed"
      ? "Model call failed"
      : "No failed span"
  const focusDetail = failing?.preview ?? fallbackError ?? (
    trace.status === "failed"
      ? "The trace is failed, but no failing span was captured."
      : "No failure captured in this trace."
  )

  return (
    <section className="grid min-w-0 overflow-hidden border bg-background shadow-sm xl:grid-cols-[minmax(0,1.35fr)_minmax(20rem,0.65fr)]">
      <div className="grid min-w-0 gap-4 p-4 xl:border-r xl:bg-muted/10">
        <div
          className={cn(
            "grid min-w-0 gap-2 border border-l-4 bg-muted/20 p-3",
            trace.status === "failed"
              ? "border-l-destructive bg-destructive/5"
              : "border-l-primary bg-primary/5"
          )}
        >
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground uppercase">Debug focus</span>
            <StatusBadge status={trace.status} />
            <Badge variant="outline">{humanize(trace.mode)}</Badge>
          </div>
          <div className="min-w-0">
            <h2 className="min-w-0 break-words text-lg font-semibold">{focusTitle}</h2>
            <div className="mt-1 max-w-4xl break-words text-sm leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
              {focusDetail}
            </div>
          </div>
        </div>
        <TraceTriageQueue
          items={viewModel.summary.triageItems}
          onSelectSpan={onSelectSpan}
        />
        <CaptureHealth viewModel={viewModel} />
        <div className="flex min-w-0 flex-wrap gap-2">
          <Button
            variant={failing ? "default" : "outline"}
            size="sm"
            disabled={!failing}
            onClick={() => failing && onSelectSpan(failing.id, { filter: "attention", clearQuery: true })}
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
          <CopyDebugReportButton
            trace={trace}
            viewModel={viewModel}
            selectedSpan={selectedSpan}
          />
        </div>
      </div>
      <div className="grid min-w-0 gap-3 border-t bg-muted/10 p-4 sm:grid-cols-2 xl:border-t-0 xl:bg-background">
        <OverviewMetric
          label="Duration"
          value={formatDuration(trace.durationMs) ?? "-"}
          detail={
            slowest
              ? `Slowest: ${slowest.title} (${formatDuration(slowest.durationMs) ?? "-"})`
              : "No step timing"
          }
        />
        <OverviewMetric label="Tokens / cost" value={usageSummary(trace.usage)} detail="Provider-reported totals" />
        <OverviewMetric
          label="Model"
          value={trace.provider}
          detail={trace.model}
          monoDetail
        />
        <OverviewMetric
          label="Trace shape"
          value={`${viewModel.spans.length} span${viewModel.spans.length === 1 ? "" : "s"}`}
          detail={`${viewModel.summary.toolCalls} tool · ${viewModel.summary.messageCount} message`}
        />
      </div>
      <div className="grid min-w-0 gap-3 border-t bg-muted/10 p-4 xl:col-span-2">
        <div className="flex min-w-0 flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <div className="mb-1 text-xs font-medium text-muted-foreground uppercase">Run context</div>
            <TraceContext trace={trace} />
          </div>
          <TraceShapePills viewModel={viewModel} />
        </div>
        <OriginActions trace={trace} />
        <div className="grid min-w-0 gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <SmallField label="Started" value={formatDate(trace.startedAt) ?? "-"} />
          <SmallField label="Finished" value={formatDate(trace.finishedAt) ?? "-"} />
          <SmallField label="Turn" value={trace.turn !== null ? String(trace.turn) : "-"} />
          <SmallField label="Call index" value={trace.callIndex !== null ? `#${trace.callIndex}` : "-"} />
          <SmallField label="Run" value={<CodeValue value={trace.runId} short />} />
          <SmallField label="Thread" value={<CodeValue value={trace.threadId} short />} />
          <SmallField label="Expires" value={formatDate(trace.expiresAt) ?? "-"} />
          <SmallField label="Prompt cache" value={<RedactedValue value={trace.promptCacheKey} />} />
        </div>
      </div>
    </section>
  )
}

function ModelOutcomePanel({
  onSelectSpan,
  viewModel,
}: {
  onSelectSpan: (spanId: string, options?: { filter?: SpanFilter; clearQuery?: boolean }) => void
  viewModel: ModelCallTraceViewModel
}) {
  const modelOutputs = viewModel.spans.filter(
    (span) => span.kind === "response" || span.source === "Requested by model response"
  )
  const recentTools = viewModel.spans
    .filter((span) => span.kind === "tool" && span.source !== "Requested by model response")
    .slice(-5)
  const primaryOutput = modelOutputs[0] ?? null

  return (
    <section className="grid min-w-0 border bg-background lg:grid-cols-[minmax(0,1.25fr)_minmax(20rem,0.75fr)]">
      <div className="grid min-w-0 gap-3 p-4 lg:border-r">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <div>
            <div className="text-xs font-medium text-muted-foreground uppercase">What the model did</div>
            <h2 className="text-base font-semibold">Current call outcome</h2>
          </div>
          {primaryOutput ? <SpanStatusBadge status={primaryOutput.status} /> : null}
        </div>
        {primaryOutput ? (
          <button
            type="button"
            onClick={() => onSelectSpan(primaryOutput.id, { filter: "actions", clearQuery: true })}
            className="grid min-w-0 gap-2 border border-l-4 border-l-primary bg-primary/5 p-3 text-left transition-colors hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Badge variant="secondary">{kindLabel(primaryOutput.kind)}</Badge>
              <span className="min-w-0 break-words text-sm font-medium">{primaryOutput.title}</span>
            </div>
            {primaryOutput.preview ? <ReadablePreview value={primaryOutput.preview} /> : null}
            {primaryOutput.tool ? <ToolPairPreview span={primaryOutput} /> : null}
          </button>
        ) : (
          <div className="border bg-muted/20 p-3 text-sm text-muted-foreground">
            No assistant text or tool request was captured in the model response.
          </div>
        )}
      </div>
      <div className="grid min-w-0 content-start gap-3 border-t bg-muted/10 p-4 lg:border-t-0">
        <div>
          <div className="text-xs font-medium text-muted-foreground uppercase">Recent tool path</div>
          <div className="text-sm text-muted-foreground">Last actions projected into this call</div>
        </div>
        {recentTools.length > 0 ? (
          <div className="grid min-w-0 gap-1">
            {recentTools.map((span) => (
              <button
                key={span.id}
                type="button"
                onClick={() => onSelectSpan(span.id, { filter: "actions", clearQuery: true })}
                className="flex min-w-0 items-center gap-2 border bg-background/70 px-2.5 py-2 text-left text-xs transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <Badge variant="outline" className="shrink-0 tabular-nums">#{span.order}</Badge>
                <SpanStatusBadge status={span.status} />
                <span className="min-w-0 flex-1 truncate font-medium">{span.title}</span>
                {span.durationMs !== null ? (
                  <span className="shrink-0 text-muted-foreground">{formatDuration(span.durationMs)}</span>
                ) : null}
              </button>
            ))}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">No prior tool actions in the projected context.</div>
        )}
      </div>
    </section>
  )
}

function CacheUsageOverview({ usage }: { usage: unknown }) {
  const breakdown = usageBreakdown(usage)
  if (!breakdown.hasUsage) {
    return (
      <div className="grid min-w-0 gap-1 border bg-muted/20 p-3">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground uppercase">
          <DatabaseZap className="size-4" /> Prompt cache
        </div>
        <div className="text-base font-semibold">No usage captured</div>
      </div>
    )
  }
  const percent = breakdown.cacheReadRate * 100
  return (
    <div className="grid min-w-0 gap-2 border border-primary/30 bg-primary/5 p-3">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground uppercase">
          <DatabaseZap className="size-4" /> Prompt cache
        </div>
        <Badge variant={breakdown.cacheRead > 0 ? "default" : "outline"}>
          {breakdown.cacheRead > 0 ? "Cache hit" : "No cache read"}
        </Badge>
      </div>
      <div className="flex min-w-0 flex-wrap items-end justify-between gap-2">
        <div>
          <div className="text-2xl font-semibold tabular-nums">{percent.toFixed(percent >= 10 ? 0 : 1)}%</div>
          <div className="text-xs text-muted-foreground">of prompt tokens served from cache</div>
        </div>
        <div className="text-right text-xs text-muted-foreground">
          <div><span className="font-medium text-foreground">{formatNumberCompact(breakdown.cacheRead)}</span> cached</div>
          <div>{formatNumberCompact(breakdown.promptTokens)} prompt tokens</div>
        </div>
      </div>
      <div className="h-2 overflow-hidden bg-muted" aria-label={`${percent.toFixed(1)}% cache coverage`}>
        <div className="h-full bg-primary" style={{ width: `${Math.min(100, percent)}%` }} />
      </div>
      <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>{formatNumberCompact(breakdown.input)} fresh input</span>
        <span>{formatNumberCompact(breakdown.cacheWrite)} cache write</span>
        <span>{formatUsdValue(breakdown.cacheReadCost)} cache-read cost</span>
      </div>
    </div>
  )
}

function TraceTriageQueue({
  items,
  onSelectSpan,
}: {
  items: readonly TraceTriageItem[]
  onSelectSpan: (spanId: string, options?: { filter?: SpanFilter; clearQuery?: boolean }) => void
}) {
  if (items.length === 0) {
    return (
      <div className="grid min-w-0 gap-2 border bg-background/70 p-3">
        <div className="text-xs font-medium text-muted-foreground uppercase">Triage queue</div>
        <div className="text-xs text-muted-foreground">No ranked suspects in this trace.</div>
      </div>
    )
  }

  return (
    <div className="grid min-w-0 gap-2">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="text-xs font-medium text-muted-foreground uppercase">Triage queue</div>
        <div className="text-xs text-muted-foreground">
          {items.length} suspect{items.length === 1 ? "" : "s"}
        </div>
      </div>
      <div className="grid min-w-0 gap-2 md:grid-cols-2">
        {items.map((item, index) => (
          <button
            key={`${item.spanId}:${item.label}`}
            type="button"
            onClick={() => onSelectSpan(item.spanId, {
              clearQuery: true,
              filter: item.severity === "info" ? "all" : "attention",
            })}
            className={cn(
              "grid min-w-0 gap-2 border border-l-4 p-3 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
              triageCardClassName(item.severity)
            )}
          >
            <div className="flex min-w-0 items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <Badge variant={triageBadgeVariant(item.severity)} className="tabular-nums">
                  #{index + 1}
                </Badge>
                <span className="min-w-0 truncate text-sm font-medium">{item.label}</span>
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">span {item.spanOrder}</span>
            </div>
            <div className="line-clamp-2 min-w-0 break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">
              {item.detail}
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

function triageBadgeVariant(severity: TraceTriageItem["severity"]): React.ComponentProps<typeof Badge>["variant"] {
  if (severity === "critical") return "destructive"
  if (severity === "warning") return "secondary"
  return "outline"
}

function triageCardClassName(severity: TraceTriageItem["severity"]) {
  if (severity === "critical") {
    return "border-l-destructive bg-destructive/5 hover:bg-destructive/10"
  }
  if (severity === "warning") {
    return "border-l-primary/60 bg-muted/30 hover:bg-muted/50"
  }
  return "border-l-border bg-background/70 hover:bg-muted/40"
}

function OriginActions({ trace }: { trace: ModelCallTraceDetail }) {
  const runtimePath = trace.agentKey && trace.sessionId
    ? sessionTabPath(trace.agentKey, trace.sessionId, "runtime")
    : null
  const listPath = modelCallsListPath(trace)
  const listLabel = trace.runId ? "Same run calls" : trace.sessionId ? "Session calls" : "All calls"

  return (
    <div className="flex min-w-0 flex-wrap gap-2">
      {runtimePath ? (
        <Button variant="outline" size="sm" asChild>
          <Link to={runtimePath}>
            <Activity className="size-4" />
            Session runtime
          </Link>
        </Button>
      ) : (
        <Button variant="outline" size="sm" disabled title="No session origin was captured">
          <Activity className="size-4" />
          Session runtime
        </Button>
      )}
      <Button variant="outline" size="sm" asChild>
        <Link to={listPath}>
          <Filter className="size-4" />
          {listLabel}
        </Link>
      </Button>
      <CopyOriginButton trace={trace} />
    </div>
  )
}

function CopyOriginButton({ trace }: { trace: ModelCallTraceDetail }) {
  async function copyOrigin() {
    try {
      await writeClipboardText(buildOriginSummary(trace))
      toast.success("Origin copied")
    } catch {
      toast.error("Could not copy origin")
    }
  }

  return (
    <Button variant="outline" size="sm" onClick={() => void copyOrigin()}>
      <Copy className="size-4" />
      Copy origin
    </Button>
  )
}

function buildOriginSummary(trace: ModelCallTraceDetail) {
  return [
    "Panda model-call origin",
    `trace: ${trace.id}`,
    `agent: ${trace.agentKey ?? "-"}`,
    `session: ${trace.sessionId ?? "-"}`,
    `thread: ${trace.threadId ?? "-"}`,
    `run: ${trace.runId ?? "-"}`,
    `turn: ${trace.turn ?? "-"}`,
    `call index: ${trace.callIndex ?? "-"}`,
    `started: ${formatDate(trace.startedAt) ?? "-"}`,
    `status: ${trace.status}`,
  ].join("\n")
}

function TraceShapePills({ viewModel }: { viewModel: ModelCallTraceViewModel }) {
  const contextSpans = viewModel.spans.filter(
    (span) => span.kind === "context" || span.kind === "metadata"
  ).length
  const pills = [
    {label: "Context", value: String(contextSpans)},
    {label: "Messages", value: String(viewModel.summary.messageCount)},
    {label: "Tools", value: String(viewModel.summary.toolCalls)},
    viewModel.summary.toolErrors > 0
      ? {label: "Tool errors", value: String(viewModel.summary.toolErrors), destructive: true}
      : null,
    {label: "Raw", value: formatBytes(viewModel.summary.rawPayloadBytes) ?? "-"},
  ].filter((pill): pill is {destructive?: boolean; label: string; value: string} => Boolean(pill))

  return (
    <div className="flex min-w-0 flex-wrap gap-1 pt-1">
      {pills.map((pill) => (
        <Badge
          key={`${pill.label}:${pill.value}`}
          variant={pill.destructive ? "destructive" : "outline"}
          className="max-w-full min-w-0"
        >
          <span
            className={cn(
              "shrink-0",
              pill.destructive ? "text-destructive/75" : "text-muted-foreground"
            )}
          >
            {pill.label}
          </span>
          <span className="min-w-0 truncate tabular-nums">{pill.value}</span>
        </Badge>
      ))}
    </div>
  )
}

function CaptureHealth({ viewModel }: { viewModel: ModelCallTraceViewModel }) {
  const findings = traceDebugFindings(viewModel)
  if (findings.length === 0) {
    return (
      <div className="grid min-w-0 gap-1 border bg-background/70 p-3">
        <div className="text-xs font-medium text-muted-foreground uppercase">Capture health</div>
        <div className="text-xs text-muted-foreground">Capture complete.</div>
      </div>
    )
  }

  return (
    <div className="grid min-w-0 gap-2 border bg-background/70 p-3">
      <div className="text-xs font-medium text-muted-foreground uppercase">Capture health</div>
      <div className="flex min-w-0 flex-wrap gap-1 text-xs">
        {findings.map((finding) => (
          <Badge
            key={finding.label}
            variant={finding.destructive ? "destructive" : "secondary"}
            className="max-w-full min-w-0"
            title={finding.detail}
          >
            <span className="truncate">{finding.label}</span>
          </Badge>
        ))}
      </div>
    </div>
  )
}

function TimelineToolbar({
  filter,
  filterCounts,
  filteredCount,
  query,
  spans,
  viewModel,
  onFilterChange,
  onQueryChange,
  onSelectSpan,
}: {
  filter: SpanFilter
  filterCounts: Record<SpanFilter, number>
  filteredCount: number
  query: string
  spans: TraceSpan[]
  viewModel: ModelCallTraceViewModel
  onFilterChange: (filter: SpanFilter) => void
  onQueryChange: (query: string) => void
  onSelectSpan: (spanId: string, options?: { filter?: SpanFilter; clearQuery?: boolean }) => void
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
                <span className="tabular-nums text-muted-foreground">{filterCounts[item.value]}</span>
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
            onClick={() => viewModel.summary.failingSpan && onSelectSpan(
              viewModel.summary.failingSpan.id,
              { filter: "attention", clearQuery: true }
            )}
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

function CopyTraceIdButton({ traceId }: { traceId: string }) {
  async function copyTraceId() {
    try {
      await writeClipboardText(traceId)
      toast.success("Trace id copied")
    } catch {
      toast.error("Could not copy trace id")
    }
  }

  return (
    <Button variant="outline" size="sm" onClick={() => void copyTraceId()}>
      <Copy className="size-4" />
      Copy ID
    </Button>
  )
}

function CopySpanLinkButton({
  path,
  spanId,
}: {
  path: string | null
  spanId: string
}) {
  async function copySpanLink() {
    if (!path) return
    try {
      await writeClipboardText(new URL(path, window.location.origin).toString())
      toast.success("Span link copied")
    } catch {
      toast.error("Could not copy span link")
    }
  }

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={!path}
      onClick={() => void copySpanLink()}
      title={`Copy link to ${spanId}`}
    >
      <Copy className="size-4" />
      Copy link
    </Button>
  )
}

function CopyDebugReportButton({
  selectedSpan,
  trace,
  viewModel,
}: {
  selectedSpan: TraceSpan | null
  trace: ModelCallTraceDetail
  viewModel: ModelCallTraceViewModel
}) {
  async function copyReport() {
    try {
      await writeClipboardText(buildDebugReport(trace, viewModel, selectedSpan))
      toast.success("Debug report copied")
    } catch {
      toast.error("Could not copy debug report")
    }
  }

  return (
    <Button variant="outline" size="sm" onClick={() => void copyReport()}>
      <Copy className="size-4" />
      Copy report
    </Button>
  )
}

function InputShapeView({
  trace,
  viewModel,
}: {
  trace: ModelCallTraceDetail
  viewModel: ModelCallTraceViewModel
}) {
  const shape = traceInputShape(trace)

  return (
    <div className="grid min-w-0 gap-4">
      <DetailPanel
        title="Input shape"
        action={<Badge variant="outline">{formatBytes(viewModel.summary.rawPayloadBytes) ?? "-"}</Badge>}
      >
        <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <OverviewMetric
            label="Context"
            value={`${shape.contextSections.length} section${shape.contextSections.length === 1 ? "" : "s"}`}
            detail={shape.hasSystemPrompt ? "System prompt captured" : "No system prompt"}
          />
          <OverviewMetric
            label="Messages"
            value={String(shape.messages.length)}
            detail="Projected request messages"
          />
          <OverviewMetric
            label="Tools"
            value={String(shape.tools.length)}
            detail="Schemas exposed to model"
          />
          <OverviewMetric
            label="Raw request"
            value={formatBytes(sanitizedPayloadSize(trace.request)) ?? "-"}
            detail="Sanitized payload size"
          />
        </div>
      </DetailPanel>
      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(21rem,0.75fr)]">
        <section className="grid min-w-0 gap-3" aria-label="Context input shape">
          <SectionHeader title="Context sections" detail={`${shape.contextSections.length} captured`} />
          {shape.systemPrompt !== undefined ? (
            <PayloadSection title="System prompt" value={shape.systemPrompt} />
          ) : null}
          {shape.contextSections.length > 0 ? (
            shape.contextSections.map((section, index) => (
              <PayloadSection
                key={`context-shape-${index}`}
                title={sectionTitle(section, index)}
                value={contextSectionPayload(section)}
              />
            ))
          ) : shape.contextDump !== undefined ? (
            <PayloadSection title="LLM context dump" value={shape.contextDump} />
          ) : (
            <EmptyShapeBlock label="No context sections captured." />
          )}
          <PayloadSection title="Projected messages" value={shape.messages} json />
        </section>
        <section className="grid min-w-0 gap-3" aria-label="Tool schema input shape">
          <SectionHeader title="Tool schemas" detail={`${shape.tools.length} exposed`} />
          {shape.tools.length > 0 ? (
            shape.tools.map((tool, index) => (
              <PayloadSection
                key={`tool-shape-${index}`}
                title={toolSchemaTitle(tool, index)}
                value={toolSchemaPayload(tool)}
                json
              />
            ))
          ) : (
            <EmptyShapeBlock label="No tool schemas exposed to this call." />
          )}
        </section>
      </div>
    </div>
  )
}

function TraceDiffPanel({
  compareTrace,
  compareViewModel,
  comparing,
  navigation,
  searchParams,
  trace,
  viewModel,
}: {
  compareTrace?: ModelCallTraceDetail | null
  compareViewModel: ModelCallTraceViewModel | null
  comparing: boolean
  navigation: TraceNavigation
  searchParams: URLSearchParams
  trace: ModelCallTraceDetail
  viewModel: ModelCallTraceViewModel
}) {
  const comparePath = navigation.previous
    ? traceDetailPathWithSearch(trace.id, searchParams, {
        compare: navigation.previous.id,
        span: null,
        view: "diff",
      })
    : null

  if (comparing && !compareTrace) {
    return (
      <DetailPanel title="Call diff">
        <div className="text-sm text-muted-foreground">Loading compared call…</div>
      </DetailPanel>
    )
  }

  if (!compareTrace || !compareViewModel) {
    return (
      <DetailPanel
        title="Call diff"
        action={comparePath ? (
          <Button variant="outline" size="sm" asChild>
            <Link to={comparePath}>
              <GitCompareArrows className="size-4" />
              Diff previous
            </Link>
          </Button>
        ) : null}
      >
        <div className="text-sm text-muted-foreground">
          No comparison call selected.
        </div>
      </DetailPanel>
    )
  }

  const rows = traceDiffRows(trace, viewModel, compareTrace, compareViewModel)
  const highlights = traceDiffHighlights(trace, viewModel, compareTrace, compareViewModel)

  return (
    <DetailPanel
      title="Call diff"
      action={
        <Button variant="outline" size="sm" asChild>
          <Link to={modelCallDetailPath(compareTrace.id)}>
            <GitCompareArrows className="size-4" />
            Open compared
          </Link>
        </Button>
      }
    >
      <div className="grid min-w-0 gap-3">
        <DiffHighlights highlights={highlights} />
        <div className="grid min-w-0 gap-2 sm:grid-cols-2">
          <CompareTraceCard label="Current" trace={trace} viewModel={viewModel} />
          <CompareTraceCard label="Compared" trace={compareTrace} viewModel={compareViewModel} />
        </div>
        <div className="grid min-w-0 gap-2">
          {rows.map((row) => (
            <DiffRow key={row.label} row={row} />
          ))}
        </div>
      </div>
    </DetailPanel>
  )
}

function SectionHeader({ detail, title }: { detail: string; title: string }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3">
      <h2 className="text-sm font-semibold">{title}</h2>
      <span className="text-xs text-muted-foreground">{detail}</span>
    </div>
  )
}

function EmptyShapeBlock({ label }: { label: string }) {
  return (
    <div className="border bg-muted/20 p-4 text-sm text-muted-foreground">
      {label}
    </div>
  )
}

type DiffHighlight = {
  detail: string
  label: string
  value: string
  variant?: "changed" | "destructive"
}

function DiffHighlights({ highlights }: { highlights: DiffHighlight[] }) {
  return (
    <div className="grid min-w-0 gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {highlights.map((highlight) => (
        <div key={highlight.label} className="grid min-w-0 gap-1 border bg-muted/20 p-3">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <span className="text-xs font-medium text-muted-foreground uppercase">{highlight.label}</span>
            {highlight.variant ? (
              <Badge variant={highlight.variant === "destructive" ? "destructive" : "secondary"}>
                Changed
              </Badge>
            ) : null}
          </div>
          <div
            className={cn(
              "min-w-0 break-words text-sm font-semibold [overflow-wrap:anywhere]",
              highlight.variant === "destructive" ? "text-destructive" : null
            )}
          >
            {highlight.value}
          </div>
          <div className="min-w-0 break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">
            {highlight.detail}
          </div>
        </div>
      ))}
    </div>
  )
}

function CompareTraceCard({
  label,
  trace,
  viewModel,
}: {
  label: string
  trace: ModelCallTraceDetail
  viewModel: ModelCallTraceViewModel
}) {
  const attention = viewModel.spans.filter(spanNeedsAttention).length
  return (
    <div className="grid min-w-0 gap-2 border bg-muted/20 p-3">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground uppercase">{label}</span>
        <StatusBadge status={trace.status} />
      </div>
      <div className="min-w-0 break-words text-sm font-semibold">
        {trace.provider}/{trace.model}
      </div>
      <div className="grid min-w-0 gap-1 text-xs text-muted-foreground">
        <span>{formatDate(trace.startedAt) ?? "No start"} · {formatDuration(trace.durationMs) ?? "-"}</span>
        <span>{usageSummary(trace.usage)}</span>
        <span>{viewModel.spans.length} spans · {attention} attention</span>
        <code className="break-all">{trace.id}</code>
      </div>
    </div>
  )
}

function traceDiffHighlights(
  trace: ModelCallTraceDetail,
  viewModel: ModelCallTraceViewModel,
  compareTrace: ModelCallTraceDetail,
  compareViewModel: ModelCallTraceViewModel
): DiffHighlight[] {
  const shape = traceInputShape(trace)
  const compareShape = traceInputShape(compareTrace)
  const currentAttention = attentionCount(viewModel)
  const previousAttention = attentionCount(compareViewModel)
  const currentTokens = tokenTotalForDiff(trace.usage)
  const previousTokens = tokenTotalForDiff(compareTrace.usage)
  const promptChanged = stableComparisonValue([
    shape.systemPrompt,
    shape.contextDump,
    shape.contextSections,
  ]) !== stableComparisonValue([
    compareShape.systemPrompt,
    compareShape.contextDump,
    compareShape.contextSections,
  ])
  const messagesChanged = stableComparisonValue(shape.messages) !== stableComparisonValue(compareShape.messages)
  const toolsChanged = stableComparisonValue(shape.tools) !== stableComparisonValue(compareShape.tools)
  const toolErrorDelta = viewModel.summary.toolErrors - compareViewModel.summary.toolErrors

  return [
    {
      label: "Outcome",
      value: humanize(trace.status),
      detail: trace.status === compareTrace.status
        ? "Same status as compared call"
        : `Was ${humanize(compareTrace.status)}`,
      variant: trace.status === "failed" ? "destructive" : trace.status !== compareTrace.status ? "changed" : undefined,
    },
    {
      label: "Prompt / Context",
      value: promptChanged ? "Changed" : "Same",
      detail: `${shape.contextSections.length} sections now · ${compareShape.contextSections.length} before`,
      variant: promptChanged ? "changed" : undefined,
    },
    {
      label: "Messages",
      value: signedDelta(shape.messages.length, compareShape.messages.length),
      detail: messagesChanged ? "Projected message payload changed" : "Projected messages are unchanged",
      variant: messagesChanged ? "changed" : undefined,
    },
    {
      label: "Tools",
      value: `${signedDelta(viewModel.summary.toolCalls, compareViewModel.summary.toolCalls)} calls`,
      detail: `${viewModel.summary.toolErrors} errors now · ${compareViewModel.summary.toolErrors} before${toolsChanged ? " · schemas changed" : ""}`,
      variant: toolErrorDelta > 0 ? "destructive" : toolsChanged || toolErrorDelta !== 0 ? "changed" : undefined,
    },
    {
      label: "Tokens",
      value: tokenDeltaLabel(currentTokens, previousTokens),
      detail: `Current ${formatOptionalNumber(currentTokens)} · compared ${formatOptionalNumber(previousTokens)}`,
      variant: currentTokens !== null && previousTokens !== null && currentTokens !== previousTokens ? "changed" : undefined,
    },
    {
      label: "Attention",
      value: signedDelta(currentAttention, previousAttention),
      detail: `${currentAttention} spans now · ${previousAttention} before`,
      variant: currentAttention > previousAttention ? "destructive" : currentAttention !== previousAttention ? "changed" : undefined,
    },
  ]
}

type DiffRowModel = {
  current: string
  label: string
  previous: string
}

function DiffRow({ row }: { row: DiffRowModel }) {
  const changed = row.current !== row.previous
  return (
    <div className="grid min-w-0 gap-2 border p-3 sm:grid-cols-[10rem_minmax(0,1fr)_minmax(0,1fr)]">
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground uppercase">{row.label}</span>
        {changed ? <Badge variant="secondary">Changed</Badge> : null}
      </div>
      <div className="min-w-0 break-words text-xs">
        <span className="text-muted-foreground">Current </span>
        <span>{row.current}</span>
      </div>
      <div className="min-w-0 break-words text-xs">
        <span className="text-muted-foreground">Compared </span>
        <span>{row.previous}</span>
      </div>
    </div>
  )
}

function traceDiffRows(
  trace: ModelCallTraceDetail,
  viewModel: ModelCallTraceViewModel,
  compareTrace: ModelCallTraceDetail,
  compareViewModel: ModelCallTraceViewModel
): DiffRowModel[] {
  return [
    {
      label: "Status",
      current: trace.status,
      previous: compareTrace.status,
    },
    {
      label: "Duration",
      current: formatDuration(trace.durationMs) ?? "-",
      previous: formatDuration(compareTrace.durationMs) ?? "-",
    },
    {
      label: "Usage",
      current: usageSummary(trace.usage),
      previous: usageSummary(compareTrace.usage),
    },
    {
      label: "Spans",
      current: String(viewModel.spans.length),
      previous: String(compareViewModel.spans.length),
    },
    {
      label: "Tools",
      current: `${viewModel.summary.toolCalls} calls · ${viewModel.summary.toolErrors} errors`,
      previous: `${compareViewModel.summary.toolCalls} calls · ${compareViewModel.summary.toolErrors} errors`,
    },
    {
      label: "Attention",
      current: attentionSummary(viewModel),
      previous: attentionSummary(compareViewModel),
    },
    {
      label: "Error",
      current: sanitizeDisplayString(traceErrorSummary(trace.error) ?? "-"),
      previous: sanitizeDisplayString(traceErrorSummary(compareTrace.error) ?? "-"),
    },
    {
      label: "Request",
      current: formatBytes(sanitizedPayloadSize(trace.request)) ?? "-",
      previous: formatBytes(sanitizedPayloadSize(compareTrace.request)) ?? "-",
    },
  ]
}

function attentionSummary(viewModel: ModelCallTraceViewModel) {
  const attention = attentionCount(viewModel)
  return [
    `${attention} spans`,
    viewModel.summary.pendingToolCalls > 0 ? `${viewModel.summary.pendingToolCalls} missing` : null,
    viewModel.summary.unmatchedToolResults > 0 ? `${viewModel.summary.unmatchedToolResults} unmatched` : null,
    viewModel.summary.truncatedSpans > 0 ? `${viewModel.summary.truncatedSpans} truncated` : null,
    viewModel.summary.redactedSpans > 0 ? `${viewModel.summary.redactedSpans} redacted` : null,
  ].filter(Boolean).join(" · ")
}

function attentionCount(viewModel: ModelCallTraceViewModel) {
  return viewModel.spans.filter(spanNeedsAttention).length
}

function stableComparisonValue(value: unknown) {
  return formatSanitizedJson(value)
}

function tokenTotalForDiff(value: unknown) {
  const counts = usageTokenCounts(value)
  if (counts.total !== null) return counts.total
  if (counts.input !== null && counts.output !== null) return counts.input + counts.output
  return counts.input ?? counts.output
}

function tokenDeltaLabel(current: number | null, previous: number | null) {
  if (current === null || previous === null) return "-"
  return signedDelta(current, previous)
}

function signedDelta(current: number, previous: number) {
  const delta = current - previous
  if (delta === 0) return "same"
  const prefix = delta > 0 ? "+" : ""
  return `${prefix}${formatNumberCompact(delta)}`
}

function formatOptionalNumber(value: number | null) {
  return value === null ? "-" : formatNumberCompact(value)
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
  const visibleMetrics = span.tool?.name.toLowerCase() === "bash"
    ? []
    : span.metrics.filter((metric) => metric.label !== "Duration" && metric.label !== "Args").slice(0, 1)

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
          {span.subtitle && !span.tool ? (
            <div className="mt-1 min-w-0 break-words text-xs text-muted-foreground">
              {span.subtitle}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          {span.durationMs !== null ? <Badge variant="outline">{formatDuration(span.durationMs)}</Badge> : null}
          {visibleMetrics.map((metric) => (
            <Badge key={`${metric.label}:${metric.value}`} variant="outline">
              {metric.label} {metric.value}
            </Badge>
          ))}
        </div>
      </div>
      {span.preview && !span.tool ? <ReadablePreview value={span.preview} /> : null}
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
  const bash = bashExecutionDetailsForSpan(span)
  if (bash.looksLikeBash) return <BashToolPreview details={bash} span={span} />

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

function BashToolPreview({
  details,
  span,
}: {
  details: ReturnType<typeof extractBashExecutionDetails>
  span: TraceSpan
}) {
  const failed = span.status === "failed"
  const pending = span.status === "pending"
  const outputs = failed
    ? [["stderr", details.stderr], ["stdout", details.stdout]] as const
    : [["stdout", details.stdout], ["stderr", details.stderr]] as const
  const visibleOutputs = outputs.filter((entry): entry is readonly ["stderr" | "stdout", string] => Boolean(entry[1]))

  return (
    <div className={cn(
      "grid min-w-0 gap-2 border-l-4 p-3",
      failed ? "border-l-destructive bg-destructive/5" : pending ? "border-l-muted-foreground bg-muted/20" : "border-l-primary bg-primary/5"
    )}>
      {failed || pending ? (
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-xs font-medium text-muted-foreground uppercase">Shell execution</div>
            <div className={cn("mt-0.5 break-words text-sm font-semibold", failed && "text-destructive")}>
              {sanitizeDisplayString(bashExecutionHeadline(details))}
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-1">
            {failed && details.exitCode !== null ? (
              <Badge variant="destructive">exit {String(details.exitCode)}</Badge>
            ) : null}
            {details.timedOut ? <Badge variant="destructive">Interrupted</Badge> : null}
          </div>
        </div>
      ) : null}

      {details.command ? (
        <div className="grid min-w-0 max-w-[110ch] gap-0.5">
          <span className="text-xs text-muted-foreground">Command</span>
          <code className="max-h-24 overflow-auto whitespace-pre-wrap break-words border bg-background/70 px-2.5 py-1.5 text-xs leading-relaxed [overflow-wrap:anywhere]">
            {sanitizeDisplayString(details.command)}
          </code>
        </div>
      ) : null}

      {visibleOutputs.length > 0 ? (
        <div className="grid min-w-0 gap-2 xl:grid-cols-2">
          {visibleOutputs.map(([label, value]) => (
            <BashOutputPreview
              key={label}
              failed={failed}
              label={label}
              truncated={label === "stderr" ? details.stderrTruncated : details.stdoutTruncated}
              value={value}
            />
          ))}
        </div>
      ) : (
        <div className="text-xs text-muted-foreground">
          {pending ? "No paired result is present in this trace." : "Command produced no stdout or stderr."}
        </div>
      )}

      {details.cwd && failed ? (
        <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
          <span className="shrink-0">cwd</span>
          <code className="min-w-0 truncate text-foreground/80">{sanitizeDisplayString(details.cwd)}</code>
        </div>
      ) : null}
    </div>
  )
}

function BashOutputPreview({
  failed,
  label,
  truncated,
  value,
}: {
  failed: boolean
  label: "stderr" | "stdout"
  truncated: boolean
  value: string
}) {
  return (
    <div className="grid min-w-0 gap-1 border bg-background/70 p-2.5">
      <div className="flex min-w-0 items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{label}</span>
        {truncated ? <Badge variant="secondary">Output truncated</Badge> : null}
      </div>
      <pre className={cn(
        "max-w-[110ch] overflow-hidden whitespace-pre-wrap break-words font-mono text-xs leading-relaxed [overflow-wrap:anywhere]",
        failed ? "max-h-32" : "max-h-12"
      )}>
        {sanitizeDisplayString(value)}
      </pre>
    </div>
  )
}

function SpanInspectorSheet({
  onClose,
  span,
  spanPath,
}: {
  onClose: () => void
  span: TraceSpan | null
  spanPath: string | null
}) {
  return (
    <Sheet open={Boolean(span)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="min-w-0 gap-0 overflow-x-hidden data-[side=right]:w-full data-[side=right]:sm:max-w-4xl data-[side=right]:xl:max-w-5xl">
        <SheetHeader className="shrink-0 border-b pr-12">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <SheetTitle>Inspector</SheetTitle>
            {span ? <SpanStatusBadge status={span.status} /> : null}
          </div>
          <SheetDescription>
            {span
              ? `#${span.order} ${kindLabel(span.kind)} - ${span.title}${span.subtitle ? ` · ${span.subtitle}` : ""}`
              : "Selected timeline span"}
          </SheetDescription>
          {span ? (
            <div className="flex flex-wrap items-center gap-2 pt-2">
              <CopySpanLinkButton path={spanPath} spanId={span.id} />
              <CopySanitizedJsonButton label="Copy span JSON" toastLabel="Span JSON copied" value={span.raw} />
            </div>
          ) : null}
        </SheetHeader>
        {span ? (
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <div className="grid min-w-0 gap-4">
              <div className="grid gap-2 sm:grid-cols-2">
                <DetailField label="Span id" value={<CodeValue value={span.id} />} />
                {span.kind !== "context" ? (
                  <DetailField label="Raw payload" value={formatBytes(sanitizedPayloadSize(span.raw)) ?? "-"} />
                ) : null}
                {span.metrics.map((metric) => (
                  <DetailField key={`${metric.label}:${metric.value}`} label={metric.label} value={metric.value} />
                ))}
                {span.tool?.callId ? (
                  <DetailField label="Tool call id" value={<CodeValue value={span.tool.callId} />} />
                ) : null}
                {span.role ? <DetailField label="Role" value={humanize(span.role)} /> : null}
                {span.source ? <DetailField label="Source" value={span.source} /> : null}
              </div>
              {span.tool ? (
                <ToolInspectorSections span={span} />
              ) : span.kind === "context" ? (
                <ContextInspectorSection span={span} />
              ) : (
                <PayloadSection title="Payload" value={span.raw} />
              )}
              <details className="grid min-w-0 gap-2">
                <summary className="cursor-pointer select-none text-xs text-muted-foreground">
                  Raw selected span JSON
                </summary>
                <SanitizedJsonBlock value={span.raw} />
              </details>
            </div>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

function ContextInspectorSection({ span }: { span: TraceSpan }) {
  const content = readableContextContent(span)
  return (
    <PayloadSection
      title="Content"
      value={content ?? span.raw}
      emptyLabel="No context content captured."
      json={content === null}
      showSize={false}
    />
  )
}

function ToolInspectorSections({ span }: { span: TraceSpan }) {
  const tool = span.tool
  if (!tool) return null
  const bash = bashExecutionDetailsForSpan(span)
  return (
    <div className="grid min-w-0 gap-3">
      {bash.looksLikeBash ? <BashToolDetails span={span} /> : null}
      <PayloadSection title="Arguments" value={tool.arguments} emptyLabel="No arguments captured." json />
      <PayloadSection
        title={tool.isError ? "Result error" : "Result"}
        value={tool.result}
        emptyLabel="No paired result is present in this trace."
      />
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
  const details = bashExecutionDetailsForSpan(span)

  if (!details.looksLikeBash) return null

  return (
    <section className="grid min-w-0 gap-3 border bg-muted/20 p-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">Bash execution</h3>
        {details.exitCode !== null ? <Badge variant="outline">exit {String(details.exitCode)}</Badge> : null}
        {details.exitCode === null && details.status !== null ? <Badge variant="outline">{String(details.status)}</Badge> : null}
        {details.timedOut ? <Badge variant="destructive">Interrupted</Badge> : null}
      </div>
      <div className="grid min-w-0 gap-2 text-xs">
        {details.command ? (
          <div className="grid min-w-0 gap-1">
            <span className="text-muted-foreground">Command</span>
            <code className="max-h-24 overflow-auto whitespace-pre-wrap break-words border bg-background/60 p-2 [overflow-wrap:anywhere]">
              {sanitizeDisplayString(details.command)}
            </code>
          </div>
        ) : null}
        {details.cwd ? (
          <div className="min-w-0">
            <span className="text-muted-foreground">cwd </span>
            <code className="break-all">{sanitizeDisplayString(details.cwd)}</code>
          </div>
        ) : null}
      </div>
      <div className="grid min-w-0 gap-2 lg:grid-cols-2">
        <OutputPane
          label="stdout"
          value={details.stdout}
          chars={details.stdoutChars}
          truncated={details.stdoutTruncated}
        />
        <OutputPane
          label="stderr"
          value={details.stderr}
          chars={details.stderrChars}
          truncated={details.stderrTruncated}
        />
      </div>
    </section>
  )
}

function bashExecutionDetailsForSpan(span: TraceSpan) {
  const tool = span.tool
  const raw = asRecord(span.raw)
  const call = asRecord(tool?.call) ?? asRecord(raw?.call)
  const result = asRecord(raw?.result)
  const args = asRecord(tool?.arguments) ?? asRecord(call?.arguments)
  return extractBashExecutionDetails({
    call,
    result,
    resultPayload: tool?.result,
    toolArguments: args,
    toolName: tool?.name,
  })
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
  showSize = true,
}: {
  title: string
  value: unknown
  emptyLabel?: string
  json?: boolean
  showSize?: boolean
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
        {showSize ? (
          <Badge variant="outline">{formatBytes(new TextEncoder().encode(formatSanitizedJson(value)).length)}</Badge>
        ) : null}
      </div>
      {json ? <SanitizedJsonBlock value={value} /> : <ReadableFullValue value={value} />}
    </section>
  )
}

function RawTraceDetails({ trace }: { trace: ModelCallTraceDetail }) {
  return (
    <details className="grid min-w-0 gap-2 border p-3">
      <summary className="cursor-pointer select-none text-sm font-medium">
        Sanitized raw trace JSON
      </summary>
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-xs text-muted-foreground">
          Raw trace remains available for fallback debugging, but prompt-cache fields are redacted again in the UI before rendering.
        </div>
        <CopySanitizedJsonButton label="Copy trace JSON" toastLabel="Trace JSON copied" value={trace} />
      </div>
      <SanitizedJsonBlock value={trace} />
    </details>
  )
}

function OverviewMetric({
  detail,
  label,
  monoDetail = false,
  value,
}: {
  detail?: React.ReactNode
  label: string
  monoDetail?: boolean
  value: React.ReactNode
}) {
  return (
    <div className="grid min-w-0 gap-1 border bg-muted/20 p-3">
      <div className="text-xs font-medium text-muted-foreground uppercase">{label}</div>
      <div className="min-w-0 break-words text-base font-semibold">{value}</div>
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
    <div className="min-w-0 border bg-background/70 p-2">
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
      <div className="max-h-[min(60vh,48rem)] max-w-full overflow-auto whitespace-pre-wrap break-words border bg-background/60 p-3 text-sm leading-relaxed [overflow-wrap:anywhere]">
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
      compact ? "max-h-40" : "max-h-[min(60vh,48rem)]",
    )}>
      {formatSanitizedJson(value)}
    </pre>
  )
}

function CopySanitizedJsonButton({
  label,
  toastLabel,
  value,
}: {
  label: string
  toastLabel: string
  value: unknown
}) {
  async function copyJson() {
    try {
      await writeClipboardText(formatSanitizedJson(value))
      toast.success(toastLabel)
    } catch {
      toast.error("Could not copy JSON")
    }
  }

  return (
    <Button variant="outline" size="sm" onClick={() => void copyJson()}>
      <Copy className="size-4" />
      {label}
    </Button>
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

function CodeValue({ value, short: shorten = false }: { value?: string | null; short?: boolean }) {
  if (!value) return "-"
  return (
    <code className="break-all text-xs" title={value}>
      {shorten ? shortModelCallContextValue(value) : value}
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

function parseSpanFilter(value: string | null): SpanFilter {
  return FILTERS.some((filter) => filter.value === value) ? (value as SpanFilter) : "all"
}

function parseTraceView(value: string | null): TraceView {
  return value === "input" || value === "diff" ? value : "timeline"
}

function traceDetailPathWithSearch(
  traceId: string,
  searchParams: URLSearchParams,
  patches: Record<string, string | null>
) {
  const params = new URLSearchParams(searchParams)
  for (const [key, value] of Object.entries(patches)) {
    if (value === null || value === "") {
      params.delete(key)
    } else {
      params.set(key, value)
    }
  }
  const query = params.toString()
  return `${modelCallDetailPath(traceId)}${query ? `?${query}` : ""}`
}

function traceNavigation(
  trace: ModelCallTraceSummary,
  relatedTraces: ModelCallTraceSummary[]
): TraceNavigation {
  const byId = new Map<string, ModelCallTraceSummary>()
  relatedTraces.forEach((item) => byId.set(item.id, item))
  byId.set(trace.id, trace)
  const ordered = [...byId.values()].sort(compareTraceOrder)
  const index = ordered.findIndex((item) => item.id === trace.id)
  return {
    previous: index > 0 ? ordered[index - 1] : null,
    next: index >= 0 && index < ordered.length - 1 ? ordered[index + 1] : null,
  }
}

function compareTraceOrder(a: ModelCallTraceSummary, b: ModelCallTraceSummary) {
  if (a.turn !== null && b.turn !== null && a.turn !== b.turn) return a.turn - b.turn
  if (a.callIndex !== null && b.callIndex !== null && a.callIndex !== b.callIndex) {
    return a.callIndex - b.callIndex
  }
  const aTime = timestampSortValue(a.startedAt)
  const bTime = timestampSortValue(b.startedAt)
  if (aTime !== bTime) return aTime - bTime
  return a.id.localeCompare(b.id)
}

function timestampSortValue(value: string | null | undefined) {
  if (!value) return 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function traceInputShape(trace: ModelCallTraceDetail) {
  const request = asRecord(trace.request) ?? {}
  return {
    contextDump: hasRenderableValue(request.llmContextDump) ? request.llmContextDump : undefined,
    contextSections: Array.isArray(request.llmContextSections) ? request.llmContextSections : [],
    hasSystemPrompt: hasRenderableValue(request.systemPrompt),
    messages: Array.isArray(request.messages) ? request.messages : [],
    systemPrompt: hasRenderableValue(request.systemPrompt) ? request.systemPrompt : undefined,
    tools: Array.isArray(request.tools) ? request.tools : [],
  }
}

function sectionTitle(section: unknown, index: number) {
  const record = asRecord(section)
  return firstDisplayString(record, ["label", "name", "source"]) ?? `Context section ${index + 1}`
}

function contextSectionPayload(section: unknown) {
  const record = asRecord(section)
  if (!record) return section
  return firstExistingValue(record, ["content", "contentPreview", "preview", "dump"]) ?? section
}

function toolSchemaTitle(tool: unknown, index: number) {
  const record = asRecord(tool)
  return firstDisplayString(record, ["name", "toolName", "tool_name"]) ?? `Tool ${index + 1}`
}

function toolSchemaPayload(tool: unknown) {
  const record = asRecord(tool)
  if (!record) return tool
  return firstExistingValue(record, ["inputSchema", "input_schema", "parameters", "schema"]) ?? tool
}

function firstExistingValue(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    if (Object.hasOwn(record, key) && hasRenderableValue(record[key])) return record[key]
  }
  return undefined
}

function firstDisplayString(record: Record<string, unknown> | null, keys: string[]) {
  if (!record) return null
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) return sanitizeDisplayString(value)
    if (typeof value === "number" && Number.isFinite(value)) return String(value)
  }
  return null
}

function hasRenderableValue(value: unknown) {
  if (value === null || value === undefined) return false
  if (typeof value === "string") return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  return true
}

function spanFilterCounts(spans: TraceSpan[]): Record<SpanFilter, number> {
  return {
    actions: spans.filter(spanIsAction).length,
    all: spans.length,
    attention: spans.filter(spanNeedsAttention).length,
    context: spans.filter((span) => span.kind === "context" || span.kind === "metadata").length,
    errors: spans.filter((span) => span.status === "failed").length,
    messages: spans.filter((span) => span.kind === "message" || span.kind === "response").length,
    tools: spans.filter((span) => span.kind === "tool").length,
  }
}

function spanMatches(span: TraceSpan, filter: SpanFilter, query: string) {
  if (filter === "actions" && !spanIsAction(span)) return false
  if (filter === "attention" && !spanNeedsAttention(span)) return false
  if (filter === "tools" && span.kind !== "tool") return false
  if (filter === "errors" && span.status !== "failed") return false
  if (filter === "messages" && span.kind !== "message" && span.kind !== "response") return false
  if (filter === "context" && span.kind !== "context" && span.kind !== "metadata") return false
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return true
  return spanSearchText(span).includes(normalizedQuery)
}

function spanIsAction(span: TraceSpan) {
  return span.kind === "tool" || span.kind === "response" || span.kind === "error"
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

function spanNeedsAttention(span: TraceSpan) {
  return (
    span.status === "failed" ||
    span.status === "pending" ||
    span.source === "Unmatched projected tool result" ||
    span.badges.includes("Truncated") ||
    span.badges.includes("Redacted")
  )
}

function formatNumberCompact(value: number) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value)
}

function formatUsdValue(value: number) {
  const maximumFractionDigits = Math.abs(value) > 0 && Math.abs(value) < 0.01 ? 6 : 2
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits,
  }).format(value)
}

function sanitizedPayloadSize(value: unknown) {
  return new TextEncoder().encode(formatSanitizedJson(value)).length
}

async function writeClipboardText(value: string) {
  if (copyWithTextArea(value)) return
  if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value)
}

function copyWithTextArea(value: string) {
  const textarea = document.createElement("textarea")
  textarea.value = value
  textarea.setAttribute("readonly", "true")
  textarea.style.position = "fixed"
  textarea.style.top = "-1000px"
  textarea.style.left = "-1000px"
  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()
  try {
    return document.execCommand("copy")
  } finally {
    textarea.remove()
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
