import type {Message} from "@mariozechner/pi-ai";

import {isCompactBoundaryRecord} from "./compaction.js";
import {readPositiveInteger} from "../../lib/numbers.js";
import type {
    InferenceProjection,
    InferenceProjectionRule,
    ThreadMessageRecord,
} from "../../domain/threads/runtime/types.js";

interface RuleWindow {
  protectedIndexes: Set<number>;
  hasProtectionWindow: boolean;
  cutoffTime?: number;
}

function mergeRule(
  base?: InferenceProjectionRule,
  override?: InferenceProjectionRule,
): InferenceProjectionRule | undefined {
  if (!base && !override) {
    return undefined;
  }

  const merged = {
    ...(base ?? {}),
    ...(override ?? {}),
  } satisfies InferenceProjectionRule;

  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function mergeInferenceProjection(
  ...layers: readonly (InferenceProjection | null | undefined)[]
): InferenceProjection | undefined {
  const merged: InferenceProjection = {};

  for (const layer of layers) {
    if (!layer) {
      continue;
    }

    merged.dropMessages = mergeRule(merged.dropMessages, layer.dropMessages);
    merged.dropToolCalls = mergeRule(merged.dropToolCalls, layer.dropToolCalls);
    merged.dropThinking = mergeRule(merged.dropThinking, layer.dropThinking);
    merged.dropImages = mergeRule(merged.dropImages, layer.dropImages);
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

function normalizeCutoffTime(now: number, olderThanMs: number | undefined): number | undefined {
  if (typeof olderThanMs !== "number" || !Number.isFinite(olderThanMs)) {
    return undefined;
  }

  return now - Math.max(0, olderThanMs);
}

function findLatestCompactBoundaryIndex(records: readonly ThreadMessageRecord[]): number {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record && isCompactBoundaryRecord(record)) {
      return index;
    }
  }

  return -1;
}

function buildRuleWindow(
  records: readonly ThreadMessageRecord[],
  rule: InferenceProjectionRule,
  now: number,
): RuleWindow {
  const protectedIndexes = new Set<number>();
  const preserveTailMessages = readPositiveInteger(rule.preserveTailMessages);
  const preserveRecentUserTurns = readPositiveInteger(rule.preserveRecentUserTurns);

  if (preserveTailMessages) {
    const start = Math.max(0, records.length - preserveTailMessages);
    for (let index = start; index < records.length; index += 1) {
      protectedIndexes.add(index);
    }
  }

  if (preserveRecentUserTurns) {
    const userIndexes: number[] = [];

    for (const [index, record] of records.entries()) {
      if (record.message.role !== "user" || isCompactBoundaryRecord(record)) {
        continue;
      }

      userIndexes.push(index);
    }

    if (userIndexes.length > 0) {
      const preservedStartIndex = userIndexes[Math.max(0, userIndexes.length - preserveRecentUserTurns)] ?? 0;
      for (let index = preservedStartIndex; index < records.length; index += 1) {
        protectedIndexes.add(index);
      }
    }
  }

  const latestCompactBoundaryIndex = findLatestCompactBoundaryIndex(records);
  if (latestCompactBoundaryIndex >= 0) {
    protectedIndexes.add(latestCompactBoundaryIndex);
  }

  return {
    protectedIndexes,
    hasProtectionWindow: preserveTailMessages !== undefined || preserveRecentUserTurns !== undefined,
    cutoffTime: normalizeCutoffTime(now, rule.olderThanMs),
  };
}

function isEligibleForRule(
  index: number,
  record: ThreadMessageRecord,
  window: RuleWindow,
): boolean {
  if (window.protectedIndexes.has(index)) {
    return false;
  }

  if (window.hasProtectionWindow) {
    return true;
  }

  return window.cutoffTime !== undefined && record.createdAt <= window.cutoffTime;
}

function replaceRecordMessage(record: ThreadMessageRecord, message: Message): ThreadMessageRecord {
  return {
    ...record,
    message,
  };
}

function applyDropMessages(
  records: readonly ThreadMessageRecord[],
  rule: InferenceProjectionRule,
  now: number,
): ThreadMessageRecord[] {
  const window = buildRuleWindow(records, rule, now);
  return records.filter((record, index) => !isEligibleForRule(index, record, window));
}

function applyDropThinking(
  records: readonly ThreadMessageRecord[],
  rule: InferenceProjectionRule,
  now: number,
): ThreadMessageRecord[] {
  const window = buildRuleWindow(records, rule, now);

  return records.flatMap((record, index) => {
    if (!isEligibleForRule(index, record, window) || record.message.role !== "assistant") {
      return [record];
    }

    const content = record.message.content.filter((block) => block.type !== "thinking");
    if (content.length === record.message.content.length) {
      return [record];
    }

    if (content.length === 0) {
      return [];
    }

    return [replaceRecordMessage(record, {
      ...record.message,
      content,
    })];
  });
}

function applyDropImages(
  records: readonly ThreadMessageRecord[],
  rule: InferenceProjectionRule,
  now: number,
): ThreadMessageRecord[] {
  const window = buildRuleWindow(records, rule, now);

  return records.flatMap((record, index) => {
    if (!isEligibleForRule(index, record, window)) {
      return [record];
    }

    if (record.message.role === "user") {
      if (typeof record.message.content === "string") {
        return [record];
      }

      const content = record.message.content.filter((block) => block.type !== "image");
      if (content.length === record.message.content.length) {
        return [record];
      }

      if (content.length === 0) {
        return [];
      }

      return [replaceRecordMessage(record, {
        ...record.message,
        content,
      })];
    }

    if (record.message.role === "toolResult") {
      const content = record.message.content.filter((block) => block.type !== "image");
      if (content.length === record.message.content.length) {
        return [record];
      }

      if (content.length === 0) {
        return [];
      }

      return [replaceRecordMessage(record, {
        ...record.message,
        content,
      })];
    }

    return [record];
  });
}

function applyDropToolCalls(
  records: readonly ThreadMessageRecord[],
  rule: InferenceProjectionRule,
  now: number,
): ThreadMessageRecord[] {
  const window = buildRuleWindow(records, rule, now);
  const eligibleIndexes = new Set<number>();
  const toolResultIndexesByCallId = new Map<string, number[]>();

  for (const [index, record] of records.entries()) {
    if (isEligibleForRule(index, record, window)) {
      eligibleIndexes.add(index);
    }

    if (record.message.role !== "toolResult") {
      continue;
    }

    const indexes = toolResultIndexesByCallId.get(record.message.toolCallId) ?? [];
    indexes.push(index);
    toolResultIndexesByCallId.set(record.message.toolCallId, indexes);
  }

  const droppableToolCallIds = new Set<string>();
  for (const index of eligibleIndexes) {
    const record = records[index];
    if (!record || record.message.role !== "assistant") {
      continue;
    }

    for (const block of record.message.content) {
      if (block.type !== "toolCall") {
        continue;
      }

      const resultIndexes = toolResultIndexesByCallId.get(block.id) ?? [];
      const hasProtectedResult = resultIndexes.some((resultIndex) => !eligibleIndexes.has(resultIndex));
      if (!hasProtectedResult) {
        droppableToolCallIds.add(block.id);
      }
    }
  }

  return records.flatMap((record, index) => {
    if (record.message.role === "toolResult") {
      return eligibleIndexes.has(index) && droppableToolCallIds.has(record.message.toolCallId)
        ? []
        : [record];
    }

    if (record.message.role !== "assistant" || !eligibleIndexes.has(index)) {
      return [record];
    }

    const content = record.message.content.filter((block) => {
      return block.type !== "toolCall" || !droppableToolCallIds.has(block.id);
    });

    if (content.length === record.message.content.length) {
      return [record];
    }

    if (content.length === 0) {
      return [];
    }

    return [replaceRecordMessage(record, {
      ...record.message,
      content,
    })];
  });
}

function pruneDanglingToolResults(records: readonly ThreadMessageRecord[]): ThreadMessageRecord[] {
  const seenToolCallIds = new Set<string>();

  return records.flatMap((record) => {
    if (record.message.role === "assistant") {
      for (const block of record.message.content) {
        if (block.type === "toolCall") {
          seenToolCallIds.add(block.id);
        }
      }

      return [record];
    }

    if (record.message.role === "toolResult" && !seenToolCallIds.has(record.message.toolCallId)) {
      return [];
    }

    return [record];
  });
}

export function projectTranscriptForInference(
  transcript: readonly ThreadMessageRecord[],
  projection?: InferenceProjection,
  now = Date.now(),
): readonly ThreadMessageRecord[] {
  let projected = [...transcript];
  let hasActiveRule = false;

  if (!projection) {
    return projected;
  }

  if (projection.dropMessages) {
    hasActiveRule = true;
    projected = applyDropMessages(projected, projection.dropMessages, now);
  }

  if (projection.dropToolCalls) {
    hasActiveRule = true;
    projected = applyDropToolCalls(projected, projection.dropToolCalls, now);
  }

  if (projection.dropThinking) {
    hasActiveRule = true;
    projected = applyDropThinking(projected, projection.dropThinking, now);
  }

  if (projection.dropImages) {
    hasActiveRule = true;
    projected = applyDropImages(projected, projection.dropImages, now);
  }

  return hasActiveRule ? pruneDanglingToolResults(projected) : projected;
}

export function applyImageProjectionForInference(
  transcript: readonly ThreadMessageRecord[],
  rule?: InferenceProjectionRule,
  now = Date.now(),
): readonly ThreadMessageRecord[] {
  if (!rule) {
    return transcript;
  }

  return applyDropImages(transcript, rule, now);
}
