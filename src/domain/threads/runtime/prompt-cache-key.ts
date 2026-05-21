import {createHash} from "node:crypto";

/**
 * Returns the stable cache-affinity key for one append-only thread transcript.
 * Resets create a new thread, which intentionally starts a fresh cache lane.
 */
function buildThreadPromptCacheKey(threadId: string): string {
  return `thread:${threadId}`;
}

/**
 * Preserves an explicit prompt cache key when present, otherwise falls back to
 * the default thread-scoped cache-affinity key.
 */
export function resolveThreadPromptCacheKey(
  threadId: string,
  promptCacheKey?: string | null,
): string {
  const trimmed = promptCacheKey?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : buildThreadPromptCacheKey(threadId);
}

export interface SessionPromptCacheVersion {
  slug: string;
  content: string;
  updatedAt: number;
}

function hashSessionPromptContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export function resolveSessionPromptCacheKey(
  basePromptCacheKey: string,
  sessionPrompt?: SessionPromptCacheVersion | null,
): string {
  if (!sessionPrompt) {
    return basePromptCacheKey;
  }

  return [
    basePromptCacheKey,
    "session-prompt",
    sessionPrompt.slug,
    String(sessionPrompt.updatedAt),
    hashSessionPromptContent(sessionPrompt.content),
  ].join(":");
}
