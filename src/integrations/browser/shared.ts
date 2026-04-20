import {randomUUID} from "node:crypto";

import type {DefaultAgentSessionContext} from "../../app/runtime/panda-session-context.js";
import {trimToUndefined} from "../../lib/strings.js";
import {ToolError} from "../../kernel/agent/exceptions.js";

export {buildEndpointUrl as buildRunnerEndpoint} from "../../lib/http.js";

/**
 * Normalizes browser labels into a filesystem-safe token.
 */
export function normalizeBrowserLabelValue(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 120) || "unknown";
}

/**
 * Validates agent keys before they are used in browser-owned filesystem paths.
 */
export function safeAgentKey(agentKey: string): string {
  const trimmed = agentKey.trim();
  if (!trimmed || /[\\/]/.test(trimmed) || trimmed.includes("..")) {
    throw new ToolError(`Unsafe agent key for browser artifact path: ${agentKey}`);
  }

  return trimmed;
}

/**
 * Resolves the browser session scope key from the runtime session context.
 */
export function normalizeBrowserScopeKey(
  context: DefaultAgentSessionContext,
): {scope: "thread" | "ephemeral"; key: string} {
  const threadId = trimToUndefined(context.threadId);
  if (threadId) {
    return {
      scope: "thread",
      key: threadId,
    };
  }

  return {
    scope: "ephemeral",
    key: `ephemeral-${randomUUID()}`,
  };
}
