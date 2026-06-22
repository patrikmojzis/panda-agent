const PROMPT_CACHE_FIELD_NAME_PATTERN = String.raw`prompt[_-]?cache[_-]?key(?:[_-]?(?:part|fingerprint))?`
const PROMPT_CACHE_FIELD_PATTERN = new RegExp(PROMPT_CACHE_FIELD_NAME_PATTERN, "i")
const PROMPT_CACHE_FIELD_ASSIGNMENT_TAIL_PATTERN = new RegExp(String.raw`((?:\\?["'])?${PROMPT_CACHE_FIELD_NAME_PATTERN}(?:\\?["'])?\s*[:=]\s*(?:\\?["'])?)[\s\S]*`, "gi")
const PROMPT_CACHE_FIELD_TOKEN_TAIL_PATTERN = new RegExp(String.raw`(\b${PROMPT_CACHE_FIELD_NAME_PATTERN}\b\s+)[\s\S]*`, "gi")
const PROMPT_CACHE_TOKEN_PATTERN = /\b(?:prompt-cache|prompt_cache|trace-cache|context-cache|context_cache):[^\s"'`,;)}\]]+/gi
const DEFAULT_PREVIEW_CHARS = 320

export type TraceSpanKind = "context" | "message" | "tool" | "response" | "error" | "metadata"
export type TraceSpanStatus = "ok" | "failed" | "pending" | "info"

export type TraceSpanMetric = {
  label: string
  value: string
}

export type ToolSpanDetail = {
  arguments?: unknown
  argumentsPreview?: string
  argumentsSize: number | null
  call: unknown | null
  callId?: string
  isError: boolean
  name: string
  redacted: boolean
  result?: unknown
  resultPreview?: string
  resultSize: number | null
  truncated: boolean
}

export type TraceSpan = {
  badges: string[]
  durationMs: number | null
  id: string
  kind: TraceSpanKind
  metrics: TraceSpanMetric[]
  order: number
  preview: string | null
  raw: unknown
  role?: string
  source?: string
  status: TraceSpanStatus
  subtitle?: string
  title: string
  tool?: ToolSpanDetail
}

export type ModelCallTraceViewModel = {
  selectedDefaultId: string | null
  spans: TraceSpan[]
  summary: {
    contextSections: number
    failingSpan: TraceSpan | null
    hasStepDurations: boolean
    messageCount: number
    rawPayloadBytes: number | null
    slowestSpan: TraceSpan | null
    toolCalls: number
    toolErrors: number
  }
}

type TraceLike = {
  durationMs?: number | null
  error?: unknown
  id: string
  request?: Record<string, unknown> | null
  response?: unknown
  status?: string
}

type ToolResultEntry = {
  index: number
  message: Record<string, unknown>
}

export function buildModelCallTraceViewModel(trace: TraceLike): ModelCallTraceViewModel {
  const request = asRecord(trace.request) ?? {}
  const spans: TraceSpan[] = []
  const usedToolResultIds = new Set<string>()
  let order = 0

  const addSpan = (span: Omit<TraceSpan, "order">) => {
    order += 1
    spans.push({...span, order})
  }

  const systemPrompt = request.systemPrompt
  if (hasRenderableValue(systemPrompt)) {
    addSpan(contextSpan({
      id: "context:system-prompt",
      title: "System prompt",
      subtitle: payloadSubtitle(systemPrompt),
      preview: previewForValue(systemPrompt),
      raw: {systemPrompt},
    }))
  }

  const contextSections = Array.isArray(request.llmContextSections) ? request.llmContextSections : []
  contextSections.forEach((section, index) => {
    const record = asRecord(section)
    const name = record ? firstString(record, ["label", "name", "source"]) : null
    const source = record ? firstString(record, ["source", "name"]) : null
    const content = record
      ? firstRenderable(record, ["contentPreview", "preview", "content", "dump"])
      : section
    const chars = record ? firstNumber(record, ["contentChars", "charCount", "chars", "dumpChars"]) : null
    const tokens = record ? firstNumber(record, ["estimatedTokens", "tokenEstimate", "tokens"]) : null
    addSpan(contextSpan({
      id: `context:section:${index}`,
      title: name ?? `Context section ${index + 1}`,
      subtitle: source && source !== name ? source : undefined,
      preview: previewForValue(content),
      raw: section,
      metrics: [
        chars !== null ? {label: "Size", value: `${formatCompactNumber(chars)} chars`} : null,
        tokens !== null ? {label: "Tokens", value: `~${formatCompactNumber(tokens)}`} : null,
      ].filter(isPresent),
    }))
  })

  if (contextSections.length === 0 && hasRenderableValue(request.llmContextDump)) {
    addSpan(contextSpan({
      id: "context:dump",
      title: "LLM context dump",
      subtitle: payloadSubtitle(request.llmContextDump),
      preview: previewForValue(request.llmContextDump),
      raw: {llmContextDump: request.llmContextDump},
    }))
  }

  if (Array.isArray(request.tools) && request.tools.length > 0) {
    const toolNames = request.tools
      .map((tool) => firstString(asRecord(tool) ?? {}, ["name"]))
      .filter(isPresent)
    addSpan(contextSpan({
      id: "context:tools",
      title: "Available tools",
      subtitle: `${request.tools.length} tool${request.tools.length === 1 ? "" : "s"} exposed to the model`,
      preview: toolNames.length > 0 ? toolNames.join(", ") : previewForValue(request.tools),
      raw: {tools: request.tools},
      kind: "metadata",
      metrics: [{label: "Tools", value: String(request.tools.length)}],
    }))
  }

  const requestMessages = Array.isArray(request.messages) ? request.messages : []
  const toolResultsById = collectToolResults(requestMessages)

  requestMessages.forEach((message, messageIndex) => {
    const record = asRecord(message)
    if (!record) {
      addSpan(messageSpan({
        id: `request:message:${messageIndex}`,
        title: `Message ${messageIndex + 1}`,
        preview: previewForValue(message),
        raw: message,
      }))
      return
    }

    if (isToolResultMessage(record)) {
      return
    }

    const role = firstString(record, ["role"]) ?? "message"
    const toolCalls = toolCallsFromMessage(record)
    const textValue = messageTextValue(record, toolCalls.length > 0)
    if (hasRenderableValue(textValue)) {
      addSpan(messageSpan({
        id: `request:message:${messageIndex}`,
        title: `${humanize(role)} message`,
        subtitle: "Projected request context",
        preview: previewForValue(textValue),
        raw: message,
        role,
      }))
    } else if (toolCalls.length === 0) {
      addSpan(messageSpan({
        id: `request:message:${messageIndex}`,
        title: `${humanize(role)} message`,
        subtitle: "Projected request context",
        preview: previewForValue(record.content ?? message),
        raw: message,
        role,
      }))
    }

    toolCalls.forEach((toolCall, callIndex) => {
      const id = toolCallId(toolCall) ?? `request:${messageIndex}:tool:${callIndex}`
      const result = toolResultsById.get(id)
      if (result) usedToolResultIds.add(id)
      addSpan(toolSpan({
        id: `tool:${id}:${messageIndex}:${callIndex}`,
        call: toolCall,
        result: result?.message,
        source: "Projected request context",
      }))
    })
  })

  for (const [id, result] of toolResultsById.entries()) {
    if (usedToolResultIds.has(id)) continue
    addSpan(toolSpan({
      id: `tool:unmatched:${id}:${result.index}`,
      call: null,
      result: result.message,
      source: "Unmatched projected tool result",
    }))
  }

  const responseRecord = asRecord(trace.response)
  if (trace.response !== null && trace.response !== undefined) {
    if (responseRecord) {
      const responseToolCalls = toolCallsFromMessage(responseRecord)
      const textValue = messageTextValue(responseRecord, responseToolCalls.length > 0)
      if (hasRenderableValue(textValue)) {
        addSpan(responseSpan({
          id: "response:message",
          title: "Model response",
          subtitle: "Assistant output from this call",
          preview: previewForValue(textValue),
          raw: trace.response,
          role: firstString(responseRecord, ["role"]) ?? "assistant",
        }))
      } else if (responseToolCalls.length === 0) {
        addSpan(responseSpan({
          id: "response:message",
          title: "Model response",
          subtitle: "Assistant output from this call",
          preview: previewForValue(trace.response),
          raw: trace.response,
          role: firstString(responseRecord, ["role"]) ?? "assistant",
        }))
      }

      responseToolCalls.forEach((toolCall, callIndex) => {
        const id = toolCallId(toolCall) ?? `response:tool:${callIndex}`
        addSpan(toolSpan({
          id: `response-tool:${id}:${callIndex}`,
          call: toolCall,
          result: null,
          source: "Requested by model response",
        }))
      })
    } else {
      addSpan(responseSpan({
        id: "response:message",
        title: "Model response",
        subtitle: "Assistant output from this call",
        preview: previewForValue(trace.response),
        raw: trace.response,
      }))
    }
  }

  if (hasRenderableValue(trace.error)) {
    const errorRecord = asRecord(trace.error)
    const category = errorRecord ? firstString(errorRecord, ["category", "name", "type"]) : null
    const message = errorRecord ? firstString(errorRecord, ["message", "summary", "detail"]) : null
    addSpan({
      id: "error:model-call",
      kind: "error",
      status: "failed",
      title: category ? humanize(category) : "Model call failed",
      subtitle: "Provider/runtime error",
      preview: message ?? previewForValue(trace.error),
      raw: trace.error,
      durationMs: null,
      metrics: errorRecord
        ? Object.entries(errorRecord)
            .filter(([key, value]) => ["provider", "model", "status", "retryable", "timedOut"].includes(key) && value !== undefined)
            .map(([key, value]) => ({label: humanize(key), value: String(value)}))
        : [],
      badges: ["Failure"],
    })
  }

  if (spans.length === 0) {
    addSpan({
      id: "metadata:empty",
      kind: "metadata",
      status: "info",
      title: "Trace metadata only",
      subtitle: "No request messages, response, context, or error payload was captured.",
      preview: null,
      raw: trace,
      durationMs: null,
      metrics: [],
      badges: [],
    })
  }

  const toolSpans = spans.filter((span) => span.kind === "tool")
  const timedSpans = spans.filter((span) => typeof span.durationMs === "number" && Number.isFinite(span.durationMs))
  const failingSpan = spans.find((span) => span.status === "failed") ?? null
  const slowestSpan = timedSpans.reduce<TraceSpan | null>(
    (slowest, span) => !slowest || (span.durationMs ?? 0) > (slowest.durationMs ?? 0) ? span : slowest,
    null,
  )
  const selectedDefaultId = failingSpan?.id ?? slowestSpan?.id ?? toolSpans[0]?.id ?? spans[0]?.id ?? null

  return {
    selectedDefaultId,
    spans,
    summary: {
      contextSections: contextSections.length,
      failingSpan,
      hasStepDurations: timedSpans.length > 0,
      messageCount: spans.filter((span) => span.kind === "message" || span.kind === "response").length,
      rawPayloadBytes: payloadSize(trace),
      slowestSpan,
      toolCalls: toolSpans.length,
      toolErrors: toolSpans.filter((span) => span.status === "failed").length,
    },
  }
}

function contextSpan(input: {
  id: string
  kind?: TraceSpanKind
  metrics?: TraceSpanMetric[]
  preview: string | null
  raw: unknown
  subtitle?: string
  title: string
}): Omit<TraceSpan, "order"> {
  return {
    id: input.id,
    kind: input.kind ?? "context",
    status: "info",
    title: input.title,
    subtitle: input.subtitle,
    preview: input.preview,
    raw: input.raw,
    durationMs: null,
    metrics: input.metrics ?? [],
    badges: redactionBadges(input.raw),
  }
}

function messageSpan(input: {
  id: string
  preview: string | null
  raw: unknown
  role?: string
  subtitle?: string
  title: string
}): Omit<TraceSpan, "order"> {
  return {
    id: input.id,
    kind: "message",
    status: "info",
    title: input.title,
    subtitle: input.subtitle,
    preview: input.preview,
    raw: input.raw,
    role: input.role,
    durationMs: durationFrom(input.raw),
    metrics: payloadMetric(input.raw),
    badges: [...redactionBadges(input.raw), ...truncationBadges(input.raw)],
  }
}

function responseSpan(input: {
  id: string
  preview: string | null
  raw: unknown
  role?: string
  subtitle?: string
  title: string
}): Omit<TraceSpan, "order"> {
  return {
    ...messageSpan(input),
    kind: "response",
    status: "ok",
  }
}

function toolSpan(input: {
  call: Record<string, unknown> | null
  id: string
  result: Record<string, unknown> | null | undefined
  source: string
}): Omit<TraceSpan, "order"> {
  const call = input.call
  const result = input.result ?? null
  const name = firstString(call ?? {}, ["name", "toolName", "tool_name"])
    ?? firstString(result ?? {}, ["toolName", "name", "tool_name"])
    ?? "Unknown tool"
  const callId = (call ? toolCallId(call) : null) ?? (result ? toolResultId(result) : null) ?? undefined
  const args = call ? firstExisting(call, ["arguments", "args", "input", "parameters"]) : undefined
  const resultPayload = result ? toolResultPayload(result) : undefined
  const isError = Boolean(result && (result.isError === true || result.error === true || firstString(result, ["status"]) === "error"))
  const status: TraceSpanStatus = isError ? "failed" : result ? "ok" : "pending"
  const truncated = containsTruncation(call) || containsTruncation(result)
  const redacted = containsRedaction(call) || containsRedaction(result)
  const durationMs = durationFrom(result) ?? durationFrom(call)
  const argumentsPreview = args === undefined ? undefined : previewForValue(args)
  const resultPreview = resultPayload === undefined ? undefined : previewForValue(resultPayload)
  const badges = [
    input.source,
    truncated ? "Truncated" : null,
    redacted ? "Redacted" : null,
    callId ? `id ${shortId(callId)}` : null,
  ].filter(isPresent)

  return {
    id: input.id,
    kind: "tool",
    status,
    title: name,
    subtitle: result
      ? isError ? "Tool call paired with error result" : "Tool call paired with result"
      : "Tool call awaiting/missing result in this trace",
    preview: resultPreview ?? argumentsPreview ?? null,
    raw: {call, result},
    source: input.source,
    durationMs,
    metrics: [
      durationMs !== null ? {label: "Duration", value: `${Math.round(durationMs)}ms`} : null,
      args !== undefined ? {label: "Args", value: sizeLabel(args)} : null,
      resultPayload !== undefined ? {label: "Output", value: sizeLabel(resultPayload)} : null,
    ].filter(isPresent),
    badges,
    tool: {
      arguments: args,
      argumentsPreview: argumentsPreview ?? undefined,
      argumentsSize: args === undefined ? null : payloadSize(args),
      call,
      callId,
      isError,
      name,
      redacted,
      result: resultPayload,
      resultPreview: resultPreview ?? undefined,
      resultSize: resultPayload === undefined ? null : payloadSize(resultPayload),
      truncated,
    },
  }
}

function collectToolResults(messages: unknown[]): Map<string, ToolResultEntry> {
  const results = new Map<string, ToolResultEntry>()
  messages.forEach((message, index) => {
    const record = asRecord(message)
    if (!record || !isToolResultMessage(record)) return
    const id = toolResultId(record)
    if (!id || results.has(id)) return
    results.set(id, {index, message: record})
  })
  return results
}

function isToolResultMessage(record: Record<string, unknown>): boolean {
  const role = firstString(record, ["role", "type"])
  const normalizedRole = role?.replace(/[_-]/g, "").toLowerCase()
  return normalizedRole === "toolresult" || normalizedRole === "tool" || Boolean(record.toolCallId || record.tool_call_id)
}

function toolCallsFromMessage(record: Record<string, unknown>): Record<string, unknown>[] {
  const content = record.content
  if (!Array.isArray(content)) return []
  return content.filter((block): block is Record<string, unknown> => {
    const blockRecord = asRecord(block)
    if (!blockRecord) return false
    const type = firstString(blockRecord, ["type", "kind"])?.replace(/[_-]/g, "").toLowerCase()
    if (type === "toolcall" || type === "functioncall") return true
    return Boolean(firstString(blockRecord, ["name", "toolName", "tool_name"]) && firstExisting(blockRecord, ["arguments", "args", "input", "parameters"]) !== undefined)
  })
}

function messageTextValue(record: Record<string, unknown>, omitToolCallBlocks: boolean): unknown {
  const content = record.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return content

  const textParts = content
    .filter((part) => {
      if (!omitToolCallBlocks) return true
      const partRecord = asRecord(part)
      const type = partRecord ? firstString(partRecord, ["type", "kind"])?.replace(/[_-]/g, "").toLowerCase() : null
      return type !== "toolcall" && type !== "functioncall"
    })
    .map((part) => {
      if (typeof part === "string") return part
      const partRecord = asRecord(part)
      return partRecord ? firstString(partRecord, ["text", "content", "message"]) : null
    })
    .filter(isPresent)

  return textParts.length > 0 ? textParts.join("\n\n") : null
}

function toolCallId(record: Record<string, unknown>): string | null {
  return firstString(record, ["id", "toolCallId", "tool_call_id", "callId"])
}

function toolResultId(record: Record<string, unknown>): string | null {
  return firstString(record, ["toolCallId", "tool_call_id", "id", "callId"])
}

function toolResultPayload(record: Record<string, unknown>): unknown {
  if (Object.hasOwn(record, "content")) return record.content
  if (Object.hasOwn(record, "result")) return record.result
  if (Object.hasOwn(record, "output")) return record.output
  if (Object.hasOwn(record, "details")) return record.details
  return record
}

function durationFrom(value: unknown): number | null {
  const record = asRecord(value)
  if (!record) return null
  const direct = firstNumber(record, ["durationMs", "elapsedMs", "runtimeMs", "latencyMs", "wallMs"])
  if (direct !== null) return direct

  const details = asRecord(record.details)
  if (details) {
    const detailDuration = firstNumber(details, ["durationMs", "elapsedMs", "runtimeMs", "latencyMs", "wallMs"])
    if (detailDuration !== null) return detailDuration
  }

  const startedAt = timestampMs(firstExisting(record, ["startedAt", "startTime", "started_at"]))
  const finishedAt = timestampMs(firstExisting(record, ["finishedAt", "endTime", "finished_at", "completedAt"]))
  if (startedAt !== null && finishedAt !== null && finishedAt >= startedAt) return finishedAt - startedAt
  return null
}

function timestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "string" || !value.trim()) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function firstExisting(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (Object.hasOwn(record, key)) return record[key]
  }
  return undefined
}

function firstRenderable(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const value = record[key]
    if (hasRenderableValue(value)) return value
  }
  return null
}

function hasRenderableValue(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === "string") return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  return true
}

function payloadMetric(value: unknown): TraceSpanMetric[] {
  const size = payloadSize(value)
  return size === null ? [] : [{label: "Payload", value: formatByteLabel(size)}]
}

function payloadSubtitle(value: unknown): string | undefined {
  const size = payloadSize(value)
  return size === null ? undefined : formatByteLabel(size)
}

function sizeLabel(value: unknown): string {
  const size = payloadSize(value)
  return size === null ? "-" : formatByteLabel(size)
}

function payloadSize(value: unknown): number | null {
  const formatted = formatSanitizedJson(value)
  if (!formatted) return null
  return new TextEncoder().encode(formatted).length
}

function redactionBadges(value: unknown): string[] {
  return containsRedaction(value) ? ["Redacted"] : []
}

function truncationBadges(value: unknown): string[] {
  return containsTruncation(value) ? ["Truncated"] : []
}

function containsRedaction(value: unknown): boolean {
  return formatSanitizedJson(value).toLowerCase().includes("redacted")
}

function containsTruncation(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsTruncation)
  const record = asRecord(value)
  if (!record) return typeof value === "string" && /truncat/i.test(value)
  return Object.entries(record).some(([key, entry]) => {
    if (/truncat/i.test(key) && entry !== false && entry !== null && entry !== undefined) return true
    return containsTruncation(entry)
  })
}

export function previewForValue(value: unknown, maxChars = DEFAULT_PREVIEW_CHARS): string | null {
  if (!hasRenderableValue(value)) return null
  const text = typeof value === "string" ? sanitizeDisplayString(value) : formatSanitizedJson(value)
  const normalized = text.replace(/\s+/g, " ").trim()
  if (!normalized) return null
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars - 1).trimEnd()}…` : normalized
}

export function sanitizeDisplayString(value: string): string {
  const trimmed = value.trim()
  if (/^[{[]/.test(trimmed)) {
    try {
      return formatSanitizedJson(JSON.parse(trimmed))
    } catch {
      // Fall through to lexical redaction for malformed JSON-like output.
    }
  }

  return redactSensitiveStringFragments(value)
}

function redactSensitiveStringFragments(value: string): string {
  const unicodeNormalized = decodeJsonUnicodeEscapes(value)
  const text = PROMPT_CACHE_FIELD_PATTERN.test(unicodeNormalized) ? unicodeNormalized : value

  return text
    .replace(PROMPT_CACHE_FIELD_ASSIGNMENT_TAIL_PATTERN, "$1[redacted prompt-cache value]")
    .replace(PROMPT_CACHE_FIELD_TOKEN_TAIL_PATTERN, "$1[redacted prompt-cache value]")
    .replace(PROMPT_CACHE_TOKEN_PATTERN, "[redacted prompt-cache value]")
}

function decodeJsonUnicodeEscapes(value: string): string {
  return value.replace(/\\+u([0-9a-fA-F]{4})/g, (_match, hex: string) => {
    return String.fromCharCode(Number.parseInt(hex, 16))
  })
}

export function formatSanitizedJson(value: unknown): string {
  try {
    return JSON.stringify(redactKnownSensitiveJson(value), null, 2) ?? "null"
  } catch {
    return '"[unserializable value hidden]"'
  }
}

export function redactKnownSensitiveJson(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return sanitizeDisplayString(value)
  if (Array.isArray(value)) return value.map((entry) => redactKnownSensitiveJson(entry, seen))
  if (typeof value !== "object" || value === null) return value
  if (seen.has(value)) return "[circular]"
  seen.add(value)

  const output: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = decodeJsonUnicodeEscapes(key)
    output[key] = PROMPT_CACHE_FIELD_PATTERN.test(normalizedKey)
      ? "[redacted prompt-cache value]"
      : redactKnownSensitiveJson(entry, seen)
  }
  return output
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) return sanitizeDisplayString(value)
    if (typeof value === "number" && Number.isFinite(value)) return String(value)
  }
  return null
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | null {
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

function humanize(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function shortId(value: string): string {
  return value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-4)}` : value
}

function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat(undefined, {maximumFractionDigits: 0}).format(value)
}

function formatByteLabel(value: number): string {
  if (value < 1024) return `${formatCompactNumber(value)} B`
  const units = ["KB", "MB", "GB", "TB"]
  let size = value / 1024
  let index = 0
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index += 1
  }
  return `${new Intl.NumberFormat(undefined, {maximumFractionDigits: size >= 10 ? 0 : 1}).format(size)} ${units[index]}`
}

function isPresent<T>(value: T | null | undefined | false): value is T {
  return Boolean(value)
}
