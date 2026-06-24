import type {SessionPromptRecord} from "../../domain/sessions/types.js";
import {SESSION_BRIEF_PROMPT_SLUG, SESSION_MEMORY_PROMPT_SLUG} from "../../domain/sessions/types.js";

const RENDERED_SESSION_PROMPT_SLUGS = [
  SESSION_BRIEF_PROMPT_SLUG,
  SESSION_MEMORY_PROMPT_SLUG,
] as const;

export function renderSessionPromptsContext(options: {
  prompts: readonly SessionPromptRecord[];
}): string {
  const promptsBySlug = new Map(options.prompts.map((prompt) => [prompt.slug, prompt]));
  return RENDERED_SESSION_PROMPT_SLUGS
    .map((slug) => {
      const content = promptsBySlug.get(slug)?.content.trim();
      return content ? `[${slug}]\n${content}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
}
