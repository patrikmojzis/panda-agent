import {ToolError} from "../../kernel/agent/exceptions.js";
import {trimToNull} from "../../lib/strings.js";

/**
 * Reads the current agent scope for telepathy tools so they cannot wander
 * across agents by accident.
 */
export function readTelepathyAgentKey(context: unknown, toolName: string): string {
  const agentKey = trimToNull(
    context && typeof context === "object" && !Array.isArray(context)
      ? (context as {agentKey?: unknown}).agentKey
      : null,
  );
  if (!agentKey) {
    throw new ToolError(`${toolName} requires agentKey in the current runtime session context.`);
  }

  return agentKey;
}
