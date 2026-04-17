import type {ThinkingLevel} from "@mariozechner/pi-ai";
import type {Tool} from "../../kernel/agent/tool.js";
import {
    BROWSER_SUBAGENT_PROMPT,
    MEMORY_SUBAGENT_PROMPT,
    SKILL_MAINTAINER_SUBAGENT_PROMPT,
    WORKSPACE_SUBAGENT_PROMPT,
} from "../../prompts/runtime/subagents.js";
import type {DefaultAgentLlmContextSection} from "../contexts/builder.js";
import type {DefaultAgentToolsetKey} from "../definition.js";

export const DEFAULT_AGENT_SUBAGENT_ROLES = ["workspace", "memory", "browser", "skill_maintainer"] as const;
export type DefaultAgentSubagentRole = typeof DEFAULT_AGENT_SUBAGENT_ROLES[number];
export type DefaultAgentSubagentToolsetKey = Exclude<DefaultAgentToolsetKey, "main">;

export interface DefaultAgentSubagentRolePolicy {
  role: DefaultAgentSubagentRole;
  prompt: string;
  toolset: DefaultAgentSubagentToolsetKey;
  visibleContextSections: readonly DefaultAgentLlmContextSection[];
  thinking: ThinkingLevel | undefined;
  maySpawnSubagents: boolean;
}

export const DEFAULT_AGENT_SUBAGENT_TOOLSET_FILTERS: Record<DefaultAgentSubagentToolsetKey, ReadonlySet<string>> = {
  workspace: new Set([
    "read_file",
    "glob_files",
    "grep_files",
    "view_media",
  ]),
  memory: new Set([
    "postgres_readonly_query",
  ]),
  browser: new Set([
    "read_file",
    "glob_files",
    "grep_files",
    "view_media",
    "browser",
  ]),
  skill_maintainer: new Set([
    "postgres_readonly_query",
    "agent_skill",
  ]),
};

export const DEFAULT_AGENT_SUBAGENT_ROLE_POLICIES: Record<DefaultAgentSubagentRole, DefaultAgentSubagentRolePolicy> = {
  workspace: {
    role: "workspace",
    prompt: WORKSPACE_SUBAGENT_PROMPT,
    toolset: "workspace",
    visibleContextSections: ["datetime", "environment"],
    thinking: "low",
    maySpawnSubagents: false,
  },
  memory: {
    role: "memory",
    prompt: MEMORY_SUBAGENT_PROMPT,
    toolset: "memory",
    visibleContextSections: ["datetime", "environment"],
    thinking: "medium",
    maySpawnSubagents: false,
  },
  browser: {
    role: "browser",
    prompt: BROWSER_SUBAGENT_PROMPT,
    toolset: "browser",
    visibleContextSections: ["datetime", "environment"],
    thinking: "medium",
    maySpawnSubagents: false,
  },
  skill_maintainer: {
    role: "skill_maintainer",
    prompt: SKILL_MAINTAINER_SUBAGENT_PROMPT,
    toolset: "skill_maintainer",
    visibleContextSections: ["datetime", "environment"],
    thinking: "medium",
    maySpawnSubagents: false,
  },
};

export function getDefaultAgentSubagentRolePolicy(role: DefaultAgentSubagentRole): DefaultAgentSubagentRolePolicy {
  return DEFAULT_AGENT_SUBAGENT_ROLE_POLICIES[role];
}

export function filterToolsForSubagentRole(
  tools: readonly Tool[],
  role: DefaultAgentSubagentRole,
): readonly Tool[] {
  const policy = getDefaultAgentSubagentRolePolicy(role);
  const allowedToolNames = [...DEFAULT_AGENT_SUBAGENT_TOOLSET_FILTERS[policy.toolset]];
  return allowedToolNames.flatMap((toolName) => {
    const tool = tools.find((candidate) => candidate.name === toolName);
    return tool ? [tool] : [];
  });
}
