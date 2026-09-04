import type {Message, ThinkingLevel} from "@earendil-works/pi-ai";
import type {JsonObject} from "../../lib/json.js";

import {PiAiRuntime} from "../../integrations/providers/shared/runtime.js";
import {formatToolCallFallback, formatToolResultFallback} from "../agent/tool.js";
import {buildCompactSummaryMessage, stripCompactSummaryPrefix} from "../agent/helpers/compact.js";
import {estimateTokensFromString, type TokenCounter} from "../agent/helpers/token-count.js";
import {stringToUserMessage} from "../agent/helpers/input.js";
import {joinMessageTextParts} from "../agent/helpers/message-text.js";
import {resolveModelRuntimeBudget} from "../models/model-context-policy.js";
import {resolveModelSelector} from "../models/model-selector.js";
import {COMPACT_PRESERVED_REQUEST_PREFIX, renderCompactionPrompt} from "../../prompts/runtime/compaction.js";
import {readMissingApiKeyMessage} from "../../integrations/providers/shared/missing-api-key.js";
import type {LlmRuntime} from "../agent/runtime.js";
import {estimateReplayMessageTokens, estimateVisibleMessageTokens} from "./token-estimation.js";
import {isCompactBoundaryRecord} from "./checkpoint.js";
import type {
  AutoCompactionRuntimeState,
  CompactBoundaryMetadata,
  CompactAttemptDiagnostics,
  CompactAttemptOutcome,
  CompactFailureNoticeMetadata,
  ThreadCompactionCommit,
  ThreadMessageRecord,
  ThreadRuntimeMessagePayload,
  ThreadRuntimeState,
  ThreadTranscriptSnapshot,
  TranscriptThreadState,
} from "./types.js";

export type {
  CompactBoundaryMetadata,
  CompactAttemptDiagnostics,
  CompactAttemptOutcome,
  CompactFailureNoticeMetadata,
} from "./types.js";
export {isCompactBoundaryRecord, projectTranscriptForRun} from "./checkpoint.js";

export const DEFAULT_COMPACT_PRESERVED_USER_TURNS = 6;
export const AUTO_COMPACT_BREAKER_FAILURE_THRESHOLD = 2;
export const AUTO_COMPACT_BREAKER_COOLDOWN_MS = 5 * 60_000;
const TOOL_TEXT_LIMIT = 4_000;

export interface CompactTranscriptSplit {
  summaryRecords: readonly ThreadMessageRecord[];
  preservedTail: readonly ThreadMessageRecord[];
  compactedThroughSequence: number;
  preservedRequest?: Extract<Message, {role: "user"}>;
}

export interface CompactThreadOptions {
  store: Pick<{
    loadActiveTranscript(threadId: string): Promise<ThreadTranscriptSnapshot>;
    commitCompaction(
      threadId: string,
      commit: ThreadCompactionCommit,
    ): Promise<ThreadMessageRecord>;
  }, "loadActiveTranscript" | "commitCompaction">;
  thread: Pick<TranscriptThreadState, "id">;
  transcript?: ThreadTranscriptSnapshot;
  model: string;
  thinking?: ThinkingLevel;
  customInstructions?: string;
  trigger: CompactBoundaryMetadata["trigger"];
  operationId?: string;
  owningRunId?: string;
  runtime?: Pick<LlmRuntime, "complete">;
  signal?: AbortSignal;
  /** Agent-requested compaction may cut a long turn between complete tool exchanges. */
  allowPartialTurn?: boolean;
  replayContext?: JsonObject;
  preservedRequest?: Extract<Message, {role: "user"}>;
}

export interface CompactThreadResult {
  record: ThreadMessageRecord;
  summary: string;
  tokensBefore: number;
  tokensAfter: number;
  compactedThroughSequence: number;
  diagnostics: CompactAttemptDiagnostics;
}

export interface AutoCompactCheckResult {
  shouldCompact: boolean;
  cooldownUntil?: number;
}

export interface EstimateTranscriptTokensOptions {
  estimateTextTokens?: TokenCounter;
  replayToolArtifacts?: boolean;
}

export class CompactThreadError extends Error {
  readonly diagnostics: CompactAttemptDiagnostics;

  constructor(message: string, diagnostics: CompactAttemptDiagnostics) {
    super(message);
    this.name = "CompactThreadError";
    this.diagnostics = diagnostics;
  }
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxChars - 12)).trimEnd()}\n[truncated]`;
}

export function splitTranscriptForCompaction(
  transcript: readonly ThreadMessageRecord[],
  preservedUserTurns = DEFAULT_COMPACT_PRESERVED_USER_TURNS,
): CompactTranscriptSplit | null {
  const userMessageIndexes: number[] = [];

  for (const [index, record] of transcript.entries()) {
    if (record.source === "compact") {
      continue;
    }

    if (record.message.role === "user") {
      userMessageIndexes.push(index);
    }
  }

  if (userMessageIndexes.length <= preservedUserTurns) {
    return null;
  }

  const preservedStartIndex = userMessageIndexes[userMessageIndexes.length - preservedUserTurns];
  if (preservedStartIndex === undefined || preservedStartIndex <= 0) {
    return null;
  }

  const summaryRecords = transcript.slice(0, preservedStartIndex);
  const preservedTail = transcript.slice(preservedStartIndex);
  const lastSummarized = summaryRecords[summaryRecords.length - 1];

  if (!lastSummarized) {
    return null;
  }

  return {
    summaryRecords,
    preservedTail,
    compactedThroughSequence: lastSummarized.sequence,
  };
}

/** Keeps recent complete exchanges and carries the latest task request into the checkpoint verbatim. */
function splitLongTurnForCompaction(
  transcript: readonly ThreadMessageRecord[],
  previousRequest?: Extract<Message, {role: "user"}>,
): CompactTranscriptSplit | null {
  const boundaries: number[] = [];
  const pendingCalls = new Set<string>();
  let latestRequest = previousRequest;
  let latestRequestIndex = -1;
  for (const [index, record] of transcript.entries()) {
    if (record.source === "compact") continue;
    const message = record.message;
    if (message.role === "user" && record.origin === "input") {
      latestRequest = message;
      latestRequestIndex = index;
    }
    if (message.role === "assistant") {
      if (pendingCalls.size === 0) boundaries.push(index);
      for (const block of message.content) {
        if (block.type === "toolCall") pendingCalls.add(block.id);
      }
    } else if (message.role === "toolResult") {
      pendingCalls.delete(message.toolCallId);
    }
  }
  // Retain two complete assistant exchanges. An unfinished batch must never be compacted.
  if (pendingCalls.size > 0 || boundaries.length < 3) return null;
  const cutoff = boundaries[boundaries.length - 2]!;
  return {
    summaryRecords: transcript.slice(0, cutoff),
    preservedTail: transcript.slice(cutoff),
    compactedThroughSequence: transcript[cutoff - 1]!.sequence,
    ...(latestRequest && latestRequestIndex < cutoff ? {preservedRequest: latestRequest} : {}),
  };
}

function buildCheckpointMessage(summary: string, request?: Extract<Message, {role: "user"}>) {
  const message = createCompactBoundaryMessage(summary);
  if (!request) return message;
  const prefix = `${message.content}${COMPACT_PRESERVED_REQUEST_PREFIX}`;
  return {
    ...message,
    content: typeof request.content === "string"
      ? `${prefix}${request.content}`
      : [{type: "text" as const, text: prefix}, ...request.content],
  };
}

function renderUserMessage(message: Extract<Message, { role: "user" }>): string {
  if (typeof message.content === "string") {
    return message.content.trim();
  }

  return message.content
    .map((block) => {
      if (block.type === "text") {
        return block.text.trim();
      }

      if (block.type === "image") {
        return "[image attached]";
      }

      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function renderAssistantMessage(message: Extract<Message, { role: "assistant" }>): string {
  const parts: string[] = [];
  const textBlocks: Array<{type: string; text?: unknown}> = [];

  const flushText = (): void => {
    const text = joinMessageTextParts(textBlocks);
    if (text) {
      parts.push(text);
    }
    textBlocks.length = 0;
  };

  for (const block of message.content) {
    if (block.type === "text") {
      textBlocks.push(block);
      continue;
    }

    if (block.type === "toolCall") {
      flushText();
      parts.push(
        [
          `Tool call: ${block.name}`,
          `Arguments:\n${formatToolCallFallback(block.arguments ?? {})}`,
        ].join("\n"),
      );
    }
  }

  flushText();
  return parts.join("\n\n").trim();
}

function renderToolResultMessage(message: Extract<Message, { role: "toolResult" }>): string {
  return truncateText(formatToolResultFallback(message), TOOL_TEXT_LIMIT);
}

function renderRecordBody(record: ThreadMessageRecord): string {
  if (isCompactBoundaryRecord(record) && record.message.role === "user") {
    return stripCompactSummaryPrefix(renderUserMessage(record.message));
  }

  switch (record.message.role) {
    case "user":
      return renderUserMessage(record.message);
    case "assistant":
      return renderAssistantMessage(record.message);
    case "toolResult":
      return renderToolResultMessage(record.message);
    default:
      return JSON.stringify(record.message, null, 2);
  }
}

export function formatTranscriptForCompaction(
  transcript: readonly ThreadMessageRecord[],
): string {
  return transcript.map((record) => {
    const label = isCompactBoundaryRecord(record)
      ? "prior_compact_summary"
      : `${record.message.role} source=${record.source}`;
    const body = renderRecordBody(record) || "(empty)";
    return `[${record.sequence}] ${label}\n${body}`;
  }).join("\n\n");
}

export function getCompactPrompt(customInstructions?: string, maxSummaryTokens?: number): string {
  return renderCompactionPrompt({
    customInstructions,
    maxSummaryTokens,
  });
}

export function parseCompactSummary(raw: string): string {
  const withoutAnalysis = raw.replace(/<analysis>[\s\S]*?<\/analysis>/i, "").trim();
  const summaryMatch = withoutAnalysis.match(/<summary>([\s\S]*?)<\/summary>/i);
  const summary = summaryMatch?.[1] ?? withoutAnalysis;
  return summary.trim();
}

export function estimateTranscriptTokens(
  transcript: readonly ThreadMessageRecord[],
  options: EstimateTranscriptTokensOptions = {},
): number {
  const estimateTextTokens = options.estimateTextTokens ?? estimateTokensFromString;
  const estimateMessageTokens = options.replayToolArtifacts
    ? estimateReplayMessageTokens
    : estimateVisibleMessageTokens;

  return transcript.reduce((sum, record) => sum + estimateMessageTokens(record.message, estimateTextTokens), 0);
}

export function createCompactBoundaryMessage(summary: string): ReturnType<typeof stringToUserMessage> {
  return stringToUserMessage(buildCompactSummaryMessage(summary));
}

function readThinkingDiagnostic(thinking: ThinkingLevel | undefined): string | undefined {
  if (typeof thinking === "string") {
    return thinking;
  }

  if (thinking === undefined) {
    return undefined;
  }

  return JSON.stringify(thinking);
}

function buildCompactAttemptDiagnostics(options: {
  outcome: CompactAttemptOutcome;
  trigger: CompactBoundaryMetadata["trigger"];
  model: string;
  thinking?: ThinkingLevel;
  activeTranscript: readonly ThreadMessageRecord[];
  activeTranscriptTokens: number;
}): CompactAttemptDiagnostics {
  const modelSelection = resolveModelSelector(options.model);
  const runtimeBudget = resolveModelRuntimeBudget(options.model);
  const thinking = readThinkingDiagnostic(options.thinking);

  return {
    outcome: options.outcome,
    trigger: options.trigger,
    model: options.model,
    providerName: modelSelection.providerName,
    modelId: modelSelection.modelId,
    ...(thinking ? {thinking} : {}),
    operatingWindow: runtimeBudget.operatingWindow,
    compactTriggerTokens: runtimeBudget.compactTriggerTokens,
    activeTranscriptRecords: options.activeTranscript.length,
    activeTranscriptTokens: options.activeTranscriptTokens,
  };
}

async function requestCompactSummary(options: {
  model: string;
  thinking?: ThinkingLevel;
  compactionInput: string;
  customInstructions?: string;
  maxSummaryTokens?: number;
  runtime?: Pick<LlmRuntime, "complete">;
  diagnostics: CompactAttemptDiagnostics;
  signal?: AbortSignal;
}): Promise<{ summary: string; diagnostics: CompactAttemptDiagnostics }> {
  const runtime = options.runtime ?? new PiAiRuntime();
  const modelSelection = resolveModelSelector(options.model);
  const response = await runtime.complete({
    providerName: modelSelection.providerName,
    modelId: modelSelection.modelId,
    thinking: options.thinking,
    context: {
      systemPrompt: getCompactPrompt(options.customInstructions, options.maxSummaryTokens),
      messages: [stringToUserMessage(options.compactionInput)],
    },
    signal: options.signal,
  });

  const rawSummary = joinMessageTextParts(response.content);
  const summary = parseCompactSummary(rawSummary);
  const diagnostics: CompactAttemptDiagnostics = {
    ...options.diagnostics,
    responseStopReason: response.stopReason,
    responseContentTypes: response.content.map((part) => part.type),
    rawTextChars: rawSummary.length,
    parsedSummaryChars: summary.length,
  };
  if (!summary) {
    throw new CompactThreadError("Compaction returned an empty summary.", {
      ...diagnostics,
      outcome: "empty_summary",
      error: "Compaction returned an empty summary.",
    });
  }

  return {
    summary,
    diagnostics: {
      ...diagnostics,
      outcome: "success",
    },
  };
}

export function readAutoCompactionRuntimeState(
  thread: Pick<TranscriptThreadState, "runtimeState">,
): AutoCompactionRuntimeState {
  const state = thread.runtimeState?.autoCompaction;
  if (!state || typeof state !== "object") {
    return { consecutiveFailures: 0 };
  }

  return {
    consecutiveFailures: typeof state.consecutiveFailures === "number" ? state.consecutiveFailures : 0,
    lastFailureReason: typeof state.lastFailureReason === "string" ? state.lastFailureReason : undefined,
    lastFailureAt: typeof state.lastFailureAt === "number" ? state.lastFailureAt : undefined,
    cooldownUntil: typeof state.cooldownUntil === "number" ? state.cooldownUntil : undefined,
    lastAttempt: typeof state.lastAttempt === "object" && state.lastAttempt !== null && !Array.isArray(state.lastAttempt)
      ? state.lastAttempt as CompactAttemptDiagnostics
      : undefined,
  };
}

export function updateAutoCompactionRuntimeState(
  thread: Pick<TranscriptThreadState, "runtimeState">,
  next: AutoCompactionRuntimeState | null,
): ThreadRuntimeState | undefined {
  const current = thread.runtimeState && typeof thread.runtimeState === "object"
    ? thread.runtimeState
    : undefined;
  const currentEntries = current
    ? Object.entries(current).filter(([key]) => key !== "autoCompaction")
    : [];

  if (!next) {
    if (currentEntries.length === 0) {
      return undefined;
    }

    return Object.fromEntries(currentEntries) as ThreadRuntimeState;
  }

  return {
    ...(currentEntries.length > 0 ? Object.fromEntries(currentEntries) : {}),
    autoCompaction: next,
  } satisfies ThreadRuntimeState;
}

export function shouldAutoCompactThread(options: {
  thread: Pick<TranscriptThreadState, "runtimeState">;
  transcriptTokens: number;
  compactTriggerTokens?: number;
  now?: number;
}): AutoCompactCheckResult {
  if (options.compactTriggerTokens === undefined) {
    return { shouldCompact: false };
  }

  const shouldCompact = options.transcriptTokens >= options.compactTriggerTokens;
  if (!shouldCompact) {
    return { shouldCompact: false };
  }

  const now = options.now ?? Date.now();
  const state = readAutoCompactionRuntimeState(options.thread);
  if (state.cooldownUntil !== undefined && state.cooldownUntil > now) {
    return {
      shouldCompact: false,
      cooldownUntil: state.cooldownUntil,
    };
  }

  return {
    shouldCompact: true,
  };
}

export async function compactThread(options: CompactThreadOptions): Promise<CompactThreadResult | null> {
  options.signal?.throwIfAborted();
  const modelSelection = resolveModelSelector(options.model);
  const apiKeyMessage = readMissingApiKeyMessage(modelSelection.providerName);
  if (apiKeyMessage) {
    throw new Error(apiKeyMessage);
  }

  const transcript = options.transcript ?? await options.store.loadActiveTranscript(options.thread.id);
  options.signal?.throwIfAborted();
  const activeTranscript = transcript.records;
  const tokensBefore = estimateTranscriptTokens(activeTranscript, {
    replayToolArtifacts: true,
  });
  const baseDiagnostics = buildCompactAttemptDiagnostics({
    outcome: "success",
    trigger: options.trigger,
    model: options.model,
    thinking: options.thinking,
    activeTranscript,
    activeTranscriptTokens: tokensBefore,
  });
  const split = options.allowPartialTurn
    ? splitLongTurnForCompaction(activeTranscript, options.preservedRequest) ?? splitTranscriptForCompaction(activeTranscript)
    : splitTranscriptForCompaction(activeTranscript);
  if (!split) {
    if (options.trigger === "auto") {
      throw new CompactThreadError("Not enough older context to compact while preserving the recent turns.", {
        ...baseDiagnostics,
        outcome: "no_split",
        error: "Not enough older context to compact while preserving the recent turns.",
      });
    }

    return null;
  }

  const compactionInput = formatTranscriptForCompaction(split.summaryRecords).trim();
  if (!compactionInput) {
    if (options.trigger === "auto") {
      throw new CompactThreadError("Compaction input was empty.", {
        ...baseDiagnostics,
        outcome: "empty_input",
        summaryRecordCount: split.summaryRecords.length,
        preservedTailRecordCount: split.preservedTail.length,
        compactedThroughSequence: split.compactedThroughSequence,
        compactionInputChars: 0,
        error: "Compaction input was empty.",
      });
    }

    return null;
  }

  const preservedTailTokens = estimateTranscriptTokens(split.preservedTail, {
    replayToolArtifacts: true,
  });
  const runtimeBudget = resolveModelRuntimeBudget(options.model);
  const preservedRequestTokens = split.preservedRequest
    ? estimateVisibleMessageTokens(buildCheckpointMessage("", split.preservedRequest))
    : 0;
  const summaryTokenBudget = Math.min(
    runtimeBudget.operatingWindow - preservedTailTokens - preservedRequestTokens,
    ...(options.allowPartialTurn ? [Math.max(1, Math.floor((tokensBefore - preservedTailTokens - preservedRequestTokens) / 2))] : []),
  );
  const splitDiagnostics: CompactAttemptDiagnostics = {
    ...baseDiagnostics,
    summaryRecordCount: split.summaryRecords.length,
    preservedTailRecordCount: split.preservedTail.length,
    compactedThroughSequence: split.compactedThroughSequence,
    compactionInputChars: compactionInput.length,
    preservedTailTokens,
    summaryTokenBudget,
  };
  if (summaryTokenBudget <= 0) {
    throw new CompactThreadError(
      "Recent context already fills the input budget, so compact cannot preserve the recent turns verbatim.",
      {
        ...splitDiagnostics,
        outcome: "tail_over_operating_window",
        error: "Recent context already fills the input budget, so compact cannot preserve the recent turns verbatim.",
      },
    );
  }

  const summaryResult = await requestCompactSummary({
    model: options.model,
    thinking: options.thinking,
    compactionInput,
    customInstructions: options.customInstructions,
    maxSummaryTokens: summaryTokenBudget,
    runtime: options.runtime,
    diagnostics: splitDiagnostics,
    signal: options.signal,
  });
  options.signal?.throwIfAborted();
  const {summary} = summaryResult;

  const compactMessage = buildCheckpointMessage(summary, split.preservedRequest);
  const summaryTokens = estimateVisibleMessageTokens(compactMessage);
  if (summaryTokens > summaryTokenBudget + preservedRequestTokens) {
    throw new CompactThreadError(
      "Compaction summary was too large to fit alongside the preserved recent turns. Try stricter instructions or use a model policy with a larger operating window.",
      {
        ...summaryResult.diagnostics,
        outcome: "summary_too_large",
        error: "Compaction summary was too large to fit alongside the preserved recent turns. Try stricter instructions or use a model policy with a larger operating window.",
      },
    );
  }

  const tokensAfter = summaryTokens + preservedTailTokens;
  if (options.allowPartialTurn && tokensAfter >= tokensBefore) return null;
  const diagnostics: CompactAttemptDiagnostics = {
    ...summaryResult.diagnostics,
    parsedSummaryChars: summary.length,
  };
  const replayContext = options.replayContext ?? activeTranscript.find(isCompactBoundaryRecord)?.metadata.replayContext;
  const metadata: CompactBoundaryMetadata = {
    kind: "compact_boundary",
    compactedThroughSequence: split.compactedThroughSequence,
    preservedTailUserTurns: options.allowPartialTurn
      ? split.preservedTail.filter((record) => record.message.role === "user" && record.source !== "compact").length
      : DEFAULT_COMPACT_PRESERVED_USER_TURNS,
    trigger: options.trigger,
    tokensBefore,
    tokensAfter,
    diagnostics,
    ...(replayContext ? {replayContext} : {}),
  };

  const record = await options.store.commitCompaction(options.thread.id, {
    id: options.operationId,
    expectedCheckpointId: transcript.checkpointId,
    message: compactMessage,
    metadata,
    runId: options.owningRunId,
  });

  return {
    record,
    summary,
    tokensBefore,
    tokensAfter,
    compactedThroughSequence: split.compactedThroughSequence,
    diagnostics,
  };
}

export async function appendCompactionFailureNotice(options: {
  store: Pick<{
    appendRuntimeMessage(
      threadId: string,
      payload: ThreadRuntimeMessagePayload,
    ): Promise<ThreadMessageRecord>;
  }, "appendRuntimeMessage">;
  threadId: string;
  reason: string;
  consecutiveFailures: number;
  cooldownUntil?: number;
  runId?: string;
  diagnostics?: CompactAttemptDiagnostics;
  blocked?: boolean;
}): Promise<ThreadMessageRecord> {
  const lines = [
    options.blocked
      ? "Auto-compaction failed; run blocked to avoid sending an over-window request."
      : "Auto-compaction failed; continuing without compacting.",
    `Reason: ${options.reason}`,
  ];

  if (options.cooldownUntil !== undefined) {
    lines.push(`Auto-compaction is paused until ${new Date(options.cooldownUntil).toISOString()}.`);
  }

  const metadata: CompactFailureNoticeMetadata = {
    kind: "compact_failure_notice",
    trigger: "auto",
    reason: options.reason,
    consecutiveFailures: options.consecutiveFailures,
    cooldownUntil: options.cooldownUntil ?? null,
    ...(options.diagnostics ? {diagnostics: options.diagnostics} : {}),
  };

  return options.store.appendRuntimeMessage(options.threadId, {
    message: {
      role: "assistant",
      content: [{ type: "text", text: lines.join("\n") }],
      api: "openai-responses",
      provider: "openai",
      model: "system",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    },
    source: "compact",
    metadata,
    runId: options.runId,
  });
}
