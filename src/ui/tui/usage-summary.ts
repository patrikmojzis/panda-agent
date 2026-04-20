import type {ThinkingLevel} from "@mariozechner/pi-ai";

import {DEFAULT_INFERENCE_PROJECTION} from "../../app/runtime/thread-definition.js";
import {
    estimateTranscriptTokens,
    isCompactBoundaryRecord,
    projectTranscriptForInference,
    projectTranscriptForRun,
    type ThreadMessageRecord,
    type ThreadRecord,
} from "../../domain/threads/runtime/index.js";
import {readThreadAgentKey} from "../../domain/threads/runtime/context.js";
import {resolveModelRuntimeBudget} from "../../kernel/models/model-context-policy.js";
import {mergeInferenceProjection} from "../../kernel/transcript/inference-projection.js";
import {formatThinkingLevel} from "./chat-shared.js";

interface UsageCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

interface UsageTotals {
  responses: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: UsageCost;
}

interface UsageSnapshot {
  sequence: number;
  createdAt: number;
  provider?: string;
  model?: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: UsageCost;
}

interface ImageStats {
  count: number;
  dataBytes: number;
}

export interface ThreadUsageSnapshot {
  threadId: string;
  agentKey: string;
  model: string;
  thinking?: ThinkingLevel;
  runState: "idle" | "thinking";
  storedMessages: number;
  runMessages: number;
  visibleMessages: number;
  storedEstimatedTokens: number;
  runEstimatedTokens: number;
  visibleEstimatedTokens: number;
  storedJsonBytes: number;
  hardWindow: number;
  operatingWindow: number;
  compactAtPercent: number;
  compactTriggerTokens: number;
  storedImages: ImageStats;
  visibleImages: ImageStats;
  totalUsage: UsageTotals;
  lastUsage: UsageSnapshot | null;
  latestCompaction?: {
    trigger?: string;
    tokensBefore: number | null;
    tokensAfter: number | null;
  };
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readUsageCost(value: unknown): UsageCost {
  const cost = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  return {
    input: readNumber(cost.input),
    output: readNumber(cost.output),
    cacheRead: readNumber(cost.cacheRead),
    cacheWrite: readNumber(cost.cacheWrite),
    total: readNumber(cost.total),
  };
}

function readAssistantUsage(record: ThreadMessageRecord): UsageSnapshot | null {
  if (record.message.role !== "assistant") {
    return null;
  }

  const message = record.message as typeof record.message & {
    usage?: unknown;
    provider?: unknown;
    model?: unknown;
  };
  if (typeof message.usage !== "object" || message.usage === null) {
    return null;
  }

  const usage = message.usage as unknown as Record<string, unknown>;
  const cost = readUsageCost(usage.cost);
  const input = readNumber(usage.input);
  const output = readNumber(usage.output);
  const cacheRead = readNumber(usage.cacheRead);
  const cacheWrite = readNumber(usage.cacheWrite);
  const totalTokens = readNumber(usage.totalTokens) || input + output + cacheRead + cacheWrite;
  const nonZeroUsage = totalTokens > 0
    || input > 0
    || output > 0
    || cacheRead > 0
    || cacheWrite > 0
    || cost.total > 0;

  if (!nonZeroUsage) {
    return null;
  }

  return {
    sequence: record.sequence,
    createdAt: record.createdAt,
    provider: typeof message.provider === "string" ? message.provider : undefined,
    model: typeof message.model === "string" ? message.model : undefined,
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    cost,
  };
}

function collectUsageTotals(transcript: readonly ThreadMessageRecord[]): {
  total: UsageTotals;
  last: UsageSnapshot | null;
} {
  const total: UsageTotals = {
    responses: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
  let last: UsageSnapshot | null = null;

  for (const record of transcript) {
    const usage = readAssistantUsage(record);
    if (!usage) {
      continue;
    }

    total.responses += 1;
    total.input += usage.input;
    total.output += usage.output;
    total.cacheRead += usage.cacheRead;
    total.cacheWrite += usage.cacheWrite;
    total.totalTokens += usage.totalTokens;
    total.cost.input += usage.cost.input;
    total.cost.output += usage.cost.output;
    total.cost.cacheRead += usage.cost.cacheRead;
    total.cost.cacheWrite += usage.cost.cacheWrite;
    total.cost.total += usage.cost.total;
    last = usage;
  }

  return {total, last};
}

function measureStoredJsonBytes(transcript: readonly ThreadMessageRecord[]): number {
  return transcript.reduce((sum, record) => {
    return sum + Buffer.byteLength(JSON.stringify(record.message));
  }, 0);
}

function measureInlineImages(transcript: readonly ThreadMessageRecord[]): ImageStats {
  return transcript.reduce<ImageStats>((stats, record) => {
    const content = record.message.content;
    if (!Array.isArray(content)) {
      return stats;
    }

    for (const block of content) {
      if (block.type !== "image") {
        continue;
      }

      stats.count += 1;
      if ("data" in block && typeof block.data === "string") {
        stats.dataBytes += Buffer.byteLength(block.data);
      }
    }

    return stats;
  }, {count: 0, dataBytes: 0});
}

function findLatestCompaction(transcript: readonly ThreadMessageRecord[]) {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const record = transcript[index];
    if (!record || !isCompactBoundaryRecord(record)) {
      continue;
    }

    return {
      trigger: record.metadata.trigger,
      tokensBefore: record.metadata.tokensBefore,
      tokensAfter: record.metadata.tokensAfter,
    };
  }

  return undefined;
}

function formatInt(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function formatUsd(value: number): string {
  const digits = value >= 10 ? 2 : value >= 1 ? 3 : 4;
  return `$${value.toFixed(digits)}`;
}

function formatMaybeInt(value: number | null | undefined): string {
  return typeof value === "number" ? formatInt(value) : "?";
}

function formatBytes(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)} MB`;
  }

  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)} kB`;
  }

  return `${value} B`;
}

export function collectThreadUsageSnapshot(options: {
  thread: ThreadRecord;
  transcript: readonly ThreadMessageRecord[];
  model: string;
  thinking?: ThinkingLevel;
  isRunning: boolean;
  now?: number;
}): ThreadUsageSnapshot {
  // Mirror the same default projection Panda uses during live runs so the TUI
  // shows the context the model is actually likely to see, not just stored junk.
  const effectiveProjection = mergeInferenceProjection(
    DEFAULT_INFERENCE_PROJECTION,
    options.thread.inferenceProjection,
  );
  const runTranscript = projectTranscriptForRun(options.transcript);
  const visibleTranscript = projectTranscriptForInference(
    runTranscript,
    effectiveProjection,
    options.now ?? Date.now(),
  );
  const replayVisibleArtifacts = effectiveProjection?.dropImages === undefined;
  const {total, last} = collectUsageTotals(options.transcript);
  const model = options.model ?? options.thread.model;
  const budget = resolveModelRuntimeBudget(model);

  return {
    threadId: options.thread.id,
    agentKey: readThreadAgentKey(options.thread) ?? "unknown",
    model,
    thinking: options.thinking ?? options.thread.thinking,
    runState: options.isRunning ? "thinking" : "idle",
    storedMessages: options.transcript.length,
    runMessages: runTranscript.length,
    visibleMessages: visibleTranscript.length,
    storedEstimatedTokens: estimateTranscriptTokens(options.transcript),
    runEstimatedTokens: estimateTranscriptTokens(runTranscript, {
      replayToolArtifacts: true,
    }),
    visibleEstimatedTokens: estimateTranscriptTokens(visibleTranscript, {
      replayToolArtifacts: replayVisibleArtifacts,
    }),
    storedJsonBytes: measureStoredJsonBytes(options.transcript),
    hardWindow: budget.hardWindow,
    operatingWindow: budget.operatingWindow,
    compactAtPercent: budget.compactAtPercent,
    compactTriggerTokens: budget.compactTriggerTokens,
    storedImages: measureInlineImages(options.transcript),
    visibleImages: measureInlineImages(visibleTranscript),
    totalUsage: total,
    lastUsage: last,
    latestCompaction: findLatestCompaction(options.transcript),
  };
}

export function formatThreadUsageSnapshot(snapshot: ThreadUsageSnapshot): string {
  const lines = [
    "## Thread",
    `- **ID:** \`${snapshot.threadId}\``,
    `- **Agent:** \`${snapshot.agentKey}\``,
    `- **Model:** \`${snapshot.model}\``,
    `- **State:** thinking \`${formatThinkingLevel(snapshot.thinking)}\` · run \`${snapshot.runState}\``,
    "",
    "## Context",
    `- **Visible now:** ${formatInt(snapshot.visibleMessages)} msgs · ~${formatInt(snapshot.visibleEstimatedTokens)} est tokens`,
    `- **Run input:** ${formatInt(snapshot.runMessages)} msgs · ~${formatInt(snapshot.runEstimatedTokens)} est tokens`,
    `- **Stored thread:** ${formatInt(snapshot.storedMessages)} msgs · ~${formatInt(snapshot.storedEstimatedTokens)} est tokens · ${formatBytes(snapshot.storedJsonBytes)} JSON`,
    `- **Context policy:** operating ${formatInt(snapshot.operatingWindow)} · hard ${formatInt(snapshot.hardWindow)} · compact at ${snapshot.compactAtPercent}% (~${formatInt(snapshot.compactTriggerTokens)})`,
  ];

  const fill = snapshot.operatingWindow > 0
    ? `${((snapshot.visibleEstimatedTokens / snapshot.operatingWindow) * 100).toFixed(1)}%`
    : "n/a";
  lines.push(
    `- **Active budget:** ~${formatInt(snapshot.visibleEstimatedTokens)} / ${formatInt(snapshot.operatingWindow)} est tokens (${fill})`,
  );

  if (snapshot.storedImages.count > 0 || snapshot.visibleImages.count > 0) {
    lines.push(
      `- **Inline images:** stored ${formatInt(snapshot.storedImages.count)} · ${formatBytes(snapshot.storedImages.dataBytes)} base64`
        + ` · visible now ${formatInt(snapshot.visibleImages.count)} · ${formatBytes(snapshot.visibleImages.dataBytes)} base64`,
    );
  }

  if (snapshot.latestCompaction) {
    lines.push(
      `- **Last compaction:** ${snapshot.latestCompaction.trigger ?? "unknown"} · `
        + `~${formatMaybeInt(snapshot.latestCompaction.tokensBefore)} -> ~${formatMaybeInt(snapshot.latestCompaction.tokensAfter)} est tokens`,
    );
  }

  lines.push("", "## Provider Usage");

  if (!snapshot.lastUsage || snapshot.totalUsage.responses === 0) {
    lines.push("- No persisted provider usage yet.");
    return lines.join("\n");
  }

  lines.push(
    `- **Last response:** ${formatInt(snapshot.lastUsage.totalTokens)} total tokens · `
      + `input ${formatInt(snapshot.lastUsage.input)} · `
      + `cache read ${formatInt(snapshot.lastUsage.cacheRead)} · `
      + `cache write ${formatInt(snapshot.lastUsage.cacheWrite)} · `
      + `output ${formatInt(snapshot.lastUsage.output)} · `
      + `${formatUsd(snapshot.lastUsage.cost.total)}`
      + (snapshot.lastUsage.model ? ` · \`${snapshot.lastUsage.model}\`` : ""),
  );
  lines.push(
    `- **Thread total:** ${formatInt(snapshot.totalUsage.responses)} responses · `
      + `${formatInt(snapshot.totalUsage.totalTokens)} total tokens · `
      + `${formatUsd(snapshot.totalUsage.cost.total)}`,
  );

  return lines.join("\n");
}
