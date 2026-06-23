import {boundPromptCacheKey, hashPromptCacheParts} from "../../../kernel/agent/prompt-cache-key.js";
import {SESSION_BRIEF_PROMPT_SLUG, SESSION_MEMORY_PROMPT_SLUG} from "../../sessions/types.js";

const CACHE_AFFECTING_SESSION_PROMPT_SLUGS: ReadonlySet<string> = new Set([
  SESSION_BRIEF_PROMPT_SLUG,
  SESSION_MEMORY_PROMPT_SLUG,
]);

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
  sessionPrompts?: readonly SessionPromptCacheVersion[] | null,
): string {
  if (!sessionPrompts?.length) {
    return boundPromptCacheKey(basePromptCacheKey);
  }

  const promptParts = [...sessionPrompts]
    .filter((prompt) => CACHE_AFFECTING_SESSION_PROMPT_SLUGS.has(prompt.slug))
    .sort((left, right) => left.slug.localeCompare(right.slug))
    .map(buildSessionPromptCacheVersion);
  if (promptParts.length === 0) {
    return boundPromptCacheKey(basePromptCacheKey);
  }

  return boundPromptCacheKey([
    basePromptCacheKey,
    "sp",
    ...promptParts,
  ].join(":"));
}
