import type {ThinkingLevel} from "@mariozechner/pi-ai";
import type {Tool} from "../../../kernel/agent/tool.js";
import {EXPLORE_SUBAGENT_PROMPT, MEMORY_EXPLORER_SUBAGENT_PROMPT,} from "../../../prompts/runtime/subagents.js";
import type {PandaLlmContextSection} from "../contexts/builder.js";

export const PANDA_SUBAGENT_ROLES = ["explore", "memory_explorer"] as const;
export type PandaSubagentRole = typeof PANDA_SUBAGENT_ROLES[number];

export interface PandaSubagentRolePolicy {
  role: PandaSubagentRole;
  prompt: string;
  allowedToolNames: ReadonlySet<string>;
  visibleContextSections: readonly PandaLlmContextSection[];
  thinking: ThinkingLevel | undefined;
  maySpawnSubagents: boolean;
}

const exploreAllowedToolNames = new Set([
  "read_file",
  "glob_files",
  "grep_files",
  "view_media",
  "web_fetch",
]);

const memoryExplorerAllowedToolNames = new Set([
  "postgres_readonly_query",
]);

export const PANDA_SUBAGENT_ROLE_POLICIES: Record<PandaSubagentRole, PandaSubagentRolePolicy> = {
  explore: {
    role: "explore",
    prompt: EXPLORE_SUBAGENT_PROMPT,
    allowedToolNames: exploreAllowedToolNames,
    visibleContextSections: ["datetime", "environment"],
    thinking: "low",
    maySpawnSubagents: false,
  },
  memory_explorer: {
    role: "memory_explorer",
    prompt: MEMORY_EXPLORER_SUBAGENT_PROMPT,
    allowedToolNames: memoryExplorerAllowedToolNames,
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
  return tools.filter((tool) => policy.allowedToolNames.has(tool.name));
}
