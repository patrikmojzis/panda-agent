export interface AgentProfilePromptEntry {
  slug: string;
  content: string;
}

export interface AgentProfileSkillEntry {
  skillKey: string;
  description: string;
  tags?: readonly string[];
}

export function renderAgentProfileContext(options: {
  agentKey: string;
  prompts?: readonly AgentProfilePromptEntry[];
  skills?: readonly AgentProfileSkillEntry[];
}): string {
  const blocks = [`Agent key: ${options.agentKey}`];

  if (options.prompts) {
    blocks.push(...options.prompts.map((prompt) => `
[${prompt.slug}]
${prompt.content || "(empty)"}
`.trim()));
  }

  if (options.skills !== undefined) {
    blocks.push(`
[skills]
Summaries only. Query \`session.agent_skills\` for full skill bodies when you need the exact content.
${options.skills.length === 0
    ? "(none)"
    : options.skills.map((entry) => renderSkillSummary(entry)).join("\n")}
`.trim());
  }

  return blocks.join("\n\n");
}

function renderSkillSummary(entry: AgentProfileSkillEntry): string {
  const tags = entry.tags?.length ? ` [${entry.tags.join(", ")}]` : "";
  return `${entry.skillKey}${tags}: ${entry.description}`;
}
