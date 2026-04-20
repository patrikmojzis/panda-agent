import type {ThinkingLevel} from "@mariozechner/pi-ai";
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
type DefaultAgentSubagentToolsetKey = Exclude<DefaultAgentToolsetKey, "main">;

interface DefaultAgentSubagentRolePolicy {
  role: DefaultAgentSubagentRole;
  prompt: string;
  toolset: DefaultAgentSubagentToolsetKey;
  visibleContextSections: readonly DefaultAgentLlmContextSection[];
  thinking: ThinkingLevel | undefined;
}

const DEFAULT_AGENT_SUBAGENT_ROLE_POLICIES: Record<DefaultAgentSubagentRole, DefaultAgentSubagentRolePolicy> = {
  workspace: {
    role: "workspace",
    prompt: WORKSPACE_SUBAGENT_PROMPT,
    toolset: "workspace",
    visibleContextSections: ["datetime", "environment"],
    thinking: "low",
  },
  memory: {
    role: "memory",
    prompt: MEMORY_SUBAGENT_PROMPT,
    toolset: "memory",
    visibleContextSections: ["datetime", "environment", "wiki_overview"],
    thinking: "medium",
  },
  browser: {
    role: "browser",
    prompt: BROWSER_SUBAGENT_PROMPT,
    toolset: "browser",
    visibleContextSections: ["datetime", "environment"],
    thinking: "medium",
  },
  skill_maintainer: {
    role: "skill_maintainer",
    prompt: SKILL_MAINTAINER_SUBAGENT_PROMPT,
    toolset: "skill_maintainer",
    visibleContextSections: ["datetime", "environment"],
    thinking: "medium",
  },
};

export function getDefaultAgentSubagentRolePolicy(role: DefaultAgentSubagentRole): DefaultAgentSubagentRolePolicy {
  return DEFAULT_AGENT_SUBAGENT_ROLE_POLICIES[role];
}
