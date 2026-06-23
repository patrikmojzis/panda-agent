import type {AgentSkillOperation, ExecutionToolPolicy} from "../execution-environments/types.js";
import {normalizeAgentSkillOperations} from "../execution-environments/policy.js";
import {uniqueTrimmedStrings} from "../../lib/strings.js";

const ALL_AGENT_SKILL_OPERATIONS: readonly AgentSkillOperation[] = ["load", "set", "update_description", "delete"];

export const SUBAGENT_TOOL_GROUP_DEFINITIONS = {
  core: {
    description: "Safe universal basics for ordinary delegated work and parent A2A updates.",
    toolNames: [
      "current_datetime",
      "message_agent",
      "agent_skill",
      "image_generate",
      "whisper",
      "view_media",
      "todo_update",
      "vent",
    ],
    agentSkillOperations: ["load"],
  },
  workspace_read: {
    description: "Read-only workspace and artifact inspection.",
    toolNames: [
      "read_file",
      "glob_files",
      "grep_files",
    ],
  },
  internet: {
    description: "Public web lookup, research, and browser inspection.",
    toolNames: [
      "web_fetch",
      "brave_search",
      "browser",
      "web_research",
    ],
  },
  memory: {
    description: "Read/query durable Panda memory surfaces.",
    toolNames: [
      "postgres_readonly_query",
      "wiki",
    ],
    postgresReadonly: {allowed: true},
  },
  execute: {
    description: "Active runtime execution and background job control.",
    toolNames: [
      "bash",
      "background_job_status",
      "background_job_wait",
      "background_job_cancel",
    ],
    bash: {allowed: true},
  },
  skill_maintenance: {
    description: "Narrow durable skill load/create/update/delete access without broad operational tools.",
    toolNames: [
      "agent_skill",
    ],
    agentSkillOperations: ALL_AGENT_SKILL_OPERATIONS,
  },
  operate: {
    description: "Operational mutation and control surfaces.",
    toolNames: [
      "thinking_set",
      "agent_skill",
      "agent_prompt",
      "upsert_subagent_profile",
      "set_env_value",
      "clear_env_value",
      "app_create",
      "app_list",
      "app_link_create",
      "app_check",
      "app_view",
      "app_action",
      "scheduled_task_create",
      "scheduled_task_update",
      "scheduled_task_cancel",
      "watch_schema_get",
      "watch_create",
      "watch_update",
      "watch_disable",
      "environment_create",
      "environment_stop",
    ],
    agentSkillOperations: ALL_AGENT_SKILL_OPERATIONS,
  },
  communicate_human: {
    description: "Human/channel outbound communication surfaces.",
    toolNames: [
      "outbound",
      "email_send",
      "telegram_react",
    ],
  },
} as const;

export type SubagentToolGroup = keyof typeof SUBAGENT_TOOL_GROUP_DEFINITIONS;

export const SUBAGENT_TOOL_GROUP_KEYS = Object.keys(
  SUBAGENT_TOOL_GROUP_DEFINITIONS,
) as SubagentToolGroup[];

const EXCLUSIVE_SUBAGENT_TOOL_GROUP_PAIRS: readonly (readonly [SubagentToolGroup, SubagentToolGroup])[] = [
  ["workspace_read", "execute"],
];

const SUBAGENT_TOOL_GROUP_KEY_SET = new Set<string>(SUBAGENT_TOOL_GROUP_KEYS);

export function isSubagentToolGroup(value: unknown): value is SubagentToolGroup {
  return typeof value === "string" && SUBAGENT_TOOL_GROUP_KEY_SET.has(value);
}

export function normalizeSubagentToolGroups(values: readonly string[]): SubagentToolGroup[] {
  const normalized = uniqueTrimmedStrings(values);
  const unknown = normalized.filter((value) => !isSubagentToolGroup(value));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown subagent tool group ${JSON.stringify(unknown[0])}. Expected one of: ${SUBAGENT_TOOL_GROUP_KEYS.join(", ")}.`,
    );
  }

  const selected = new Set(normalized);
  for (const [left, right] of EXCLUSIVE_SUBAGENT_TOOL_GROUP_PAIRS) {
    if (selected.has(left) && selected.has(right)) {
      throw new Error(
        `Subagent tool groups ${left} and ${right} are mutually exclusive. Choose ${left} for read-only workspace wrapper tools, or ${right} for shell/background execution; ${right} can read workspace files through shell commands, so do not combine them.`,
      );
    }
  }

  return normalized as SubagentToolGroup[];
}

export function expandSubagentToolGroups(groups: readonly SubagentToolGroup[]): string[] {
  return uniqueTrimmedStrings(groups.flatMap((group) => [
    ...SUBAGENT_TOOL_GROUP_DEFINITIONS[group].toolNames,
  ]));
}

export function resolveSubagentToolPolicy(groups: readonly SubagentToolGroup[]): ExecutionToolPolicy {
  const normalizedGroups = normalizeSubagentToolGroups(groups);
  const allowedTools = expandSubagentToolGroups(normalizedGroups);
  const agentSkillOperations = normalizeAgentSkillOperations(normalizedGroups.flatMap((group) => {
    const definition = SUBAGENT_TOOL_GROUP_DEFINITIONS[group];
    return "agentSkillOperations" in definition ? [...definition.agentSkillOperations] : [];
  }));
  const grantsBash = normalizedGroups.some((group) => {
    const definition = SUBAGENT_TOOL_GROUP_DEFINITIONS[group];
    return "bash" in definition && definition.bash.allowed === true;
  });
  const grantsPostgresReadonly = normalizedGroups.some((group) => {
    const definition = SUBAGENT_TOOL_GROUP_DEFINITIONS[group];
    return "postgresReadonly" in definition && definition.postgresReadonly.allowed === true;
  });

  return {
    ...(allowedTools.length > 0 ? {allowedTools} : {}),
    ...(grantsBash ? {bash: {allowed: true}} : {}),
    ...(grantsPostgresReadonly ? {postgresReadonly: {allowed: true}} : {}),
    ...(agentSkillOperations.length > 0
      ? {agentSkill: {allowedOperations: agentSkillOperations}}
      : {}),
  };
}
