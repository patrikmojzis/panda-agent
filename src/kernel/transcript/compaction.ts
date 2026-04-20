import type {Message, ThinkingLevel} from "@mariozechner/pi-ai";

import {formatToolCallFallback, formatToolResultFallback, PiAiRuntime} from "../agent/index.js";
import {buildCompactSummaryMessage, stripCompactSummaryPrefix} from "../agent/helpers/compact.js";
import {estimateTokensFromString, type TokenCounter} from "../agent/helpers/token-count.js";
import {stringToUserMessage} from "../agent/helpers/input.js";
import {resolveModelRuntimeBudget} from "../models/model-context-policy.js";
import {resolveModelSelector} from "../models/model-selector.js";
import {renderCompactionPrompt} from "../../prompts/runtime/compaction.js";
import {readMissingApiKeyMessage} from "../../integrations/providers/shared/missing-api-key.js";
import type {JsonObject, JsonValue} from "../agent/types.js";
import type {LlmRuntime} from "../agent/runtime.js";
import {estimateReplayMessageTokens, estimateVisibleMessageTokens} from "./token-estimation.js";
import type {
    AutoCompactionRuntimeState,
    ThreadMessageRecord,
    ThreadRecord,
    ThreadRuntimeMessagePayload,
    ThreadRuntimeState,
} from "../../domain/threads/runtime/types.js";

export const DEFAULT_COMPACT_PRESERVED_USER_TURNS = 6;
export const AUTO_COMPACT_BREAKER_FAILURE_THRESHOLD = 2;
export const AUTO_COMPACT_BREAKER_COOLDOWN_MS = 5 * 60_000;
const TOOL_TEXT_LIMIT = 4_000;

export interface CompactBoundaryMetadata extends JsonObject {
  kind: "compact_boundary";
  compactedUpToSequence: number;
  preservedTailUserTurns: number;
  trigger: "manual" | "auto";
  tokensBefore: number | null;
  tokensAfter: number | null;
}

export interface CompactTranscriptSplit {
  summaryRecords: readonly ThreadMessageRecord[];
  preservedTail: readonly ThreadMessageRecord[];
  compactedUpToSequence: number;
}

export interface CompactFailureNoticeMetadata extends JsonObject {
  kind: "compact_failure_notice";
  trigger: "auto";
  reason: string;
  consecutiveFailures: number;
  cooldownUntil: number | null;
}

export interface CompactThreadOptions {
  store: Pick<{
    loadTranscript(threadId: string): Promise<readonly ThreadMessageRecord[]>;
    appendRuntimeMessage(
      threadId: string,
      payload: ThreadRuntimeMessagePayload,
    ): Promise<ThreadMessageRecord>;
  }, "loadTranscript" | "appendRuntimeMessage">;
  thread: Pick<ThreadRecord, "id">;
  transcript?: readonly ThreadMessageRecord[];
  model: string;
  thinking?: ThinkingLevel;
  customInstructions?: string;
  trigger: CompactBoundaryMetadata["trigger"];
  runtime?: Pick<LlmRuntime, "complete">;
}

export interface CompactThreadResult {
  record: ThreadMessageRecord;
  summary: string;
  tokensBefore: number;
  tokensAfter: number;
  compactedUpToSequence: number;
}

export interface AutoCompactCheckResult {
  shouldCompact: boolean;
  cooldownUntil?: number;
}

export interface EstimateTranscriptTokensOptions {
  estimateTextTokens?: TokenCounter;
  replayToolArtifacts?: boolean;
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxChars - 12)).trimEnd()}\n[truncated]`;
}

function isCompactBoundaryMetadata(value: JsonValue | undefined): value is CompactBoundaryMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return record.kind === "compact_boundary"
    && typeof record.compactedUpToSequence === "number"
    && typeof record.preservedTailUserTurns === "number"
    && (record.trigger === "manual" || record.trigger === "auto");
}

function isCompactFailureNoticeMetadata(value: JsonValue | undefined): value is CompactFailureNoticeMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return record.kind === "compact_failure_notice"
    && record.trigger === "auto"
    && typeof record.reason === "string"
    && typeof record.consecutiveFailures === "number";
}

export function isCompactBoundaryRecord(
  record: ThreadMessageRecord,
): record is ThreadMessageRecord & { metadata: CompactBoundaryMetadata } {
  return record.source === "compact" && isCompactBoundaryMetadata(record.metadata);
}

function isCompactFailureNoticeRecord(
  record: ThreadMessageRecord,
): record is ThreadMessageRecord & { metadata: CompactFailureNoticeMetadata } {
  return record.source === "compact" && isCompactFailureNoticeMetadata(record.metadata);
}

export function projectTranscriptForRun(
  transcript: readonly ThreadMessageRecord[],
): readonly ThreadMessageRecord[] {
  const modelVisibleTranscript = transcript.filter((record) => !isCompactFailureNoticeRecord(record));

  for (let index = modelVisibleTranscript.length - 1; index >= 0; index -= 1) {
    const record = modelVisibleTranscript[index];
    if (!record || !isCompactBoundaryRecord(record)) {
      continue;
    }

    const boundary = record;
    const tail = modelVisibleTranscript.filter((record) => {
      return record.id !== boundary.id
        && record.sequence > boundary.metadata.compactedUpToSequence;
    });

    return [boundary, ...tail];
  }

  return modelVisibleTranscript;
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
    compactedUpToSequence: lastSummarized.sequence,
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

  for (const block of message.content) {
    if (block.type === "text" && block.text.trim()) {
      parts.push(block.text.trim());
      continue;
    }

    if (block.type === "toolCall") {
      parts.push(
        [
          `Tool call: ${block.name}`,
          `Arguments:\n${formatToolCallFallback(block.arguments ?? {})}`,
        ].join("\n"),
      );
    }
  }

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

async function requestCompactSummary(options: {
  model: string;
  thinking?: ThinkingLevel;
  compactionInput: string;
  customInstructions?: string;
  maxSummaryTokens?: number;
  runtime?: Pick<LlmRuntime, "complete">;
}): Promise<string> {
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
  });

  const rawSummary = response.content.flatMap((part) => {
    return part.type === "text" && part.text.trim() ? [part.text.trim()] : [];
  }).join("\n\n");
  const summary = parseCompactSummary(rawSummary);
  if (!summary) {
    throw new Error("Compaction returned an empty summary.");
  }

  return summary;
}

export function readAutoCompactionRuntimeState(
  thread: Pick<ThreadRecord, "runtimeState">,
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
  };
}

export function updateAutoCompactionRuntimeState(
  thread: Pick<ThreadRecord, "runtimeState">,
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
  thread: Pick<ThreadRecord, "runtimeState">;
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
  const modelSelection = resolveModelSelector(options.model);
  const apiKeyMessage = readMissingApiKeyMessage(modelSelection.providerName);
  if (apiKeyMessage) {
    throw new Error(apiKeyMessage);
  }

  const transcript = options.transcript ?? await options.store.loadTranscript(options.thread.id);
  const activeTranscript = projectTranscriptForRun(transcript);
  const split = splitTranscriptForCompaction(activeTranscript);
  if (!split) {
    return null;
  }

  const compactionInput = formatTranscriptForCompaction(split.summaryRecords).trim();
  if (!compactionInput) {
    return null;
  }

  const preservedTailTokens = estimateTranscriptTokens(split.preservedTail, {
    replayToolArtifacts: true,
  });
  const runtimeBudget = resolveModelRuntimeBudget(options.model);
  const summaryTokenBudget = runtimeBudget.operatingWindow - preservedTailTokens;
  if (summaryTokenBudget <= 0) {
    throw new Error(
      "Recent context already fills the input budget, so compact cannot preserve the recent turns verbatim.",
    );
  }

  const summary = await requestCompactSummary({
    model: options.model,
    thinking: options.thinking,
    compactionInput,
    customInstructions: options.customInstructions,
    maxSummaryTokens: summaryTokenBudget,
    runtime: options.runtime,
  });

  const compactMessage = createCompactBoundaryMessage(summary);
  const summaryTokens = estimateVisibleMessageTokens(compactMessage);
  if (summaryTokens > summaryTokenBudget) {
    throw new Error(
      "Compaction summary was too large to fit alongside the preserved recent turns. Try stricter instructions or use a model policy with a larger operating window.",
    );
  }

  const tokensBefore = estimateTranscriptTokens(activeTranscript, {
    replayToolArtifacts: true,
  });
  const tokensAfter = summaryTokens + preservedTailTokens;
  const metadata: CompactBoundaryMetadata = {
    kind: "compact_boundary",
    compactedUpToSequence: split.compactedUpToSequence,
    preservedTailUserTurns: DEFAULT_COMPACT_PRESERVED_USER_TURNS,
    trigger: options.trigger,
    tokensBefore,
    tokensAfter,
  };

  const record = await options.store.appendRuntimeMessage(options.thread.id, {
    message: compactMessage,
    source: "compact",
    metadata,
  });

  return {
    record,
    summary,
    tokensBefore,
    tokensAfter,
    compactedUpToSequence: split.compactedUpToSequence,
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
}): Promise<ThreadMessageRecord> {
  const lines = [
    "Auto-compaction failed, so Panda skipped this turn.",
    "Manual compaction is required before continuing.",
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
