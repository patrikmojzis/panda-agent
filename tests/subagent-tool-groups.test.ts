import {describe, expect, it} from "vitest";

import {
  expandSubagentToolGroups,
  normalizeSubagentToolGroups,
  resolveSubagentToolPolicy,
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
      "skill_maintenance",
      "operate",
      "communicate_human",
    ]);

    expect(Object.fromEntries(
      SUBAGENT_TOOL_GROUP_KEYS.map((key) => [key, {
        toolNames: SUBAGENT_TOOL_GROUP_DEFINITIONS[key].toolNames,
        agentSkillOperations: "agentSkillOperations" in SUBAGENT_TOOL_GROUP_DEFINITIONS[key]
          ? SUBAGENT_TOOL_GROUP_DEFINITIONS[key].agentSkillOperations
          : undefined,
      }]),
    )).toMatchInlineSnapshot(`
      {
        "communicate_human": {
          "agentSkillOperations": undefined,
          "toolNames": [
            "outbound",
            "email_send",
            "telegram_react",
          ],
        },
        "core": {
          "agentSkillOperations": [
            "load",
          ],
          "toolNames": [
            "current_datetime",
            "message_agent",
            "agent_skill",
            "image_generate",
            "whisper",
            "view_media",
            "todo_update",
            "vent",
          ],
        },
        "execute": {
          "agentSkillOperations": undefined,
          "toolNames": [
            "bash",
            "background_job_status",
            "background_job_wait",
            "background_job_cancel",
          ],
        },
        "internet": {
          "agentSkillOperations": undefined,
          "toolNames": [
            "web_fetch",
            "brave_search",
            "browser",
            "web_research",
          ],
        },
        "memory": {
          "agentSkillOperations": undefined,
          "toolNames": [
            "postgres_readonly_query",
            "wiki",
          ],
        },
        "operate": {
          "agentSkillOperations": [
            "load",
            "set",
            "delete",
          ],
          "toolNames": [
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
        },
        "skill_maintenance": {
          "agentSkillOperations": [
            "load",
            "set",
            "delete",
          ],
          "toolNames": [
            "agent_skill",
          ],
        },
        "workspace_read": {
          "agentSkillOperations": undefined,
          "toolNames": [
            "read_file",
            "glob_files",
            "grep_files",
          ],
        },
      }
    `);
  });

  it("expands groups to de-duplicated raw tool names", () => {
    expect(expandSubagentToolGroups(["core", "memory", "core"])).toEqual([
      "current_datetime",
      "message_agent",
      "agent_skill",
      "image_generate",
      "whisper",
      "view_media",
      "todo_update",
      "vent",
      "postgres_readonly_query",
      "wiki",
    ]);
  });

  it("resolves operation-aware execution tool policies", () => {
    expect(resolveSubagentToolPolicy(["core"])).toMatchObject({
      allowedTools: expect.arrayContaining(["agent_skill", "message_agent", "vent"]),
      agentSkill: {
        allowedOperations: ["load"],
      },
    });
    expect(resolveSubagentToolPolicy(["core", "skill_maintenance"])).toMatchObject({
      agentSkill: {
        allowedOperations: ["load", "set", "delete"],
      },
    });
    expect(resolveSubagentToolPolicy(["core", "memory", "execute"])).toMatchObject({
      bash: {allowed: true},
      postgresReadonly: {allowed: true},
    });
    expect(resolveSubagentToolPolicy(["skill_maintenance"]).allowedTools).toEqual(["agent_skill"]);
    expect(resolveSubagentToolPolicy(["operate"]).agentSkill?.allowedOperations).toEqual(["load", "set", "delete"]);
  });

  it("fails loudly for unknown tool groups instead of treating raw tool names as groups", () => {
    expect(() => normalizeSubagentToolGroups(["core", "bash"])).toThrow(
      'Unknown subagent tool group "bash".',
    );
  });

  it("rejects read-only workspace and execution groups together", () => {
    expect(() => normalizeSubagentToolGroups(["core", "workspace_read", "execute"])).toThrow(
      "Subagent tool groups workspace_read and execute are mutually exclusive.",
    );
    expect(() => resolveSubagentToolPolicy(["workspace_read", "execute"])).toThrow(
      "execute can read workspace files through shell commands, so do not combine them.",
    );
  });
});
