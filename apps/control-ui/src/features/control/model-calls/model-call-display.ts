import type {
  ModelCallTraceDetail,
  ModelCallTraceFailureGroup,
  ModelCallTraceSummary,
  TableParams,
} from "@/lib/api"

import { formatDate, formatDuration } from "../formatting"
import {
  sanitizeDisplayString,
  type ModelCallTraceViewModel,
  type TraceSpan,
} from "./model-call-trace-view-model"

export type BashExecutionDetails = {
  command: string | null
  cwd: string | null
  exitCode: boolean | number | string | null
  looksLikeBash: boolean
  status: boolean | number | string | null
  stderr: string | null
  stderrChars: number | null
  stderrTruncated: boolean
  stdout: string | null
  stdoutChars: number | null
  stdoutTruncated: boolean
  timedOut: boolean
}

export type ModelCallFailureGroup = ModelCallTraceFailureGroup & { key: string }

export type ModelCallUsageTokenCounts = {
  input: number | null
  output: number | null
  total: number | null
}

export type ModelCallUsageBreakdown = {
  cacheRead: number
  cacheReadCost: number
  cacheReadRate: number
  cacheWrite: number
  hasUsage: boolean
  input: number
  output: number
  promptTokens: number
  total: number
  totalCost: number
}

/** Returns the full human-readable text for a context span without JSON wrapper duplication. */
export function readableContextContent(
  span: Pick<TraceSpan, "kind" | "raw">
): string | null {
  if (span.kind !== "context") return null
  return readableContextValue(span.raw)
}

export function modelCallDetailPath(traceId: string) {
  return `/model-calls/${encodeURIComponent(traceId)}`
}

function readableContextValue(value: unknown): string | null {
  if (typeof value === "string") return value
  const record = asRecord(value)
  if (!record) return null

  for (const key of ["content", "systemPrompt", "llmContextDump", "text", "dump", "contentPreview"]) {
    const readable = readableContextValue(record[key])
    if (readable !== null) return readable
  }
  return null
}

export function modelCallsListPath(
  trace?: Pick<ModelCallTraceSummary, "agentKey" | "runId" | "sessionId"> | null
) {
  if (!trace) return "/model-calls"
  return modelCallsListFilterPath({
    agent_key: trace.agentKey ?? undefined,
    run_id: trace.runId ?? undefined,
    session_id: trace.sessionId ?? undefined,
  })
}

export function modelCallsListFilterPath(params: TableParams) {
  const query = modelCallFilterSearchParams(params).toString()
  return query ? `/model-calls?${query}` : "/model-calls"
}

function modelCallFilterSearchParams(params: TableParams) {
  const search = new URLSearchParams()
  setParamIfPresent(search, "status", params.status)
  setParamIfPresent(search, "mode", params.mode)
  setParamIfPresent(search, "agent_key", params.agent_key)
  setParamIfPresent(search, "session_id", params.session_id)
  setParamIfPresent(search, "run_id", params.run_id)
  return search
}

function setParamIfPresent(
  search: URLSearchParams,
  key: string,
  value: TableParams[string]
) {
  if (typeof value === "string" && value.trim()) search.set(key, value.trim())
  if (typeof value === "number" && Number.isFinite(value)) search.set(key, String(value))
  if (typeof value === "boolean") search.set(key, String(value))
}

export function usageSummary(value: unknown) {
  const { input, output, total } = usageTokenCounts(value)
  if (input === null && output === null && total === null && !asRecord(value)) return "-"
  const cost = usageCostSummary(value)
  const parts = [
    input !== null ? `in ${input.toLocaleString()}` : null,
    output !== null ? `out ${output.toLocaleString()}` : null,
    total !== null ? `total ${total.toLocaleString()}` : null,
    cost,
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(" · ") : "-"
}

export function usageBreakdown(value: unknown): ModelCallUsageBreakdown {
  const usage = asRecord(value)
  if (!usage) {
    return {
      cacheRead: 0,
      cacheReadCost: 0,
      cacheReadRate: 0,
      cacheWrite: 0,
      hasUsage: false,
      input: 0,
      output: 0,
      promptTokens: 0,
      total: 0,
      totalCost: 0,
    }
  }
  const input = firstNumber(usage, ["input", "inputTokens", "input_tokens", "promptTokens", "prompt_tokens"]) ?? 0
  const output = firstNumber(usage, ["output", "outputTokens", "output_tokens", "completionTokens", "completion_tokens"]) ?? 0
  const cacheRead = firstNumber(usage, ["cacheRead", "cache_read", "cachedInputTokens", "cached_input_tokens"]) ?? 0
  const cacheWrite = firstNumber(usage, ["cacheWrite", "cache_write", "cacheCreationInputTokens", "cache_creation_input_tokens"]) ?? 0
  const promptTokens = input + cacheRead + cacheWrite
  const total = firstNumber(usage, ["totalTokens", "total_tokens", "total", "tokens"])
    ?? promptTokens + output
  const cost = asRecord(usage.cost)
  const cacheReadCost = firstNumber(cost, ["cacheRead", "cache_read"]) ?? 0
  const componentCost = ["input", "output", "cacheRead", "cacheWrite"]
    .map((key) => firstNumber(cost, [key]) ?? 0)
    .reduce((sum, entry) => sum + entry, 0)
  const totalCost = firstNumber(cost, ["total"]) ?? componentCost
  return {
    cacheRead,
    cacheReadCost,
    cacheReadRate: promptTokens > 0 ? cacheRead / promptTokens : 0,
    cacheWrite,
    hasUsage: true,
    input,
    output,
    promptTokens,
    total,
    totalCost,
  }
}

export function usageTokenCounts(value: unknown): ModelCallUsageTokenCounts {
  const usage = asRecord(value)
  if (!usage) return { input: null, output: null, total: null }
  return {
    input: firstNumber(usage, ["input", "inputTokens", "input_tokens", "promptTokens", "prompt_tokens"]),
    output: firstNumber(usage, ["output", "outputTokens", "output_tokens", "completionTokens", "completion_tokens"]),
    total: firstNumber(usage, ["totalTokens", "total_tokens", "total", "tokens"]),
  }
}

export function traceErrorSummary(value: unknown) {
  const error = asRecord(value)
  if (!error) return null
  return firstString(error, ["message", "summary", "detail", "error", "reason"])
    ?? firstString(error, ["category", "name", "type", "code", "status"])
}

export function traceErrorLabel(value: unknown) {
  const error = asRecord(value)
  if (!error) return null
  return firstString(error, ["category", "name", "type", "code", "status"])
}

export function modelCallFailureGroups(
  traces: readonly ModelCallTraceSummary[],
  limit = 3
): ModelCallFailureGroup[] {
  const groups = new Map<string, ModelCallFailureGroup>()
  for (const trace of traces) {
    if (trace.status !== "failed") continue
    const label = traceErrorLabel(trace.error) ?? "failed"
    const summary = traceErrorSummary(trace.error) ?? "Failed without captured error summary"
    const key = [
      trace.provider,
      trace.model,
      trace.mode,
      normalizeFailureGroupText(label),
    ].join("\u0000")
    const existing = groups.get(key)
    if (!existing) {
      groups.set(key, {
        count: 1,
        key,
        label,
        latestStartedAt: trace.startedAt,
        representative: trace,
        summary,
      })
      continue
    }

    existing.count += 1
    if (isNewerTrace(trace, existing.representative)) {
      existing.latestStartedAt = trace.startedAt
      existing.representative = trace
      existing.summary = summary
    }
  }

  return [...groups.values()]
    .sort((left, right) =>
      right.count - left.count ||
      timestampMs(right.latestStartedAt) - timestampMs(left.latestStartedAt)
    )
    .slice(0, limit)
}

export function shortModelCallContextValue(value: string) {
  if (value.startsWith("#")) return value
  return value.length > 42 ? `${value.slice(0, 24)}…${value.slice(-10)}` : value
}

export function extractBashExecutionDetails(input: {
  call?: unknown
  result?: unknown
  resultPayload?: unknown
  toolArguments?: unknown
  toolName?: string
}): BashExecutionDetails {
  const call = asRecord(input.call)
  const args = asRecord(input.toolArguments) ?? asRecord(firstExisting(call, ["arguments", "args", "input", "parameters"]))
  const details =
    bashDetailsRecord(input.result) ??
    bashDetailsRecord(input.resultPayload) ??
    asRecord(input.resultPayload) ??
    asRecord(input.result)
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

  return {
    command,
    cwd,
    exitCode,
    looksLikeBash:
      input.toolName === "bash" ||
      firstString(details, ["kind"]) === "bash" ||
      Boolean(command || stdout || stderr || exitCode !== null),
    status,
    stderr,
    stderrChars,
    stderrTruncated,
    stdout,
    stdoutChars,
    stdoutTruncated,
    timedOut,
  }
}

/** Returns the operator-facing outcome for a bash execution without exposing its wire payload. */
export function bashExecutionHeadline(details: BashExecutionDetails): string {
  if (details.timedOut) return "Timed out"

  const exitCode = details.exitCode
  if (exitCode !== null && String(exitCode) !== "0") {
    const failure = firstShellOutputLine(details.stderr) ?? firstShellOutputLine(details.stdout)
    return failure ? `Exit ${String(exitCode)} · ${failure}` : `Exited with code ${String(exitCode)}`
  }
  if (exitCode !== null && String(exitCode) === "0") return "Completed successfully"

  if (details.status === false || isFailureStatus(details.status)) return "Command failed"
  if (details.status === true || isSuccessStatus(details.status)) return "Completed successfully"
  return "Waiting for result"
}

export function traceDebugFindings(viewModel: ModelCallTraceViewModel) {
  const findings: Array<{ destructive?: boolean; detail: string; label: string }> = []
  if (viewModel.summary.pendingToolCalls > 0) {
    findings.push({
      destructive: true,
      label: `${viewModel.summary.pendingToolCalls} missing result${viewModel.summary.pendingToolCalls === 1 ? "" : "s"}`,
      detail: "Tool call spans without paired result payloads.",
    })
  }
  if (viewModel.summary.unmatchedToolResults > 0) {
    findings.push({
      destructive: true,
      label: `${viewModel.summary.unmatchedToolResults} unmatched result${viewModel.summary.unmatchedToolResults === 1 ? "" : "s"}`,
      detail: "Tool result payloads that did not match a captured tool call id.",
    })
  }
  if (viewModel.summary.truncatedSpans > 0) {
    findings.push({
      label: `${viewModel.summary.truncatedSpans} truncated span${viewModel.summary.truncatedSpans === 1 ? "" : "s"}`,
      detail: "One or more captured payloads include truncation markers.",
    })
  }
  if (viewModel.summary.redactedSpans > 0) {
    findings.push({
      label: `${viewModel.summary.redactedSpans} redacted span${viewModel.summary.redactedSpans === 1 ? "" : "s"}`,
      detail: "One or more captured payloads include redaction markers.",
    })
  }
  if (!viewModel.summary.hasStepDurations && viewModel.summary.toolCalls > 0) {
    findings.push({
      label: "No step timing",
      detail: "The trace has tool spans but no per-step duration fields.",
    })
  }
  return findings
}

export function buildDebugReport(
  trace: ModelCallTraceDetail,
  viewModel: ModelCallTraceViewModel,
  selectedSpan: TraceSpan | null
) {
  const focus = selectedSpan ?? viewModel.summary.failingSpan ?? viewModel.summary.slowestSpan
  const findings = traceDebugFindings(viewModel)
  const lines = [
    "Panda model-call debug report",
    `trace: ${trace.id}`,
    `status: ${trace.status}`,
    `model: ${trace.provider}/${trace.model}`,
    `mode: ${trace.mode}`,
    `started: ${formatDate(trace.startedAt) ?? "-"}`,
    `duration: ${formatDuration(trace.durationMs) ?? "-"}`,
    `usage: ${usageSummary(trace.usage)}`,
    `agent: ${trace.agentKey ?? "-"}`,
    `session: ${trace.sessionId ?? "-"}`,
    `thread: ${trace.threadId ?? "-"}`,
    `run: ${trace.runId ?? "-"}`,
    `turn/call: ${trace.turn ?? "-"}/${trace.callIndex ?? "-"}`,
    `spans: ${viewModel.spans.length} total, ${viewModel.summary.toolCalls} tools, ${viewModel.summary.messageCount} messages`,
    `capture: ${findings.length > 0 ? findings.map((finding) => finding.label).join(", ") : "complete"}`,
  ]
  if (viewModel.summary.triageItems.length > 0) {
    lines.push(
      "triage:",
      ...viewModel.summary.triageItems.map((item, index) =>
        `${index + 1}. ${item.label} · span ${item.spanOrder} · ${sanitizeDisplayString(item.detail)}`
      )
    )
  } else {
    lines.push("triage: no ranked suspects")
  }
  const error = traceErrorSummary(trace.error)
  if (error) lines.push(`error: ${sanitizeDisplayString(error)}`)
  if (focus) {
    lines.push(
      `focus span: ${focus.id}`,
      `focus status: ${focus.status}`,
      `focus title: ${sanitizeDisplayString(focus.title)}`,
      `focus preview: ${sanitizeDisplayString(focus.preview ?? "-")}`
    )
  }
  return lines.join("\n")
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

function normalizeFailureGroupText(value: string) {
  return value.trim().toLowerCase().replace(/[_-]+/g, " ")
}

function isNewerTrace(left: ModelCallTraceSummary, right: ModelCallTraceSummary) {
  return timestampMs(left.startedAt) > timestampMs(right.startedAt)
}

function timestampMs(value: string | null | undefined) {
  if (!value) return 0
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : 0
}

function bashDetailsRecord(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value)
  if (!record) return null

  const details = asRecord(record.details)
  if (details) return details

  const content = asRecord(record.content)
  const contentDetails = asRecord(content?.details)
  if (contentDetails) return contentDetails
  if (content && hasBashDetailFields(content)) return content

  const result = asRecord(record.result)
  const resultDetails = asRecord(result?.details)
  if (resultDetails) return resultDetails
  if (result && hasBashDetailFields(result)) return result

  if (hasBashDetailFields(record)) return record
  return null
}

function firstShellOutputLine(value: string | null): string | null {
  if (!value) return null
  const line = value.split(/\r?\n/).map((entry) => entry.trim()).find(Boolean)
  if (!line) return null
  return line
    .replace(/^(?:zsh|bash|sh):(?:\s*line\s*)?\d+:\s*/i, "")
    .slice(0, 160)
}

function isFailureStatus(value: boolean | number | string | null): boolean {
  return typeof value === "string" && ["error", "failed", "failure"].includes(value.toLowerCase())
}

function isSuccessStatus(value: boolean | number | string | null): boolean {
  return typeof value === "string" && ["ok", "completed", "success", "succeeded"].includes(value.toLowerCase())
}

function hasBashDetailFields(record: Record<string, unknown>): boolean {
  return Boolean(
    firstString(record, ["command", "cwd", "stdout", "stderr", "kind"]) ||
    firstPrimitive(record, ["exitCode", "signal", "status"]) !== null
  )
}

function firstExisting(record: Record<string, unknown> | null | undefined, keys: string[]) {
  if (!record) return undefined
  for (const key of keys) {
    if (Object.hasOwn(record, key)) return record[key]
  }
  return undefined
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
