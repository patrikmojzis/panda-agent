import type {ThinkingLevel} from "@mariozechner/pi-ai";
import type {Tool} from "../../kernel/agent/tool.js";
import {EXPLORE_SUBAGENT_PROMPT, MEMORY_EXPLORER_SUBAGENT_PROMPT,} from "../../prompts/runtime/subagents.js";
import type {PandaLlmContextSection} from "../contexts/builder.js";
import type {PandaToolsetKey} from "../definition.js";

export const PANDA_SUBAGENT_ROLES = ["explore", "memory_explorer"] as const;
export type PandaSubagentRole = typeof PANDA_SUBAGENT_ROLES[number];
export type PandaSubagentToolsetKey = Exclude<PandaToolsetKey, "main">;

export interface PandaSubagentRolePolicy {
  role: PandaSubagentRole;
  prompt: string;
  toolset: PandaSubagentToolsetKey;
  visibleContextSections: readonly PandaLlmContextSection[];
  thinking: ThinkingLevel | undefined;
  maySpawnSubagents: boolean;
}

export const PANDA_SUBAGENT_TOOLSET_FILTERS: Record<PandaSubagentToolsetKey, ReadonlySet<string>> = {
  explore: new Set([
    "read_file",
    "glob_files",
    "grep_files",
    "view_media",
  ]),
  memoryExplorer: new Set([
    "postgres_readonly_query",
  ]),
};

export const PANDA_SUBAGENT_ROLE_POLICIES: Record<PandaSubagentRole, PandaSubagentRolePolicy> = {
  explore: {
    role: "explore",
    prompt: EXPLORE_SUBAGENT_PROMPT,
    toolset: "explore",
    visibleContextSections: ["datetime", "environment"],
    thinking: "low",
    maySpawnSubagents: false,
  },
  memory_explorer: {
    role: "memory_explorer",
    prompt: MEMORY_EXPLORER_SUBAGENT_PROMPT,
    toolset: "memoryExplorer",
    visibleContextSections: ["datetime", "environment"],
    thinking: "medium",
    maySpawnSubagents: false,
  },
};

export function getPandaSubagentRolePolicy(role: PandaSubagentRole): PandaSubagentRolePolicy {
  return PANDA_SUBAGENT_ROLE_POLICIES[role];
}

export function filterToolsForSubagentRole(
  tools: readonly Tool[],
  role: PandaSubagentRole,
): readonly Tool[] {
  const policy = getPandaSubagentRolePolicy(role);
  const allowedToolNames = [...PANDA_SUBAGENT_TOOLSET_FILTERS[policy.toolset]];
  return allowedToolNames.flatMap((toolName) => {
    const tool = tools.find((candidate) => candidate.name === toolName);
    return tool ? [tool] : [];
  });
}
