/**
 * Returns the stable cache-affinity key for one append-only thread transcript.
 * Resets create a new thread, which intentionally starts a fresh cache lane.
 */
export function buildThreadPromptCacheKey(threadId: string): string {
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
  return trimmed && trimmed.length > 0
    ? trimmed
    : buildThreadPromptCacheKey(threadId);
}
