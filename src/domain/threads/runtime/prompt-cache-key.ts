import {createHash} from "node:crypto";

const MAX_PROMPT_CACHE_KEY_LENGTH = 64;
const HASHED_PROMPT_CACHE_KEY_PREFIX = "pc:";

/**
 * Returns the stable cache-affinity key for one append-only thread transcript.
 * Resets create a new thread, which intentionally starts a fresh cache lane.
 */
function buildThreadPromptCacheKey(threadId: string): string {
  return `thread:${threadId}`;
}

function hashPromptCacheParts(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function boundPromptCacheKey(key: string): string {
  if (key.length <= MAX_PROMPT_CACHE_KEY_LENGTH) {
    return key;
  }

  return `${HASHED_PROMPT_CACHE_KEY_PREFIX}${hashPromptCacheParts([key]).slice(
    0,
    MAX_PROMPT_CACHE_KEY_LENGTH - HASHED_PROMPT_CACHE_KEY_PREFIX.length,
  )}`;
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
