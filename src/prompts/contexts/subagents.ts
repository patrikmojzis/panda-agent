export interface RenderSubagentsContextProfile {
  slug: string;
  source: string;
  description: string;
  toolGroups: readonly string[];
  model?: string;
  thinking?: string;
}

export interface RenderSubagentsContextInput {
  profiles?: readonly RenderSubagentsContextProfile[];
  omittedProfileCount?: number;
}

function renderProfile(profile: RenderSubagentsContextProfile): string {
  return [
    `- ${profile.slug} (${profile.source}): ${profile.description}`,
    `toolGroups ${profile.toolGroups.join(", ")}`,
    profile.model ? `model ${profile.model}` : "",
    profile.thinking ? `thinking ${profile.thinking}` : "",
  ].filter(Boolean).join(" | ");
}

export function renderSubagentsContext(input: RenderSubagentsContextInput): string {
  const lines: string[] = [];
  if (input.profiles?.length || input.omittedProfileCount) {
    lines.push("Available subagent profiles:");
    lines.push(...(input.profiles ?? []).map(renderProfile));
    if ((input.omittedProfileCount ?? 0) > 0) {
      lines.push(`- ${input.omittedProfileCount} additional profiles omitted`);
    }
  }

  return lines.join("\n");
}
