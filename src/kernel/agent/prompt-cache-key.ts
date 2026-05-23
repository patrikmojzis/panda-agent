import {createHash} from "node:crypto";

const MAX_PROMPT_CACHE_KEY_LENGTH = 64;
const HASHED_PROMPT_CACHE_KEY_PREFIX = "pc:";

export function hashPromptCacheParts(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function boundPromptCacheKey(key: string): string {
  if (key.length <= MAX_PROMPT_CACHE_KEY_LENGTH) {
    return key;
  }

  return `${HASHED_PROMPT_CACHE_KEY_PREFIX}${hashPromptCacheParts([key]).slice(
    0,
    MAX_PROMPT_CACHE_KEY_LENGTH - HASHED_PROMPT_CACHE_KEY_PREFIX.length,
  )}`;
}

export function appendPromptCacheKeyParts(
  basePromptCacheKey: string | undefined,
  marker: string,
  parts: readonly string[],
): string | undefined {
  const trimmedBase = basePromptCacheKey?.trim();
  if (!trimmedBase) {
    return undefined;
  }

  if (parts.length === 0) {
    return boundPromptCacheKey(trimmedBase);
  }

  return boundPromptCacheKey([
    trimmedBase,
    marker,
    hashPromptCacheParts(parts).slice(0, 16),
  ].join(":"));
}
