import type {Tool} from "../../../kernel/agent/tool.js";
import {EXPLORE_SUBAGENT_PROMPT} from "../../../prompts/runtime/subagents.js";
import type {PandaLlmContextSection} from "../contexts/builder.js";

export type PandaSubagentRole = "explore";

export interface PandaSubagentRolePolicy {
  role: PandaSubagentRole;
  prompt: string;
  allowedToolNames: ReadonlySet<string>;
  visibleContextSections: readonly PandaLlmContextSection[];
  maySpawnSubagents: boolean;
}

const exploreAllowedToolNames = new Set([
  "bash",
  "view_media",
  "web_fetch",
  "brave_search",
  "postgres_readonly_query",
]);

export const PANDA_SUBAGENT_ROLE_POLICIES: Record<PandaSubagentRole, PandaSubagentRolePolicy> = {
  explore: {
    role: "explore",
    prompt: EXPLORE_SUBAGENT_PROMPT,
    allowedToolNames: exploreAllowedToolNames,
    visibleContextSections: ["datetime", "environment"],
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
