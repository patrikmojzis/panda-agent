export interface RenderSubagentsContextProfile {
  slug: string;
  source: string;
  description: string;
  toolGroups: readonly string[];
  model?: string;
  thinking?: string;
}

export interface RenderSubagentsContextSubagent {
  sessionId: string;
  profile: string;
  execution: "agent_workspace" | "isolated_environment";
  startedAt: string;
  lastActivityAt: string;
  task: string;
  environmentId?: string;
}

export interface RenderSubagentsContextOmittedGroup {
  category: string;
  count: number;
  statuses?: readonly string[];
  profiles?: readonly string[];
}

export interface RenderSubagentsContextOmittedHistory {
  count: number;
  cutoff: string;
  groups: readonly RenderSubagentsContextOmittedGroup[];
}

export interface RenderSubagentsContextEnvironment {
  environmentId: string;
  state: string;
  startedAt: string;
  updatedAt: string;
  workspacePath?: string;
  inboxPath?: string;
  artifactsPath?: string;
  subagents: readonly RenderSubagentsContextSubagent[];
  omittedSubagentCount?: number;
}

export interface RenderSubagentsContextInput {
  profiles?: readonly RenderSubagentsContextProfile[];
  omittedProfileCount?: number;
  agentWorkspaceSubagents?: readonly RenderSubagentsContextSubagent[];
  environments?: readonly RenderSubagentsContextEnvironment[];
  unavailableEnvironmentSubagents?: readonly RenderSubagentsContextSubagent[];
  omittedHistory?: RenderSubagentsContextOmittedHistory;
}

function renderProfile(profile: RenderSubagentsContextProfile): string {
  return [
    `- ${profile.slug} (${profile.source}): ${profile.description}`,
    `toolGroups ${profile.toolGroups.join(", ")}`,
    profile.model ? `model ${profile.model}` : "",
    profile.thinking ? `thinking ${profile.thinking}` : "",
  ].filter(Boolean).join(" | ");
}

function renderSubagent(subagent: RenderSubagentsContextSubagent): string {
  return [
    subagent.sessionId,
    `profile ${subagent.profile}`,
    `execution ${subagent.execution}`,
    subagent.environmentId ? `environment ${subagent.environmentId}` : "",
    `started ${subagent.startedAt}`,
    `last activity ${subagent.lastActivityAt}`,
    `task ${subagent.task}`,
  ].filter(Boolean).join(" | ");
}

function renderOmittedHistoryGroup(group: RenderSubagentsContextOmittedGroup): string {
  return [
    `- ${group.category}: ${group.count}`,
    group.statuses?.length ? `statuses ${group.statuses.join(", ")}` : "",
    group.profiles?.length ? `profiles ${group.profiles.join(", ")}` : "",
  ].filter(Boolean).join(" | ");
}

function renderEnvironment(environment: RenderSubagentsContextEnvironment): string {
  const parts = [
    environment.environmentId,
    `state ${environment.state}`,
    `started ${environment.startedAt}`,
    `updated ${environment.updatedAt}`,
  ];
  const paths = [
    environment.workspacePath ? `workspace ${environment.workspacePath}` : "",
    environment.inboxPath ? `inbox ${environment.inboxPath}` : "",
    environment.artifactsPath ? `artifacts ${environment.artifactsPath}` : "",
  ].filter(Boolean);
  const renderedSubagents = environment.subagents.map((subagent) => renderSubagent(subagent)).join("; ");
  const omittedSubagentCount = environment.omittedSubagentCount ?? 0;
  const omitted = omittedSubagentCount > 0
    ? `${renderedSubagents ? "; " : ""}${omittedSubagentCount} older ${omittedSubagentCount === 1 ? "subagent" : "subagents"} omitted`
    : "";
  const subagents = renderedSubagents || omitted
    ? ` | subagents ${renderedSubagents}${omitted}`
    : " | subagents none";
  return `- ${parts.join(" | ")}${paths.length ? ` | ${paths.join(" | ")}` : ""}${subagents}`;
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

  if (input.agentWorkspaceSubagents?.length) {
    if (lines.length) {
      lines.push("");
    }
    lines.push("Agent workspace subagents:");
    lines.push(...input.agentWorkspaceSubagents.map((subagent) => `- ${renderSubagent(subagent)}`));
  }

  if (input.environments?.length) {
    if (lines.length) {
      lines.push("");
    }
    lines.push("Isolated environment subagents:");
    lines.push(...input.environments.map(renderEnvironment));
  }

  if (input.unavailableEnvironmentSubagents?.length) {
    if (lines.length) {
      lines.push("");
    }
    lines.push("Subagents with unavailable environments:");
    lines.push(...input.unavailableEnvironmentSubagents.map((subagent) => `- ${renderSubagent(subagent)}`));
  }

  if (input.omittedHistory && input.omittedHistory.count > 0) {
    if (lines.length) {
      lines.push("");
    }
    lines.push(`Subagents omitted from default context: ${input.omittedHistory.count}. Default lists only available subagents with last activity at or after ${input.omittedHistory.cutoff}; unavailable subagents are summarized here. Query session.subagent_history with postgres_readonly_query for details.`);
    lines.push(...input.omittedHistory.groups.map(renderOmittedHistoryGroup));
  }

  return lines.join("\n");
}
