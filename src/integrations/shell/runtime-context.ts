import {ToolError} from "../../kernel/agent/exceptions.js";

/**
 * Reads the current runtime session thread id from shell-related tool context.
 */
export function readThreadId(
  context: {
    threadId?: string;
  } | undefined,
): string {
  const threadId = context?.threadId?.trim();
  if (!threadId) {
    throw new ToolError("Background bash jobs require the current runtime session thread.");
  }

  return threadId;
}
