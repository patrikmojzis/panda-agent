import {randomUUID} from "node:crypto";

import {resolveAgentMediaDir, resolveMediaDir} from "../../lib/data-dir.js";
import type {DefaultAgentSessionContext} from "../../app/runtime/panda-session-context.js";
import {ToolError} from "../../kernel/agent/exceptions.js";
import {normalizePathLabel, readSafePathSegment} from "../../lib/path-segments.js";
import {trimToNull, trimToUndefined} from "../../lib/strings.js";

/**
 * Validates agent keys before Panda tools use them in filesystem artifact paths.
 */
function safeToolArtifactAgentKey(agentKey: string, source: string): string {
  const trimmed = readSafePathSegment(agentKey);
  if (!trimmed) {
    throw new ToolError(`Unsafe agent key for ${source} artifact path: ${agentKey}`);
  }

  return trimmed;
}

/**
 * Normalizes transcript/thread labels into filesystem-safe artifact path tokens.
 */
function normalizeToolArtifactLabel(value: string): string {
  return normalizePathLabel(value);
}

export function resolveToolArtifactScopeKey(context: Partial<DefaultAgentSessionContext>): string {
  const threadId = trimToUndefined(context.threadId);
  return threadId ? normalizeToolArtifactLabel(threadId) : `ephemeral-${randomUUID()}`;
}

export function resolveToolArtifactMediaRoot(params: {
  context: Partial<DefaultAgentSessionContext> | undefined;
  env: NodeJS.ProcessEnv;
  source: string;
}): string {
  const agentKey = trimToNull(params.context?.agentKey);
  if (agentKey) {
    return resolveAgentMediaDir(safeToolArtifactAgentKey(agentKey, params.source), params.env);
  }

  return resolveMediaDir(params.env);
}
