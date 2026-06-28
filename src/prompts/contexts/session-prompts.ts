interface RenderableSessionPromptRecord {
  slug: string;
  content: string;
}

const RENDERED_SESSION_PROMPT_SLUGS = ["brief", "memory"] as const;

export function renderSessionPromptsContext(options: {
  prompts: readonly RenderableSessionPromptRecord[];
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
