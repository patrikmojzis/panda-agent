import type {Tool} from "../../agent-core/tool.js";
import type {PandaLlmContextSection} from "../contexts/index.js";

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
  "brave_search",
  "postgres_readonly_query",
]);

export const PANDA_SUBAGENT_ROLE_POLICIES: Record<PandaSubagentRole, PandaSubagentRolePolicy> = {
  explore: {
    role: "explore",
    prompt: [
      "You are Panda's explore subagent.",
      "You are running synchronously for the parent agent, not the end user.",
      "Investigate the assigned task, inspect the workspace, and return concise findings.",
      "Do not use outbound messaging, do not update memory, and do not spawn more subagents.",
      "If you cannot answer fully, say what you checked and what remains unknown.",
    ].join("\n"),
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
