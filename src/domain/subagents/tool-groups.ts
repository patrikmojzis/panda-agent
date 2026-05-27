import {uniqueTrimmedStrings} from "../../lib/strings.js";

export const SUBAGENT_TOOL_GROUP_DEFINITIONS = {
  core: {
    description: "Safe universal basics for ordinary delegated work and parent A2A updates.",
    toolNames: [
      "current_datetime",
      "message_agent",
      "image_generate",
      "whisper",
      "view_media",
      "todo_update",
    ],
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
  },
  execute: {
    description: "Active runtime execution and background job control.",
    toolNames: [
      "bash",
      "background_job_status",
      "background_job_wait",
      "background_job_cancel",
    ],
  },
  operate: {
    description: "Operational mutation and control surfaces.",
    toolNames: [
      "thinking_set",
      "agent_skill",
      "agent_prompt",
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
      "spawn_subagent",
    ],
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

  return normalized as SubagentToolGroup[];
}

export function expandSubagentToolGroups(groups: readonly SubagentToolGroup[]): string[] {
  return uniqueTrimmedStrings(groups.flatMap((group) => [
    ...SUBAGENT_TOOL_GROUP_DEFINITIONS[group].toolNames,
  ]));
}
