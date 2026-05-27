import {describe, expect, it} from "vitest";

import {
  expandSubagentToolGroups,
  normalizeSubagentToolGroups,
  SUBAGENT_TOOL_GROUP_DEFINITIONS,
  SUBAGENT_TOOL_GROUP_KEYS,
} from "../src/domain/subagents/index.js";

describe("subagent tool groups", () => {
  it("keeps the approved V1 groups and raw tool membership explicit", () => {
    expect(SUBAGENT_TOOL_GROUP_KEYS).toEqual([
      "core",
      "workspace_read",
      "internet",
      "memory",
      "execute",
      "operate",
      "communicate_human",
    ]);

    expect(Object.fromEntries(
      SUBAGENT_TOOL_GROUP_KEYS.map((key) => [key, SUBAGENT_TOOL_GROUP_DEFINITIONS[key].toolNames]),
    )).toMatchInlineSnapshot(`
      {
        "communicate_human": [
          "outbound",
          "email_send",
          "telegram_react",
        ],
        "core": [
          "current_datetime",
          "message_agent",
          "image_generate",
          "whisper",
          "view_media",
          "todo_update",
        ],
        "execute": [
          "bash",
          "background_job_status",
          "background_job_wait",
          "background_job_cancel",
        ],
        "internet": [
          "web_fetch",
          "brave_search",
          "browser",
          "web_research",
        ],
        "memory": [
          "postgres_readonly_query",
          "wiki",
        ],
        "operate": [
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
        "workspace_read": [
          "read_file",
          "glob_files",
          "grep_files",
        ],
      }
    `);
  });

  it("expands groups to de-duplicated raw tool names", () => {
    expect(expandSubagentToolGroups(["core", "memory", "core"])).toEqual([
      "current_datetime",
      "message_agent",
      "image_generate",
      "whisper",
      "view_media",
      "todo_update",
      "postgres_readonly_query",
      "wiki",
    ]);
  });

  it("fails loudly for unknown tool groups instead of treating raw tool names as groups", () => {
    expect(() => normalizeSubagentToolGroups(["core", "bash"])).toThrow(
      'Unknown subagent tool group "bash".',
    );
  });
});
