import type {AssistantMessage, ToolCall, ToolResultMessage} from "@mariozechner/pi-ai";

import type {RunContext} from "./run-context.js";
import type {JsonValue} from "./types.js";

export type ThreadCheckpointDecision =
  | { action: "continue" }
  | {
    action: "interrupt";
    reason?: string;
    cancelPendingToolCalls?: boolean;
  };

export type ThreadCheckpoint =
  | {
    phase: "after_assistant";
    runContext: RunContext<unknown>;
    assistantMessage: AssistantMessage;
    toolCalls: readonly ToolCall[];
  }
  | {
    phase: "after_tool_result";
    runContext: RunContext<unknown>;
    toolCall: ToolCall;
    toolResult: ToolResultMessage<JsonValue>;
    remainingToolCalls: readonly ToolCall[];
  };

export type ThreadCheckpointHandler = (
  checkpoint: ThreadCheckpoint,
) => Promise<ThreadCheckpointDecision | void> | ThreadCheckpointDecision | void;
