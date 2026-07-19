import type {AssistantMessage, Message, ThinkingLevel, ToolCall, ToolResultMessage,} from "@earendil-works/pi-ai";

import type {Agent} from "./agent.js";
import {
  ContextWindowExceededError,
  InvalidJSONResponseError,
  InvalidSchemaResponseError,
  MaxTurnsReachedError,
  ProviderRuntimeError,
  type ProviderRuntimeFailureKind,
  ToolError,
} from "./exceptions.js";
import {stringifyUnknown} from "./helpers/stringify.js";
import {estimateTokensFromString, type TokenCounter} from "./helpers/token-count.js";
import {gatherContextsForRuntime, type LlmContext} from "./llm-context.js";
import {appendPromptCacheKeyParts} from "./prompt-cache-key.js";
import type {Hook} from "./hook.js";
import {
  buildConversationContext,
  buildToolResultMessage,
  collectAssistantToolCalls,
} from "../../integrations/providers/shared/messages.js";
import {isCompactSummaryMessage} from "./helpers/compact.js";
import {joinMessageTextParts} from "./helpers/message-text.js";
import {PiAiRuntime} from "../../integrations/providers/shared/runtime.js";
import {type ResolvedModelSelector, resolveModelSelector,} from "../models/model-selector.js";
import {resolveRuntimeDefaultModelSelector} from "../models/default-model.js";
import {resolveModelRuntimeBudget} from "../models/model-context-policy.js";
import {RunContext} from "./run-context.js";
import type {LlmModelCallTracer, LlmRuntime, LlmRuntimeRequest} from "./runtime.js";
import type {RunPipeline} from "./run-pipeline.js";
import type {ThreadCheckpointDecision, ThreadCheckpointHandler} from "./thread-checkpoint.js";
import {isToolResultPayload} from "./tool.js";
import type {JsonValue, ThreadRunEvent, ThreadStreamEvent, ToolProgressEvent, ToolResultContent,} from "./types.js";
import {buildReplaySegments, trimReplaySegmentsToBudget,} from "../transcript/replay-segments.js";
import {estimateVisibleMessageTokens} from "../transcript/token-estimation.js";
import {isRecord} from "../../lib/records.js";

export interface ThreadOptions<TContext = unknown, TOutput = unknown> {
  agent: Agent<TOutput>;
  messages?: ReadonlyArray<Message>;
  systemPrompt?: string | ReadonlyArray<string>;
  maxTurns?: number;
  context?: TContext;
  llmContexts?: ReadonlyArray<LlmContext>;
  hooks?: ReadonlyArray<Hook<TContext>>;
  promptCacheKey?: string;
  runPipelines?: ReadonlyArray<RunPipeline<TContext>>;
  model?: string;
  temperature?: number;
  thinking?: ThinkingLevel;
  runtime?: LlmRuntime;
  modelCallTracer?: LlmModelCallTracer;
  countTokens?: TokenCounter;
  signal?: AbortSignal;
  checkpoint?: ThreadCheckpointHandler;
  resumeState?: ThreadResumeState;
}

export interface ThreadResumeState {
  turnCount: number;
  thinking?: ThinkingLevel;
}

export interface ThreadStepResult {
  needsAnotherTurn: boolean;
  resumeState: ThreadResumeState;
}

const runThreadStepSymbol = Symbol("runThreadStep");

// Internal scheduler seam for the runtime coordinator; keep it off the package root.
export async function* runThreadStep<TContext = unknown, TOutput = unknown>(
  thread: Thread<TContext, TOutput>,
): AsyncGenerator<ThreadRunEvent, ThreadStepResult> {
  return yield* thread[runThreadStepSymbol]();
}

function stringifyJson(value: JsonValue): string {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value);
}

function readContextStringField(context: unknown, key: string): string | undefined {
  if (!isRecord(context)) {
    return undefined;
  }

  const value = context[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readContextIntegerField(context: unknown, key: string): number | undefined {
  if (!isRecord(context)) {
    return undefined;
  }

  const value = context[key];
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal) {
    return;
  }

  if (typeof signal.throwIfAborted === "function") {
    signal.throwIfAborted();
    return;
  }

  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("The operation was aborted.");
  }
}

function estimateRuntimeRequestTokens(
  request: LlmRuntimeRequest,
  estimateTextTokens: TokenCounter,
): number {
  const context = request.context;
  const systemPromptTokens = context.systemPrompt ? estimateTextTokens(context.systemPrompt) : 0;
  const messageTokens = context.messages.reduce(
    (total, message) => total + estimateVisibleMessageTokens(message, estimateTextTokens),
    0,
  );
  const toolTokens = context.tools?.length
    ? estimateTextTokens(JSON.stringify(context.tools))
    : 0;

  return systemPromptTokens + messageTokens + toolTokens;
}

function buildRuntimeRequestMetadata(
  context: unknown,
  turn: number,
): LlmRuntimeRequest["metadata"] {
  return {
    runId: readContextStringField(context, "runId"),
    threadId: readContextStringField(context, "threadId"),
    sessionId: readContextStringField(context, "sessionId"),
    agentKey: readContextStringField(context, "agentKey"),
    subagentDepth: readContextIntegerField(context, "subagentDepth"),
    turn,
  };
}

function extractMessageText(message: AssistantMessage): string {
  const text = joinMessageTextParts(message.content, "");

  if (!text) {
    throw new InvalidJSONResponseError("No textual content found in output item");
  }

  return text;
}

function formatToolErrorText(message: string, details?: JsonValue): string {
  if (details === undefined) {
    return message;
  }

  const serializedDetails = stringifyJson(details);
  if (!serializedDetails || serializedDetails === message) {
    return message;
  }

  return `${message}\n\n${serializedDetails}`;
}

function textToolResultContent(text: string): ToolResultContent {
  return [{ type: "text", text }];
}

function isAssistantMessage(event: ThreadRunEvent): event is AssistantMessage {
  return "role" in event && event.role === "assistant";
}

const PROVIDER_ERROR_DETAIL_MAX_CHARS = 800;
const MODEL_CALL_MAX_ATTEMPTS = 3;
const MODEL_CALL_RETRY_BASE_DELAY_MS = 1_000;

function fallbackProviderFailureMessage(stopReason?: string): string {
  return stopReason === "aborted" ? "Provider request was aborted." : "Streaming failed";
}

function truncateProviderErrorDetail(value: string): string {
  if (value.length <= PROVIDER_ERROR_DETAIL_MAX_CHARS) {
    return value;
  }

  return `${value.slice(0, PROVIDER_ERROR_DETAIL_MAX_CHARS)}... [truncated ${value.length - PROVIDER_ERROR_DETAIL_MAX_CHARS} chars]`;
}

function sanitizeProviderErrorDetail(value: string, stopReason?: string): string {
  const normalized = value.replace(/\s+/g, " ").trim() || fallbackProviderFailureMessage(stopReason);
  return truncateProviderErrorDetail(normalized);
}

interface ProviderFailureDetails {
  rawMessage: string;
  providerMessage: string;
  status?: number;
  requestId?: string;
  providerCode?: string;
  providerType?: string;
}

function readErrorStringField(error: unknown, keys: readonly string[]): string | undefined {
  if (!isRecord(error)) {
    return undefined;
  }

  for (const key of keys) {
    const value = error[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

function readErrorNumberField(error: unknown, keys: readonly string[]): number | undefined {
  if (!isRecord(error)) {
    return undefined;
  }

  for (const key of keys) {
    const value = error[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }

  return undefined;
}

function readErrorStringFieldFromSources(
  sources: readonly unknown[],
  keys: readonly string[],
): string | undefined {
  for (const source of sources) {
    const value = readErrorStringField(source, keys);
    if (value) {
      return value;
    }
  }

  return undefined;
}

function readErrorNumberFieldFromSources(
  sources: readonly unknown[],
  keys: readonly string[],
): number | undefined {
  for (const source of sources) {
    const value = readErrorNumberField(source, keys);
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

function readNestedProviderError(error: unknown): unknown {
  if (!isRecord(error)) {
    return undefined;
  }

  return isRecord(error.error) ? error.error : undefined;
}

function parseProviderErrorJson(rawMessage: string): unknown {
  const trimmed = rawMessage.trim();
  if (!trimmed) {
    return undefined;
  }

  const candidates = [trimmed];
  const objectStart = trimmed.indexOf("{");
  const objectEnd = trimmed.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    candidates.push(trimmed.slice(objectStart, objectEnd + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (isRecord(parsed)) {
        return parsed;
      }
    } catch {
      // Provider messages are often plain text. Ignore non-JSON details.
    }
  }

  return undefined;
}

function buildProviderFailureDetails(
  error: unknown,
  stopReason?: string,
): ProviderFailureDetails {
  const rawMessage = typeof error === "string"
    ? error
    : stringifyUnknown(error, { preferErrorMessage: true });
  const parsedError = parseProviderErrorJson(rawMessage);
  const nestedError = readNestedProviderError(error);
  const nestedParsedError = readNestedProviderError(parsedError);
  const messageSources = [
    nestedError,
    nestedParsedError,
    error,
    parsedError,
  ];
  const metadataSources = [
    error,
    parsedError,
    nestedError,
    nestedParsedError,
  ];

  return {
    rawMessage,
    providerMessage: sanitizeProviderErrorDetail(
      readErrorStringFieldFromSources(messageSources, ["message"]) ?? rawMessage,
      stopReason,
    ),
    status: readErrorNumberFieldFromSources(metadataSources, ["status", "statusCode"]),
    requestId: readErrorStringFieldFromSources(metadataSources, ["requestID", "requestId", "request_id"]),
    providerCode: readErrorStringFieldFromSources(messageSources, ["code"]),
    providerType: readErrorStringFieldFromSources(messageSources, ["type"]),
  };
}

function providerFailureSignalText(input: {
  message: string;
  providerCode?: string;
  providerType?: string;
}): string {
  return [input.message, input.providerCode, input.providerType]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase();
}

function hasProviderFailureDenySignal(input: {
  message: string;
  status?: number;
  providerCode?: string;
  providerType?: string;
}): boolean {
  const status = input.status === undefined ? undefined : Math.trunc(input.status);
  if (status !== undefined && status >= 400 && status <= 499) {
    return true;
  }

  const text = providerFailureSignalText(input);
  return /unsupported unicode escape sequence/.test(text)
    || /(?:^|[^0-9])4\d{2}(?:[^0-9]|$)/.test(text)
    || /\b(?:rate[\s_-]*limit|too many requests|quota exceeded|insufficient quota|throttl(?:e|ed|ing))\b/.test(text)
    || /\b(?:execution environment|container|runner|sandbox)\b.*\b(?:failed|exited|stopped|terminated|destroyed|unavailable|not found|lifecycle)\b/.test(text)
    || /\b(?:failed|exited|stopped|terminated|destroyed|unavailable|not found|lifecycle)\b.*\b(?:execution environment|container|runner|sandbox)\b/.test(text)
    || /\b(?:authentication|authorization|credential|api[\s_-]*key|permission)\b.{0,120}\b(?:failed|invalid|denied|missing|expired|unauthorized|forbidden)\b/.test(text)
    || /\b(?:failed|invalid|denied|missing|expired|unauthorized|forbidden)\b.{0,20}\b(?:authentication|authorization|credential|api[\s_-]*key|permission)\b/.test(text)
    || /\b(?:unauthorized|forbidden|permission denied|access denied)\b/.test(text)
    || /\bbad request\b/.test(text)
    || /\b(?:invalid|malformed)\s+(?:request|input|argument|arguments|payload|parameter|parameters)\b/.test(text)
    || /\b(?:request|input|argument|arguments|payload|parameter|parameters)\s+(?:is\s+)?(?:invalid|malformed)\b/.test(text)
    || /\b(?:context window|context length|token limit|maximum context|too many tokens|prompt too long)\b/.test(text);
}

function hasProviderServerErrorSignal(input: {
  message: string;
  status?: number;
  providerCode?: string;
  providerType?: string;
}): boolean {
  const status = input.status === undefined ? undefined : Math.trunc(input.status);
  if (status !== undefined && status >= 500 && status <= 599) {
    return true;
  }

  const text = providerFailureSignalText(input);
  return /(^|[^a-z0-9])(?:internal[_-])?server[_-]error([^a-z0-9]|$)/.test(text)
    || /\binternal[\s_-]+server[\s_-]+error\b/.test(text)
    || /\bserver\s+(?:had|encountered)\s+an\s+error\b/.test(text)
    || /\b(?:overload(?:ed)?|service[\s_-]+unavailable)\b/.test(text)
    || /\b(?:you can retry(?: your request)?|retry your request|try again later)\b/.test(text);
}

function hasProviderAbortSignal(input: {
  message: string;
  stopReason?: string;
  signal?: AbortSignal;
}): boolean {
  const message = input.message.toLowerCase();
  return input.stopReason === "aborted"
    || input.signal?.aborted === true
    || /\baborterror\b/.test(message)
    || /\b(?:request|operation)\s+(?:was\s+)?aborted\b/.test(message)
    || /\b(?:cancelled|canceled|cancellation)\b/.test(message);
}

function classifyProviderRuntimeFailure(input: {
  message: string;
  stopReason?: string;
  signal?: AbortSignal;
  status?: number;
  providerCode?: string;
  providerType?: string;
}): ProviderRuntimeFailureKind {
  const message = input.message.toLowerCase();

  if (hasProviderAbortSignal(input)) {
    return "provider_abort";
  }

  if (hasProviderFailureDenySignal(input)) {
    return "provider_error";
  }

  if (hasProviderServerErrorSignal(input)) {
    return "provider_server_error";
  }

  if (/\b(timed out|timeout|etimedout|und_err_connect_timeout)\b/.test(message)) {
    return "provider_timeout";
  }

  if (/\b(?:terminated|premature(?:ly)? terminated|premature termination)\b/.test(message)) {
    return "provider_transport_terminated";
  }

  if (/\b(?:websocket|fetch failed|socket|econnreset|econnrefused|econnaborted|enotfound|epipe|network|connection reset|connection closed|connection aborted|connection refused|connect failed|failed to connect|premature close|und_err_socket)\b/.test(message)) {
    return "provider_transport_network";
  }

  return "provider_error";
}

function isRetryableProviderRuntimeFailure(failureKind?: ProviderRuntimeFailureKind): boolean {
  return failureKind === "provider_timeout"
    || failureKind === "provider_server_error"
    || failureKind === "provider_transport_terminated"
    || failureKind === "provider_transport_network";
}

function isRetryableProviderRuntimeError(
  error: ProviderRuntimeError,
  request: LlmRuntimeRequest,
): boolean {
  const message = [error.providerMessage, error.message]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ");
  const classificationInput = {
    message,
    stopReason: error.stopReason,
    signal: request.signal,
    status: error.status,
  };
  if (error.failureKind === "provider_abort"
    || hasProviderAbortSignal(classificationInput)
    || hasProviderFailureDenySignal(classificationInput)) {
    return false;
  }

  return isRetryableProviderRuntimeFailure(classifyProviderRuntimeFailure(classificationInput))
    || isRetryableProviderRuntimeFailure(error.failureKind);
}

function calculateModelCallRetryDelay(retryOrdinal: number): number {
  const ceiling = MODEL_CALL_RETRY_BASE_DELAY_MS * (2 ** (retryOrdinal - 1));
  return Math.floor((ceiling / 2) + (Math.random() * ceiling / 2));
}

async function waitForModelCallRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);

  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      signal?.removeEventListener("abort", onAbort);
      try {
        throwIfAborted(signal);
      } catch (error) {
        reject(error);
      }
    };

    signal?.addEventListener("abort", onAbort, {once: true});
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);

    if (signal?.aborted) {
      onAbort();
    }
  });

  throwIfAborted(signal);
}

function warnModelCallRetry(input: {
  error: ProviderRuntimeError;
  request: LlmRuntimeRequest;
  attempt: number;
  delayMs: number;
}): void {
  console.warn("Retrying transient provider model call.", {
    provider: input.request.providerName,
    model: input.request.modelId,
    failureKind: input.error.failureKind,
    ...(input.error.status !== undefined && Number.isFinite(input.error.status)
      ? {status: input.error.status}
      : {}),
    attempt: input.attempt,
    maxAttempts: MODEL_CALL_MAX_ATTEMPTS,
    delayMs: input.delayMs,
    runId: input.request.metadata?.runId,
    threadId: input.request.metadata?.threadId,
    turn: input.request.metadata?.turn,
  });
}

function withRetryExhaustion(
  error: ProviderRuntimeError,
  request: LlmRuntimeRequest,
  attempts: number,
): ProviderRuntimeError {
  const failureKind = error.failureKind ?? "provider_error";
  const status = typeof error.status === "number" && Number.isFinite(error.status)
    ? Math.trunc(error.status)
    : undefined;
  const stopReason = error.stopReason === "error" || error.stopReason === "aborted"
    ? error.stopReason
    : undefined;
  const baseMessage = formatProviderRuntimeErrorMessage({
    request,
    stopReason,
    failureKind,
    status,
    retryable: true,
  });
  return new ProviderRuntimeError(
    `${baseMessage.slice(0, -1)}; attempts=${attempts}; maxAttempts=${MODEL_CALL_MAX_ATTEMPTS}; retryExhausted=true.`,
    {
      providerName: request.providerName,
      modelId: request.modelId,
      status,
      durationMs: error.durationMs,
      timedOut: error.timedOut,
      retryable: true,
      stopReason,
      failureKind,
    },
  );
}

function formatProviderRuntimeErrorMessage(input: {
  request: LlmRuntimeRequest;
  stopReason?: string;
  failureKind: ProviderRuntimeFailureKind;
  providerMessage?: string;
  status?: number;
  requestId?: string;
  retryable?: boolean;
}): string {
  const parts = [
    "Provider runtime failed",
    `provider=${input.request.providerName}`,
    `model=${input.request.modelId}`,
    ...(input.stopReason ? [`stopReason=${input.stopReason}`] : []),
    `failureKind=${input.failureKind}`,
    ...(input.retryable ? ["retryable=true"] : []),
    ...(input.status !== undefined ? [`status=${input.status}`] : []),
    ...(input.requestId ? [`requestId=${sanitizeProviderErrorDetail(input.requestId)}`] : []),
    ...(input.providerMessage ? [`detail=${input.providerMessage}`] : []),
  ];

  return `${parts.join("; ")}.`;
}

function buildProviderRuntimeError(input: {
  request: LlmRuntimeRequest;
  providerMessage: string;
  failureKind: ProviderRuntimeFailureKind;
  startedAt: number;
  stopReason?: string;
  status?: number;
  requestId?: string;
  retryable?: boolean;
  cause?: unknown;
}): ProviderRuntimeError {
  const retryable = input.retryable ?? isRetryableProviderRuntimeFailure(input.failureKind);
  return new ProviderRuntimeError(formatProviderRuntimeErrorMessage({
    ...input,
    retryable,
  }), {
    providerName: input.request.providerName,
    modelId: input.request.modelId,
    status: input.status,
    requestId: input.requestId,
    durationMs: Math.max(0, Date.now() - input.startedAt),
    timedOut: input.failureKind === "provider_timeout",
    retryable,
    stopReason: input.stopReason,
    failureKind: input.failureKind,
    providerMessage: input.providerMessage,
    cause: input.cause,
  });
}

function wrapClassifiedProviderFailure(
  error: unknown,
  request: LlmRuntimeRequest,
  startedAt: number,
): ProviderRuntimeError | null {
  if (error instanceof ProviderRuntimeError) {
    return error;
  }

  const details = buildProviderFailureDetails(error);
  const failureKind = classifyProviderRuntimeFailure({
    message: details.rawMessage,
    signal: request.signal,
    status: details.status,
    providerCode: details.providerCode,
    providerType: details.providerType,
  });
  if (failureKind === "provider_error") {
    return null;
  }

  return buildProviderRuntimeError({
    request,
    providerMessage: details.providerMessage,
    failureKind,
    startedAt,
    status: details.status,
    requestId: details.requestId,
    cause: error,
  });
}

function throwIfAssistantResponseFailed(
  response: AssistantMessage,
  request: LlmRuntimeRequest,
  startedAt: number,
): void {
  if (response.stopReason !== "error" && response.stopReason !== "aborted") {
    return;
  }

  const details = buildProviderFailureDetails(
    response.errorMessage ?? fallbackProviderFailureMessage(response.stopReason),
    response.stopReason,
  );
  const failureKind = classifyProviderRuntimeFailure({
    message: details.rawMessage,
    stopReason: response.stopReason,
    signal: request.signal,
    status: details.status,
    providerCode: details.providerCode,
    providerType: details.providerType,
  });

  throw buildProviderRuntimeError({
    request,
    providerMessage: details.providerMessage,
    failureKind,
    startedAt,
    stopReason: response.stopReason,
    status: details.status,
    requestId: details.requestId,
  });
}

export class Thread<TContext = unknown, TOutput = unknown> {
  readonly agent: Agent<TOutput>;
  readonly maxTurns: number;
  readonly context?: TContext;
  readonly llmContexts?: ReadonlyArray<LlmContext>;
  readonly hooks?: ReadonlyArray<Hook<TContext>>;
  turnCount = 0;
  readonly promptCacheKey?: string;
  readonly runPipelines?: ReadonlyArray<RunPipeline<TContext>>;
  readonly systemPrompt?: string | ReadonlyArray<string>;
  readonly model: string;
  readonly temperature?: number;

  private readonly modelSelection: ResolvedModelSelector;
  private readonly runtime: LlmRuntime;
  private readonly modelCallTracer?: LlmModelCallTracer;
  private readonly countTokens: TokenCounter;
  private readonly contextWindowTokens: number;
  private readonly history: Message[];
  private readonly signal?: AbortSignal;
  private readonly checkpoint?: ThreadCheckpointHandler;
  private readonly defaultThinking?: ThinkingLevel;
  private effectiveThinking?: ThinkingLevel;
  private thinkingScopeDepth = 0;
  private preserveThinkingOnNextScopeEntry: boolean;

  constructor(options: ThreadOptions<TContext, TOutput>) {
    this.agent = options.agent;
    this.maxTurns = options.maxTurns ?? 300;
    this.turnCount = options.resumeState?.turnCount ?? 0;
    this.history = [...(options.messages ?? [])];
    this.systemPrompt = options.systemPrompt;
    this.context = options.context;
    this.llmContexts = options.llmContexts;
    this.hooks = options.hooks;
    this.promptCacheKey = options.promptCacheKey;
    this.runPipelines = options.runPipelines;
    const defaultModel = resolveRuntimeDefaultModelSelector();
    this.modelSelection = resolveModelSelector(options.model ?? defaultModel);
    this.model = this.modelSelection.canonical;
    this.contextWindowTokens = resolveModelRuntimeBudget(this.model).operatingWindow;
    this.temperature = options.temperature;
    this.defaultThinking = options.thinking;
    this.effectiveThinking = options.resumeState?.thinking ?? options.thinking;
    this.preserveThinkingOnNextScopeEntry = options.resumeState !== undefined;
    this.runtime = options.runtime ?? new PiAiRuntime();
    this.modelCallTracer = options.modelCallTracer;
    this.countTokens = options.countTokens ?? estimateTokensFromString;
    this.signal = options.signal;
    this.checkpoint = options.checkpoint;
  }

  get thinking(): ThinkingLevel | undefined {
    return this.effectiveThinking;
  }

  get messages(): readonly Message[] {
    return this.history;
  }

  addMessage(message: Message): void {
    this.history.push(message);
  }

  createRunContext(runMessages: Message[]): RunContext<TContext> {
    return new RunContext({
      agent: this.agent,
      turn: this.turnCount,
      maxTurns: this.maxTurns,
      messages: runMessages,
      context: this.context,
      signal: this.signal,
      getThinking: () => this.effectiveThinking,
      setThinking: (next) => {
        this.effectiveThinking = next;
      },
    });
  }

  private resolveCheckpointDecision(
    decision?: ThreadCheckpointDecision | void,
  ): ThreadCheckpointDecision {
    return decision ?? { action: "continue" };
  }

  private resetThinking(): void {
    this.effectiveThinking = this.defaultThinking;
  }

  private snapshotResumeState(): ThreadResumeState {
    return {
      turnCount: this.turnCount,
      thinking: this.effectiveThinking,
    };
  }

  private buildStepResult(needsAnotherTurn: boolean): ThreadStepResult {
    return {
      needsAnotherTurn,
      resumeState: this.snapshotResumeState(),
    };
  }

  private beginThinkingScope(): boolean {
    const isTopLevelScope = this.thinkingScopeDepth === 0;
    if (isTopLevelScope) {
      if (this.preserveThinkingOnNextScopeEntry) {
        this.preserveThinkingOnNextScopeEntry = false;
      } else {
        this.resetThinking();
      }
    }

    this.thinkingScopeDepth += 1;
    return isTopLevelScope;
  }

  private endThinkingScope(isTopLevelScope: boolean): void {
    this.thinkingScopeDepth = Math.max(0, this.thinkingScopeDepth - 1);
    if (isTopLevelScope) {
      this.resetThinking();
    }
  }

  private buildCancelledToolResultMessage(
    toolCall: ToolCall,
    reason?: string,
  ): ToolResultMessage<JsonValue> {
    return buildToolResultMessage({
      toolCall,
      content: textToolResultContent(reason ?? "Tool call cancelled before execution."),
      isError: true,
      details: reason ? { cancelled: true, reason } : { cancelled: true },
    });
  }

  private async *emitCancelledToolResults(
    toolCalls: readonly ToolCall[],
    runContext: RunContext<TContext>,
    reason?: string,
  ): AsyncGenerator<ToolResultMessage<JsonValue>> {
    for (const toolCall of toolCalls) {
      const cancelledResult = this.buildCancelledToolResultMessage(toolCall, reason);
      this.addMessage(cancelledResult);
      runContext.messages.push(cancelledResult);
      yield cancelledResult;
    }
  }

  private async prepareTurn(): Promise<{
    runMessages: Message[];
    runContext: RunContext<TContext>;
  }> {
    throwIfAborted(this.signal);
    this.verifyMaxTurns();

    if (this.runPipelines?.length) {
      await Promise.all(this.runPipelines.map((pipeline) => pipeline.preflight(this)));
    }

    const runMessages = await this.getRunInput();
    const runContext = this.createRunContext([...runMessages]);

    if (this.hooks?.length) {
      await Promise.all(this.hooks.map((hook) => hook.onStart(runContext)));
    }

    return {
      runMessages,
      runContext,
    };
  }

  private async finalizeAssistantTurn(
    response: AssistantMessage,
    runContext: RunContext<TContext>,
  ): Promise<ToolCall[]> {
    this.addMessage(response);
    runContext.messages.push(response);

    if (this.hooks?.length) {
      await Promise.all(this.hooks.map((hook) => hook.onEnd(runContext, response)));
    }

    if (this.runPipelines?.length) {
      await Promise.all(this.runPipelines.map((pipeline) => pipeline.postflight(this, response)));
    }

    return collectAssistantToolCalls(response);
  }

  async *executeToolCalls(
    functionCalls: ToolCall[],
    runContext: RunContext<TContext>,
  ): AsyncGenerator<ToolProgressEvent | ToolResultMessage<JsonValue>, boolean> {
    for (const [index, call] of functionCalls.entries()) {
      const progressQueue: ToolProgressEvent[] = [];
      let wakeProgressWaiter: (() => void) | undefined;

      const toolRunContext = new RunContext({
        agent: runContext.agent,
        toolCallId: call.id,
        turn: runContext.turn,
        maxTurns: runContext.maxTurns,
        messages: runContext.messages,
        context: runContext.context,
        signal: this.signal,
        getThinking: () => this.effectiveThinking,
        setThinking: (next) => {
          this.effectiveThinking = next;
        },
        onToolProgress: (progress) => {
          progressQueue.push({
            type: "tool_progress",
            toolCallId: call.id,
            toolName: call.name,
            details: progress,
            timestamp: Date.now(),
          });

          wakeProgressWaiter?.();
          wakeProgressWaiter = undefined;
        },
      });

      throwIfAborted(this.signal);

      let response: ToolResultMessage<JsonValue> | undefined;
      let toolError: unknown;
      let toolCompleted = false;

      const toolPromise = this.callTool(call, toolRunContext)
        .then((toolResultMessage) => {
          response = toolResultMessage;
        })
        .catch((error) => {
          toolError = error;
        })
        .finally(() => {
          toolCompleted = true;
          wakeProgressWaiter?.();
          wakeProgressWaiter = undefined;
        });

      while (!toolCompleted || progressQueue.length > 0) {
        if (progressQueue.length > 0) {
          const progressEvent = progressQueue.shift();
          if (progressEvent) {
            yield progressEvent;
          }
          continue;
        }

        await new Promise<void>((resolve) => {
          wakeProgressWaiter = resolve;
        });
      }

      await toolPromise;
      throwIfAborted(this.signal);

      if (toolError) {
        throw toolError;
      }

      if (!response) {
        continue;
      }

      this.addMessage(response);
      runContext.messages.push(response);
      yield response;

      if (this.checkpoint) {
        const remainingToolCalls = functionCalls.slice(index + 1);
        const decision = this.resolveCheckpointDecision(await this.checkpoint({
          phase: "after_tool_result",
          runContext,
          toolCall: call,
          toolResult: response,
          remainingToolCalls,
        }));

        if (decision.action === "interrupt") {
          if (decision.cancelPendingToolCalls !== false) {
            yield* this.emitCancelledToolResults(remainingToolCalls, runContext, decision.reason);
          }

          return false;
        }
      }
    }

    return true;
  }

  async getRunInput(): Promise<Message[]> {
    const firstMessage = this.history[0];
    const pinnedMessage = firstMessage && isCompactSummaryMessage(firstMessage)
      ? firstMessage
      : null;
    const historyOffset = pinnedMessage ? 1 : 0;
    const segments = buildReplaySegments(this.history.slice(historyOffset));
    const malformedSegments = segments.filter((segment) => segment.issues.length > 0);

    if (malformedSegments.length > 0) {
      console.warn("Replay transcript contained malformed tool segments; keeping best-effort atomic groups.", {
        issues: malformedSegments.map((segment) => ({
          kind: segment.kind,
          startIndex: segment.startIndex + historyOffset,
          endIndex: segment.endIndex + historyOffset,
          issues: segment.issues,
        })),
      });
    }

    return trimReplaySegmentsToBudget({
      ...(pinnedMessage ? {pinnedMessage} : {}),
      segments,
      budgetTokens: this.contextWindowTokens,
      estimateMessageTokens: (message) => estimateVisibleMessageTokens(message, this.countTokens),
      keepNewestOversizedSegment: true,
    });
  }

  async parseStructuredOutput(output: AssistantMessage): Promise<TOutput> {
    const text = extractMessageText(output);

    try {
      const parsed = JSON.parse(text);
      if (!this.agent.outputSchema) {
        return parsed as TOutput;
      }

      return await this.agent.outputSchema.parseAsync(parsed);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new InvalidJSONResponseError(error.message);
      }

      throw new InvalidSchemaResponseError(stringifyUnknown(error));
    }
  }

  async callTool(
    toolCall: ToolCall,
    runContext: RunContext<TContext>,
  ): Promise<ToolResultMessage<JsonValue>> {
    throwIfAborted(this.signal);
    const tool = this.agent.tools.find((candidate) => candidate.name === toolCall.name);

    if (!tool) {
      return buildToolResultMessage({
        toolCall,
        content: textToolResultContent(`No tool found with name ${toolCall.name}`),
        isError: true,
      });
    }

    try {
      const output = await tool.run(toolCall.arguments ?? {}, runContext);
      if (isToolResultPayload(output)) {
        return buildToolResultMessage({
          toolCall,
          content: output.content,
          isError: false,
          details: output.details,
        });
      }

      return buildToolResultMessage({
        toolCall,
        content: textToolResultContent(stringifyJson(output)),
        isError: false,
        details: output,
      });
    } catch (error) {
      if (error instanceof ToolError) {
        return buildToolResultMessage({
          toolCall,
          content: error.content ?? textToolResultContent(formatToolErrorText(error.message, error.details)),
          isError: true,
          details: error.details,
        });
      }

      throw error;
    }
  }

  verifyMaxTurns(): void {
    if (this.turnCount >= this.maxTurns) {
      throw new MaxTurnsReachedError();
    }

    this.turnCount += 1;
  }

  private async buildRuntimeRequest(runMessages: Message[]): Promise<LlmRuntimeRequest> {
    const llmContextRuntimeDump = this.llmContexts?.length
      ? await gatherContextsForRuntime([...this.llmContexts])
      : undefined;

    return {
      providerName: this.modelSelection.providerName,
      modelId: this.modelSelection.modelId,
      temperature: this.temperature,
      thinking: this.effectiveThinking,
      promptCacheKey: appendPromptCacheKeyParts(
        this.promptCacheKey,
        "ctx",
        llmContextRuntimeDump?.promptCacheKeyParts ?? [],
      ),
      signal: this.signal,
      metadata: buildRuntimeRequestMetadata(this.context, this.turnCount),
      trace: llmContextRuntimeDump
        ? {
            llmContextDump: llmContextRuntimeDump.dump,
            llmContextSections: llmContextRuntimeDump.sections,
          }
        : undefined,
      context: buildConversationContext({
        agent: this.agent,
        messages: runMessages,
        systemPrompt: this.systemPrompt,
        llmContextDump: llmContextRuntimeDump?.dump,
      }),
    };
  }

  private assertRuntimeRequestWithinHardWindow(request: LlmRuntimeRequest): void {
    const hardWindow = resolveModelRuntimeBudget(this.model).hardWindow;
    const estimatedTokens = estimateRuntimeRequestTokens(request, this.countTokens);
    if (estimatedTokens >= hardWindow) {
      throw new ContextWindowExceededError();
    }
  }

  private async recordModelCallTrace(input: {
    mode: "complete" | "stream";
    request: LlmRuntimeRequest;
    startedAt: number;
    response?: AssistantMessage;
    error?: unknown;
  }): Promise<void> {
    if (!this.modelCallTracer) {
      return;
    }

    await this.modelCallTracer.recordModelCallTrace({
      mode: input.mode,
      request: input.request,
      tools: this.agent.tools,
      startedAt: input.startedAt,
      finishedAt: Date.now(),
      ...(input.response !== undefined ? {response: input.response} : {}),
      ...(input.error !== undefined ? {error: input.error} : {}),
    });
  }

  private async *runStepWithinScope(): AsyncGenerator<ThreadRunEvent, ThreadStepResult> {
    const { runMessages, runContext } = await this.prepareTurn();

    throwIfAborted(this.signal);
    const request = await this.buildRuntimeRequest(runMessages);
    this.assertRuntimeRequestWithinHardWindow(request);
    let response: AssistantMessage | undefined;
    for (let attempt = 1; attempt <= MODEL_CALL_MAX_ATTEMPTS; attempt += 1) {
      throwIfAborted(this.signal);
      response = undefined;
      const startedAt = Date.now();
      let attemptError: unknown;

      try {
        response = await this.runtime.complete(request);
      } catch (error) {
        attemptError = wrapClassifiedProviderFailure(error, request, startedAt) ?? error;
      }

      if (attemptError === undefined) {
        try {
          throwIfAssistantResponseFailed(response!, request, startedAt);
        } catch (error) {
          attemptError = error;
        }
      }

      if (attemptError === undefined) {
        await this.recordModelCallTrace({mode: "complete", request, startedAt, response: response!});
        break;
      }

      await this.recordModelCallTrace({
        mode: "complete",
        request,
        startedAt,
        ...(response !== undefined ? {response} : {}),
        error: attemptError,
      });
      if (!(attemptError instanceof ProviderRuntimeError)
        || !isRetryableProviderRuntimeError(attemptError, request)) {
        throw attemptError;
      }
      if (attempt === MODEL_CALL_MAX_ATTEMPTS) {
        throw withRetryExhaustion(attemptError, request, attempt);
      }

      throwIfAborted(this.signal);
      const delayMs = calculateModelCallRetryDelay(attempt);
      warnModelCallRetry({error: attemptError, request, attempt: attempt + 1, delayMs});
      await waitForModelCallRetry(delayMs, this.signal);
    }
    if (response === undefined) {
      throw new Error("Provider runtime returned no response.");
    }
    throwIfAborted(this.signal);

    yield response;

    const functionCalls = await this.finalizeAssistantTurn(response, runContext);
    if (functionCalls.length === 0) {
      return this.buildStepResult(false);
    }

    if (this.checkpoint) {
      const decision = this.resolveCheckpointDecision(await this.checkpoint({
        phase: "after_assistant",
        runContext,
        assistantMessage: response,
        toolCalls: functionCalls,
      }));

      if (decision.action === "interrupt") {
        if (decision.cancelPendingToolCalls !== false) {
          yield* this.emitCancelledToolResults(functionCalls, runContext, decision.reason);
        }

        return this.buildStepResult(false);
      }
    }

    const needsAnotherTurn = yield* this.executeToolCalls(functionCalls, runContext);
    return this.buildStepResult(needsAnotherTurn);
  }

  async *[runThreadStepSymbol](): AsyncGenerator<ThreadRunEvent, ThreadStepResult> {
    const isTopLevelScope = this.beginThinkingScope();

    try {
      return yield* this.runStepWithinScope();
    } finally {
      this.endThinkingScope(isTopLevelScope);
    }
  }

  async *run(): AsyncGenerator<ThreadRunEvent> {
    const isTopLevelScope = this.beginThinkingScope();

    try {
      while (true) {
        const stepResult = yield* this.runStepWithinScope();
        if (!stepResult.needsAnotherTurn) {
          return;
        }
      }
    } finally {
      this.endThinkingScope(isTopLevelScope);
    }
  }

  private async *streamStepWithinScope(): AsyncGenerator<ThreadStreamEvent, ThreadStepResult> {
    const { runMessages, runContext } = await this.prepareTurn();

    throwIfAborted(this.signal);
    const request = await this.buildRuntimeRequest(runMessages);
    this.assertRuntimeRequestWithinHardWindow(request);
    let response: AssistantMessage | undefined;
    for (let attempt = 1; attempt <= MODEL_CALL_MAX_ATTEMPTS; attempt += 1) {
      throwIfAborted(this.signal);
      response = undefined;
      const startedAt = Date.now();
      let attemptError: unknown;
      let eventYielded = false;

      try {
        const stream = this.runtime.stream(request);
        for await (const event of stream) {
          // pi-ai represents a pre-start provider failure as the stream's first
          // terminal error event. Keep that event behind Panda's public boundary
          // until the failed result has been classified for retry.
          if (!eventYielded && event.type === "error") {
            continue;
          }
          eventYielded = true;
          yield event;
        }
        response = await stream.result();
      } catch (error) {
        attemptError = wrapClassifiedProviderFailure(error, request, startedAt) ?? error;
      }

      if (attemptError === undefined) {
        try {
          throwIfAssistantResponseFailed(response!, request, startedAt);
        } catch (error) {
          attemptError = error;
        }
      }

      if (attemptError === undefined) {
        await this.recordModelCallTrace({mode: "stream", request, startedAt, response: response!});
        break;
      }

      await this.recordModelCallTrace({
        mode: "stream",
        request,
        startedAt,
        ...(response !== undefined ? {response} : {}),
        error: attemptError,
      });
      if (eventYielded
        || !(attemptError instanceof ProviderRuntimeError)
        || !isRetryableProviderRuntimeError(attemptError, request)) {
        throw attemptError;
      }
      if (attempt === MODEL_CALL_MAX_ATTEMPTS) {
        throw withRetryExhaustion(attemptError, request, attempt);
      }

      throwIfAborted(this.signal);
      const delayMs = calculateModelCallRetryDelay(attempt);
      warnModelCallRetry({error: attemptError, request, attempt: attempt + 1, delayMs});
      await waitForModelCallRetry(delayMs, this.signal);
    }
    if (response === undefined) {
      throw new Error("Provider runtime stream returned no response.");
    }
    throwIfAborted(this.signal);

    const functionCalls = await this.finalizeAssistantTurn(response, runContext);
    if (functionCalls.length === 0) {
      return this.buildStepResult(false);
    }

    if (this.checkpoint) {
      const decision = this.resolveCheckpointDecision(await this.checkpoint({
        phase: "after_assistant",
        runContext,
        assistantMessage: response,
        toolCalls: functionCalls,
      }));

      if (decision.action === "interrupt") {
        if (decision.cancelPendingToolCalls !== false) {
          yield* this.emitCancelledToolResults(functionCalls, runContext, decision.reason);
        }

        return this.buildStepResult(false);
      }
    }

    const needsAnotherTurn = yield* this.executeToolCalls(functionCalls, runContext);
    return this.buildStepResult(needsAnotherTurn);
  }

  async *stream(): AsyncGenerator<ThreadStreamEvent> {
    const isTopLevelScope = this.beginThinkingScope();

    try {
      while (true) {
        const stepResult = yield* this.streamStepWithinScope();
        if (!stepResult.needsAnotherTurn) {
          return;
        }
      }
    } finally {
      this.endThinkingScope(isTopLevelScope);
    }
  }

  async runToCompletion(): Promise<TOutput | ThreadRunEvent | null> {
    let finalOutput: ThreadRunEvent | null = null;

    for await (const output of this.run()) {
      finalOutput = output;
    }

    if (finalOutput && this.agent.outputSchema) {
      if (!isAssistantMessage(finalOutput)) {
        throw new InvalidJSONResponseError("No assistant message found in output item");
      }

      return this.parseStructuredOutput(finalOutput);
    }

    return finalOutput;
  }
}
