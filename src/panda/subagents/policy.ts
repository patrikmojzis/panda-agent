import type {ThinkingLevel} from "@mariozechner/pi-ai";
import type {Tool} from "../../kernel/agent/tool.js";
import {
  BROWSER_SUBAGENT_PROMPT,
  MEMORY_SUBAGENT_PROMPT,
  WORKSPACE_SUBAGENT_PROMPT,
} from "../../prompts/runtime/subagents.js";
import type {PandaLlmContextSection} from "../contexts/builder.js";
import type {PandaToolsetKey} from "../definition.js";

export const PANDA_SUBAGENT_ROLES = ["workspace", "memory", "browser"] as const;
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
};

export const PANDA_SUBAGENT_ROLE_POLICIES: Record<PandaSubagentRole, PandaSubagentRolePolicy> = {
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
