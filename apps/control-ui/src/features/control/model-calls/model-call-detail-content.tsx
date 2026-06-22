import type * as React from "react"
import { Link } from "react-router-dom"

import { sessionPath } from "@/app/control-routes"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  DetailField,
  DetailPanel,
} from "@/features/control/detail-primitives"
import {
  StatusBadge,
  humanize,
} from "@/features/control/control-display"
import {
  formatDate,
  formatDuration,
  formatNumber,
} from "@/features/control/formatting"
import {
  friendlySessionLabel,
  shortSessionId,
} from "@/features/control/session-labels"
import type {
  ModelCallTraceDetail,
  ModelCallTraceSummary,
} from "@/lib/api"

const PROMPT_CACHE_REDACTION_PATTERN = /^\[redacted:([^:]+):sha256:([a-f0-9]{16})\]$/
const PROMPT_CACHE_FIELD_PATTERN = /prompt_?cache_?key|promptCacheKey/i

export function modelCallDetailPath(traceId: string) {
  return `/model-calls/${encodeURIComponent(traceId)}`
}

export function TraceOverview({
  trace,
  loading,
}: {
  trace: ModelCallTraceSummary
  loading?: boolean
}) {
  return (
    <DetailPanel title="Overview">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <DetailField label="Status" value={<StatusBadge status={trace.status} />} loading={loading} />
        <DetailField label="Mode" value={humanize(trace.mode)} loading={loading} />
        <DetailField label="Provider" value={trace.provider} loading={loading} />
        <DetailField label="Model" value={trace.model} loading={loading} />
        <DetailField label="Started" value={formatDate(trace.startedAt)} loading={loading} />
        <DetailField label="Finished" value={formatDate(trace.finishedAt)} loading={loading} />
        <DetailField label="Duration" value={formatDuration(trace.durationMs)} loading={loading} />
        <DetailField label="Usage" value={usageSummary(trace.usage)} loading={loading} />
        <DetailField label="Trace id" value={<CodeValue value={trace.id} />} loading={loading} />
        <DetailField label="Expires" value={formatDate(trace.expiresAt)} loading={loading} />
      </div>
    </DetailPanel>
  )
}

export function TraceContextPanel({ trace }: { trace: ModelCallTraceSummary }) {
  return (
    <DetailPanel title="Trace context">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <DetailField label="Agent" value={<CodeValue value={trace.agentKey} />} />
        <DetailField label="Session" value={<SessionReference trace={trace} />} />
        <DetailField label="Run" value={<CodeValue value={trace.runId} />} />
        <DetailField label="Thread" value={<CodeValue value={trace.threadId} />} />
        <DetailField label="Turn" value={trace.turn ?? "-"} />
        <DetailField label="Call index" value={trace.callIndex ?? "-"} />
        <DetailField
          label="Prompt cache key"
          value={<RedactedValue value={trace.promptCacheKey} />}
        />
      </div>
    </DetailPanel>
  )
}

export function TraceDetailSections({ trace }: { trace: ModelCallTraceDetail }) {
  const request = trace.request

  return (
    <>
      <DetailPanel title="Sanitized request">
        <div className="grid min-w-0 gap-4">
          <TextBlock title="System prompt" value={request.systemPrompt} emptyLabel="No system prompt captured." />
          <JsonBlock title="Tools / schema" value={request.tools} emptyLabel="No tools captured." />
        </div>
      </DetailPanel>
      <DetailPanel title="Projected messages">
        <ProjectedMessagesBlock value={request.messages} />
      </DetailPanel>
      <DetailPanel title="LLM context sections">
        <div className="grid min-w-0 gap-4">
          <LlmContextSectionsBlock value={request.llmContextSections} />
          {request.llmContextDump ? (
            <TextBlock title="LLM context dump" value={request.llmContextDump} />
          ) : null}
        </div>
      </DetailPanel>
      <DetailPanel title="Response / Error / Usage">
        <div className="grid min-w-0 gap-4 xl:grid-cols-3">
          <JsonBlock title="Response" value={trace.response} emptyLabel="No response captured." />
          <JsonBlock title="Error" value={trace.error} emptyLabel="No error captured." />
          <UsageBlock value={trace.usage} />
        </div>
      </DetailPanel>
    </>
  )
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
    </div>
  )
}

function SessionReference({ trace }: { trace: ModelCallTraceSummary }) {
  if (!trace.sessionId) return "-"

  const hasSessionMetadata = Boolean(trace.sessionKind || trace.sessionLabel || trace.sessionDisplayName || trace.sessionAlias)
  const label = friendlySessionLabel({
    id: trace.sessionId,
    label: trace.sessionLabel,
    displayName: trace.sessionDisplayName,
    alias: trace.sessionAlias,
    kind: trace.sessionKind,
  })
  const sessionCode = (
    <code className="break-all text-xs text-muted-foreground" title={trace.sessionId}>
      {shortSessionId(trace.sessionId)}
    </code>
  )
  const content = (
    <span className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-1.5">
      <span className="min-w-0 break-words">{label}</span>
      {sessionCode}
    </span>
  )

  return (
    <span className="grid min-w-0 gap-1">
      {content}
      <details className="min-w-0">
        <summary className="cursor-pointer select-none text-xs text-muted-foreground">
          Full session ID
        </summary>
        <code className="block max-w-full select-all break-all border bg-muted/30 p-2 text-xs text-muted-foreground">
          {trace.sessionId}
        </code>
      </details>
      {trace.agentKey && hasSessionMetadata ? (
        <Button variant="link" size="sm" className="h-auto justify-start p-0 text-xs" asChild>
          <Link to={sessionPath(trace.agentKey, trace.sessionId)}>Open session</Link>
        </Button>
      ) : null}
    </span>
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

function LlmContextSectionsBlock({ value }: { value: unknown }) {
  const sections = Array.isArray(value) ? value : []
  if (sections.length === 0) {
    return <EmptyBlock title="Sections" emptyLabel="No LLM context sections captured." />
  }

  return (
    <section className="grid min-w-0 gap-2">
      <h3 className="text-sm font-medium">Sections</h3>
      <div className="grid min-w-0 gap-3">
        {sections.map((section, index) => (
          <LlmContextSectionCard key={sectionKey(section, index)} section={section} index={index} />
        ))}
      </div>
    </section>
  )
}

function LlmContextSectionCard({
  section,
  index,
}: {
  section: unknown
  index: number
}) {
  const record = asRecord(section) ?? {}
  const name = firstString(record, ["name"]) ?? `Section ${index + 1}`
  const label = firstString(record, ["label"])
  const source = firstString(record, ["source"])
  const content = firstString(record, ["content", "dump"])
  const preview = firstString(record, ["contentPreview", "preview"]) ?? content
  const contentChars = firstNumber(record, ["contentChars", "charCount", "chars"])
  const estimatedTokens = firstNumber(record, ["estimatedTokens", "tokenEstimate", "tokens"])
  const promptCacheKeyPart = firstString(record, ["promptCacheKeyPart", "promptCacheKeyFingerprint"])

  return (
    <div className="grid min-w-0 gap-2 border p-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 break-words text-sm font-medium">{label ?? name}</span>
        {label ? <Badge variant="outline">{name}</Badge> : null}
        {source ? <Badge variant="outline">{source}</Badge> : null}
        {contentChars !== null ? (
          <Badge variant="secondary">{contentChars.toLocaleString()} chars</Badge>
        ) : null}
        {estimatedTokens !== null ? (
          <Badge variant="secondary">~{estimatedTokens.toLocaleString()} tokens</Badge>
        ) : null}
      </div>
      {promptCacheKeyPart ? (
        <div className="min-w-0 text-xs text-muted-foreground">
          Prompt cache part: <RedactedValue value={promptCacheKeyPart} />
        </div>
      ) : null}
      {preview ? (
        <pre className="max-h-32 max-w-full overflow-auto whitespace-pre-wrap break-words border bg-muted/30 p-3 font-mono text-xs leading-relaxed [overflow-wrap:anywhere]">
          {preview}
        </pre>
      ) : (
        <div className="text-sm text-muted-foreground">No section content captured.</div>
      )}
      {content && content !== preview ? (
        <details className="grid min-w-0 gap-2" open={index === 0}>
          <summary className="cursor-pointer select-none text-xs text-muted-foreground">
            Expand full section content
          </summary>
          <pre className="max-h-80 max-w-full overflow-auto whitespace-pre-wrap break-words border bg-muted/30 p-3 font-mono text-xs leading-relaxed [overflow-wrap:anywhere]">
            {content}
          </pre>
        </details>
      ) : null}
      <JsonDetails label="Section JSON" value={section} />
    </div>
  )
}

function ProjectedMessagesBlock({ value }: { value: unknown }) {
  if (!Array.isArray(value) || value.length === 0) {
    return <div className="text-sm text-muted-foreground">No projected messages captured.</div>
  }

  return (
    <div className="grid min-w-0 gap-3">
      {value.map((message, index) => (
        <ProjectedMessageCard key={messageKey(message, index)} message={message} index={index} />
      ))}
    </div>
  )
}

function ProjectedMessageCard({
  message,
  index,
}: {
  message: unknown
  index: number
}) {
  const record = asRecord(message)
  const role = record ? firstString(record, ["role"]) : null
  const name = record ? firstString(record, ["name", "toolName"]) : null
  const content = record && Object.hasOwn(record, "content") ? record.content : message
  const timestamp = record ? firstString(record, ["timestamp"]) : null

  return (
    <article className="grid min-w-0 gap-3 border p-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Badge variant={roleBadgeVariant(role)}>{role ? humanize(role) : `Message ${index + 1}`}</Badge>
        {name ? <Badge variant="outline">{name}</Badge> : null}
        {timestamp ? <Badge variant="secondary">{timestamp}</Badge> : null}
      </div>
      <MessageContent value={content} />
      <JsonDetails label="Message JSON" value={message} />
    </article>
  )
}

function MessageContent({ value }: { value: unknown }) {
  if (typeof value === "string") {
    return <TextValue value={value} />
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <div className="text-sm text-muted-foreground">No message content.</div>
    }
    return (
      <div className="grid min-w-0 gap-2">
        {value.map((part, index) => (
          <MessagePart key={messageKey(part, index)} value={part} index={index} />
        ))}
      </div>
    )
  }
  if (value === null || value === undefined || value === "") {
    return <div className="text-sm text-muted-foreground">No message content.</div>
  }
  return <MessagePart value={value} index={0} />
}

function MessagePart({ value, index }: { value: unknown; index: number }) {
  if (typeof value === "string") {
    return <TextValue value={value} />
  }
  const record = asRecord(value)
  if (!record) {
    return <JsonDetails label={`Part ${index + 1} JSON`} value={value} open />
  }

  const type = firstString(record, ["type"]) ?? `Part ${index + 1}`
  const text = firstString(record, ["text"])
  const name = firstString(record, ["name", "toolName"])
  const id = firstString(record, ["id", "toolCallId"])
  const mimeType = firstString(record, ["mimeType", "mediaType"])
  const argumentsValue = Object.hasOwn(record, "arguments") ? record.arguments : undefined

  if (text) {
    return (
      <div className="grid min-w-0 gap-2 border bg-muted/20 p-2">
        <PartHeader type={type} name={name} id={id} extra={mimeType} />
        <TextValue value={text} />
      </div>
    )
  }

  return (
    <div className="grid min-w-0 gap-2 border bg-muted/20 p-2">
      <PartHeader type={type} name={name} id={id} extra={mimeType} />
      {argumentsValue !== undefined ? (
        <JsonDetails label="Arguments JSON" value={argumentsValue} open={false} />
      ) : null}
      <JsonDetails label="Part JSON" value={value} open={argumentsValue === undefined} />
    </div>
  )
}

function PartHeader({
  type,
  name,
  id,
  extra,
}: {
  type: string
  name: string | null
  id: string | null
  extra: string | null
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <Badge variant="outline">{humanize(type)}</Badge>
      {name ? <span className="min-w-0 break-words">{name}</span> : null}
      {id ? <code className="break-all">{id}</code> : null}
      {extra ? <span className="min-w-0 break-words">{extra}</span> : null}
    </div>
  )
}

function UsageBlock({ value }: { value: unknown }) {
  const usage = asRecord(value)
  if (!usage) return <EmptyBlock title="Usage" emptyLabel="No usage captured." />

  const input = firstNumber(usage, ["input", "inputTokens", "promptTokens"])
  const output = firstNumber(usage, ["output", "outputTokens", "completionTokens"])
  const total = firstNumber(usage, ["totalTokens", "total", "tokens"])
  const cacheRead = firstNumber(usage, ["cacheRead", "cachedInputTokens"])
  const cacheWrite = firstNumber(usage, ["cacheWrite"])
  const cost = usageCostSummary(value)
  const costRecord = asRecord(usage.cost)

  return (
    <section className="grid min-w-0 gap-3 border p-3">
      <h3 className="text-sm font-medium">Usage</h3>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
        <DetailField label="Input tokens" value={formatNumber(input) ?? "-"} />
        <DetailField label="Output tokens" value={formatNumber(output) ?? "-"} />
        <DetailField label="Total tokens" value={formatNumber(total) ?? "-"} />
        <DetailField label="Cache read" value={formatNumber(cacheRead) ?? "-"} />
        <DetailField label="Cache write" value={formatNumber(cacheWrite) ?? "-"} />
        <DetailField label="Cost" value={cost ?? "-"} />
      </div>
      {costRecord ? <CostComponents value={costRecord} /> : null}
      <JsonDetails label="Usage JSON" value={value} />
    </section>
  )
}

function CostComponents({ value }: { value: Record<string, unknown> }) {
  const entries = Object.entries(value)
    .filter(([, entry]) => typeof entry === "number" && Number.isFinite(entry))
    .map(([key, entry]) => ({ key, value: entry as number }))
  if (entries.length === 0) return null

  return (
    <div className="grid min-w-0 gap-1 text-xs text-muted-foreground">
      <div className="font-medium text-foreground">Cost components</div>
      {entries.map((entry) => (
        <div key={entry.key} className="flex min-w-0 justify-between gap-3">
          <span className="min-w-0 break-words">{humanize(entry.key)}</span>
          <span className="shrink-0 tabular-nums">{formatUsd(entry.value)}</span>
        </div>
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

function TextValue({ value }: { value: string }) {
  return (
    <div className="max-w-full whitespace-pre-wrap break-words text-sm leading-relaxed [overflow-wrap:anywhere]">
      {value}
    </div>
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

function JsonDetails({
  label,
  value,
  open = false,
}: {
  label: string
  value: unknown
  open?: boolean
}) {
  return (
    <details className="grid min-w-0 gap-2" open={open}>
      <summary className="cursor-pointer select-none text-xs text-muted-foreground">
        {label}
      </summary>
      <pre className="max-h-80 max-w-full overflow-auto whitespace-pre-wrap break-words border bg-muted/30 p-3 font-mono text-xs leading-relaxed [overflow-wrap:anywhere]">
        {formatJson(value)}
      </pre>
    </details>
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

function firstString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) return value
    if (typeof value === "number" && Number.isFinite(value)) return String(value)
  }
  return null
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

function sectionKey(section: unknown, index: number) {
  const record = asRecord(section)
  const name = record ? firstString(record, ["name", "label", "source"]) : null
  return `${name ?? "section"}:${index}`
}

function messageKey(message: unknown, index: number) {
  const record = asRecord(message)
  const id = record ? firstString(record, ["id", "toolCallId", "role", "type"]) : null
  return `${id ?? "message"}:${index}`
}

function shortContextValue(value: string) {
  if (value.startsWith("#")) return value
  return value.length > 42 ? `${value.slice(0, 24)}…${value.slice(-10)}` : value
}

function roleBadgeVariant(role: string | null): React.ComponentProps<typeof Badge>["variant"] {
  if (role === "system") return "secondary"
  if (role === "user") return "default"
  if (role === "assistant") return "outline"
  if (role === "tool" || role === "toolResult") return "secondary"
  return "outline"
}

function formatJson(value: unknown) {
  try {
    return JSON.stringify(redactKnownSensitiveJson(value), null, 2)
  } catch {
    return String(value)
  }
}

function redactKnownSensitiveJson(value: unknown, seen = new WeakSet<object>()): unknown {
  if (Array.isArray(value)) return value.map((entry) => redactKnownSensitiveJson(entry, seen))
  if (typeof value !== "object" || value === null) return value
  if (seen.has(value)) return "[circular]"
  seen.add(value)

  const output: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    output[key] = PROMPT_CACHE_FIELD_PATTERN.test(key)
      ? "[redacted prompt-cache value]"
      : redactKnownSensitiveJson(entry, seen)
  }
  return output
}
