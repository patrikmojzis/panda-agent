import type {Message} from "@mariozechner/pi-ai";

export type ReplaySegmentKind =
  | "message"
  | "tool_exchange"
  | "orphan_tool_results";

export type ReplaySegmentIssue =
  | "missing_tool_results"
  | "unexpected_tool_result"
  | "duplicate_tool_result"
  | "orphan_tool_results";

export interface ReplaySegment {
  kind: ReplaySegmentKind;
  startIndex: number;
  endIndex: number;
  messages: Message[];
  issues: ReplaySegmentIssue[];
}

export interface TrimReplaySegmentsOptions {
  pinnedMessage?: Message;
  segments: readonly ReplaySegment[];
  budgetTokens: number;
  estimateMessageTokens: (message: Message) => number;
  keepNewestOversizedSegment?: boolean;
}

function collectAssistantToolCallIds(message: Extract<Message, {role: "assistant"}>): string[] {
  return message.content.flatMap((block) => block.type === "toolCall" ? [block.id] : []);
}

function createSegment(options: {
  kind: ReplaySegmentKind;
  startIndex: number;
  endIndex: number;
  messages: Message[];
  issues?: readonly ReplaySegmentIssue[];
}): ReplaySegment {
  return {
    kind: options.kind,
    startIndex: options.startIndex,
    endIndex: options.endIndex,
    messages: options.messages,
    issues: options.issues ? [...options.issues] : [],
  };
}

function analyzeToolExchange(
  toolCallIds: readonly string[],
  toolResults: readonly Extract<Message, {role: "toolResult"}>[],
): ReplaySegmentIssue[] {
  const expected = new Set(toolCallIds);
  const seen = new Set<string>();
  const issues = new Set<ReplaySegmentIssue>();

  for (const result of toolResults) {
    if (!expected.has(result.toolCallId)) {
      issues.add("unexpected_tool_result");
      continue;
    }

    if (seen.has(result.toolCallId)) {
      issues.add("duplicate_tool_result");
      continue;
    }

    seen.add(result.toolCallId);
  }

  if (seen.size < expected.size) {
    issues.add("missing_tool_results");
  }

  return [...issues];
}

export function buildReplaySegments(messages: readonly Message[]): ReplaySegment[] {
  const segments: ReplaySegment[] = [];
  let index = 0;

  while (index < messages.length) {
    const message = messages[index];
    if (!message) {
      break;
    }

    if (message.role === "toolResult") {
      const startIndex = index;
      const segmentMessages: Message[] = [];

      while (index < messages.length) {
        const current = messages[index];
        if (!current || current.role !== "toolResult") {
          break;
        }

        segmentMessages.push(current);
        index += 1;
      }

      segments.push(createSegment({
        kind: "orphan_tool_results",
        startIndex,
        endIndex: index - 1,
        messages: segmentMessages,
        issues: ["orphan_tool_results"],
      }));
      continue;
    }

    if (message.role === "assistant") {
      const toolCallIds = collectAssistantToolCallIds(message);
      if (toolCallIds.length > 0) {
        const startIndex = index;
        const segmentMessages: Message[] = [message];
        const toolResults: Extract<Message, {role: "toolResult"}>[] = [];

        index += 1;
        while (index < messages.length) {
          const current = messages[index];
          if (!current || current.role !== "toolResult") {
            break;
          }

          segmentMessages.push(current);
          toolResults.push(current);
          index += 1;
        }

        segments.push(createSegment({
          kind: "tool_exchange",
          startIndex,
          endIndex: index - 1,
          messages: segmentMessages,
          issues: analyzeToolExchange(toolCallIds, toolResults),
        }));
        continue;
      }
    }

    segments.push(createSegment({
      kind: "message",
      startIndex: index,
      endIndex: index,
      messages: [message],
    }));
    index += 1;
  }

  return segments;
}

function estimateSegmentTokens(
  segment: ReplaySegment,
  estimateMessageTokens: (message: Message) => number,
): number {
  return segment.messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

function flattenSegments(segments: readonly ReplaySegment[]): Message[] {
  return segments.flatMap((segment) => segment.messages);
}

export function trimReplaySegmentsToBudget(options: TrimReplaySegmentsOptions): Message[] {
  const {
    pinnedMessage,
    segments,
    budgetTokens,
    estimateMessageTokens,
    keepNewestOversizedSegment = false,
  } = options;

  const pinnedTokens = pinnedMessage ? estimateMessageTokens(pinnedMessage) : 0;
  if (pinnedMessage && pinnedTokens >= budgetTokens) {
    return [pinnedMessage];
  }

  const remainingBudget = Math.max(0, budgetTokens - pinnedTokens);
  const keptSegments: ReplaySegment[] = [];
  let usedTokens = 0;

  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (!segment) {
      continue;
    }

    const segmentTokens = estimateSegmentTokens(segment, estimateMessageTokens);
    if (usedTokens + segmentTokens <= remainingBudget) {
      keptSegments.unshift(segment);
      usedTokens += segmentTokens;
      continue;
    }

    if (keptSegments.length === 0 && keepNewestOversizedSegment) {
      keptSegments.unshift(segment);
      break;
    }

    break;
  }

  if (!pinnedMessage) {
    return flattenSegments(keptSegments);
  }

  return [pinnedMessage, ...flattenSegments(keptSegments)];
}
