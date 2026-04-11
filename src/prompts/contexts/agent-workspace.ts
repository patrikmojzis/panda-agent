export interface AgentWorkspaceDocSection {
  slug: string;
  content: string;
}

export interface AgentWorkspaceDiaryEntry {
  entryDate: string;
  content: string;
}

export interface AgentWorkspaceSkillEntry {
  name: string;
  content: string;
}

export function renderAgentWorkspaceContext(options: {
  agentKey: string;
  identityId: string;
  agentDocs?: readonly AgentWorkspaceDocSection[];
  relationshipMemory?: string;
  recentDiary?: readonly AgentWorkspaceDiaryEntry[];
  skills?: readonly AgentWorkspaceSkillEntry[];
}): string {
  const blocks = [`
Agent key: ${options.agentKey}
Relationship identity: ${options.identityId}
`.trim()];

  if (options.agentDocs) {
    blocks.push(...options.agentDocs.map((doc) => `
[${doc.slug}]
${doc.content || "(empty)"}
`.trim()));
  }

  if (options.relationshipMemory !== undefined) {
    blocks.push(`
[memory]
${options.relationshipMemory || "(empty)"}
`.trim());
  }

  if (options.recentDiary !== undefined) {
    blocks.push(`
[recent diary]
${options.recentDiary.length === 0
    ? "(empty)"
    : options.recentDiary.map((entry) => `${entry.entryDate}\n${entry.content || "(empty)"}`).join("\n\n")}
`.trim());
  }

  if (options.skills !== undefined) {
    blocks.push(`
[skills]
${options.skills.length === 0
    ? "(none)"
    : options.skills.map((entry) => `${entry.name}\n${entry.content}`).join("\n\n")}
`.trim());
  }

  return blocks.join("\n\n");
}
