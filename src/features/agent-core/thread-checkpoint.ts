import type { AssistantMessage, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";

import type { RunContext } from "./run-context.js";
import type { JsonValue } from "./types.js";

export interface ThreadCheckpointDecisionContinue {
  action: "continue";
}

export interface ThreadCheckpointDecisionInterrupt {
  action: "interrupt";
  reason?: string;
  cancelPendingToolCalls?: boolean;
}

export type ThreadCheckpointDecision =
  | ThreadCheckpointDecisionContinue
  | ThreadCheckpointDecisionInterrupt;

export interface ThreadCheckpointAfterAssistant {
  phase: "after_assistant";
  runContext: RunContext<unknown>;
  assistantMessage: AssistantMessage;
  toolCalls: readonly ToolCall[];
}

export interface ThreadCheckpointAfterToolResult {
  phase: "after_tool_result";
  runContext: RunContext<unknown>;
  toolCall: ToolCall;
  toolResult: ToolResultMessage<JsonValue>;
  remainingToolCalls: readonly ToolCall[];
}

export type ThreadCheckpoint =
  | ThreadCheckpointAfterAssistant
  | ThreadCheckpointAfterToolResult;

export type ThreadCheckpointHandler = (
  checkpoint: ThreadCheckpoint,
) => Promise<ThreadCheckpointDecision | void> | ThreadCheckpointDecision | void;
