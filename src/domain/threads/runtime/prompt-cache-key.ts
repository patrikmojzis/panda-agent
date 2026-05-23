import {boundPromptCacheKey, hashPromptCacheParts} from "../../../kernel/agent/prompt-cache-key.js";

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
  return boundPromptCacheKey(
    trimmed && trimmed.length > 0 ? trimmed : buildThreadPromptCacheKey(threadId),
  );
}

export interface SessionPromptCacheVersion {
  slug: string;
  content: string;
  updatedAt: number;
}

function buildSessionPromptCacheVersion(sessionPrompt: SessionPromptCacheVersion): string {
  return hashPromptCacheParts([
    sessionPrompt.slug,
    String(sessionPrompt.updatedAt),
    sessionPrompt.content,
  ]).slice(0, 16);
}

export function resolveSessionPromptCacheKey(
  basePromptCacheKey: string,
  sessionPrompt?: SessionPromptCacheVersion | null,
): string {
  if (!sessionPrompt) {
    return boundPromptCacheKey(basePromptCacheKey);
  }

  return boundPromptCacheKey([
    basePromptCacheKey,
    "sp",
    buildSessionPromptCacheVersion(sessionPrompt),
  ].join(":"));
}
