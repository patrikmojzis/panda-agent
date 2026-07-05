import {describe, expect, it} from "vitest";

import {createCommandCatalog} from "../src/domain/commands/index.js";
import {
  describeSubagentToolGroups,
  expandSubagentToolGroups,
  normalizePersistedSubagentToolGroups,
  normalizeSubagentToolGroups,
  resolveSubagentToolPolicy,
  SUBAGENT_TOOL_GROUP_DEFINITIONS,
  SUBAGENT_TOOL_GROUP_KEYS,
} from "../src/domain/subagents/index.js";
import {DEFAULT_AGENT_COMMAND_CATALOG} from "../src/panda/commands/agent-command-modules.js";

describe("subagent tool groups", () => {
  it("keeps the approved V1 groups and raw tool membership explicit", () => {
    expect(SUBAGENT_TOOL_GROUP_KEYS).toEqual([
      "core",
      "internet",
      "memory",
      "execute",
      "skill_maintenance",
      "operate",
      "communicate_human",
    ]);

    const groups = describeSubagentToolGroups({
      commandCatalog: DEFAULT_AGENT_COMMAND_CATALOG,
    });
    expect(Object.fromEntries(
      SUBAGENT_TOOL_GROUP_KEYS.map((key) => [key, {
        toolNames: groups[key].toolNames,
        agentSkillOperations: "agentSkillOperations" in groups[key]
          ? groups[key].agentSkillOperations
          : undefined,
      }]),
    )).toMatchInlineSnapshot(`
      {
        "communicate_human": {
          "agentSkillOperations": undefined,
          "toolNames": [
            "email.account.list",
            "email.list",
            "email.read",
            "email.search",
            "email.attachments.fetch",
            "email.send",
            "telegram.chat.list",
            "telegram.chat.info",
            "telegram.history",
            "telegram.media.fetch",
            "telegram.send",
            "telegram.react",
            "telegram.edit",
            "telegram.delete",
            "telegram.pin",
            "telegram.unpin",
            "telegram.sticker.send",
            "discord.channel.list",
            "discord.history",
            "discord.send",
            "whatsapp.chat.list",
            "whatsapp.history",
            "whatsapp.send",
          ],
        },
        "core": {
          "agentSkillOperations": [
            "load",
          ],
          "toolNames": [
            "bash",
            "background_job_status",
            "background_job_wait",
            "background_job_cancel",
            "view_media",
            "skill.list",
            "skill.show",
            "skill.load",
            "todo.add",
            "todo.list",
            "todo.show",
            "todo.done",
            "todo.block",
            "todo.clear",
            "a2a.send",
            "a2a.inspect",
            "a2a.history",
            "vent.send",
            "image.generate",
            "whisper.transcribe",
            "whisper.translate",
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
            "browser",
            "web.fetch",
            "brave.web.search",
            "brave.news.search",
            "brave.video.search",
            "brave.image.search",
            "brave.llm.context",
            "brave.place.search",
            "brave.place.poi",
            "brave.place.description",
            "openai.web_research",
          ],
        },
        "memory": {
          "agentSkillOperations": undefined,
          "toolNames": [
            "postgres.readonly.query",
            "wiki.read",
            "wiki.search",
            "wiki.list",
            "wiki.diff",
            "wiki.write",
            "wiki.write.section",
            "wiki.move",
            "wiki.archive",
            "wiki.restore",
            "wiki.attach.image",
            "wiki.fetch.asset",
            "wiki.delete.asset",
          ],
        },
        "operate": {
          "agentSkillOperations": [
            "load",
            "set",
            "patch",
            "delete",
          ],
          "toolNames": [
            "thinking_set",
            "watch.list",
            "watch.show",
            "watch.runs",
            "watch.create",
            "watch.update",
            "watch.disable",
            "schedule.list",
            "schedule.show",
            "schedule.runs",
            "schedule.create",
            "schedule.update",
            "schedule.cancel",
            "micro-app.check",
            "micro-app.create",
            "micro-app.link.create",
            "micro-app.list",
            "micro-app.view",
            "micro-app.action",
            "environment.create",
            "environment.list",
            "environment.show",
            "environment.stop",
            "environment.logs",
            "skill.list",
            "skill.show",
            "skill.load",
            "skill.set",
            "skill.patch",
            "skill.delete",
            "session.prompt.read",
            "session.prompt.set",
            "session.prompt.transform",
            "subagent.profile.list",
            "subagent.profile.show",
            "subagent.profile.upsert",
            "subagent.profile.enable",
            "subagent.profile.disable",
            "env.list",
            "env.set",
            "env.clear",
          ],
        },
        "skill_maintenance": {
          "agentSkillOperations": [
            "load",
            "set",
            "patch",
            "delete",
          ],
          "toolNames": [
            "skill.list",
            "skill.show",
            "skill.load",
            "skill.set",
            "skill.patch",
            "skill.delete",
          ],
        },
      }
    `);
  });

  it("keeps domain group definitions limited to native direct tools", () => {
    expect(Object.fromEntries(
      SUBAGENT_TOOL_GROUP_KEYS.map((key) => [key, SUBAGENT_TOOL_GROUP_DEFINITIONS[key].nativeToolNames]),
    )).toEqual({
      core: ["bash", "background_job_status", "background_job_wait", "background_job_cancel", "view_media"],
      internet: ["browser"],
      memory: [],
      execute: ["bash", "background_job_status", "background_job_wait", "background_job_cancel"],
      skill_maintenance: [],
      operate: ["thinking_set"],
      communicate_human: [],
    });
  });

  it("expands groups to de-duplicated raw tool names", () => {
    expect(expandSubagentToolGroups(["core", "memory", "core"], {
      commandCatalog: DEFAULT_AGENT_COMMAND_CATALOG,
    })).toEqual([
      "bash",
      "background_job_status",
      "background_job_wait",
      "background_job_cancel",
      "view_media",
      "skill.list",
      "skill.show",
      "skill.load",
      "todo.add",
      "todo.list",
      "todo.show",
      "todo.done",
      "todo.block",
      "todo.clear",
      "a2a.send",
      "a2a.inspect",
      "a2a.history",
      "vent.send",
      "image.generate",
      "whisper.transcribe",
      "whisper.translate",
      "postgres.readonly.query",
      "wiki.read",
      "wiki.search",
      "wiki.list",
      "wiki.diff",
      "wiki.write",
      "wiki.write.section",
      "wiki.move",
      "wiki.archive",
      "wiki.restore",
      "wiki.attach.image",
      "wiki.fetch.asset",
      "wiki.delete.asset",
    ]);
  });

  it("adds command module policy group members supplied by the caller", () => {
    const commandModules = [
      {
        descriptor: {name: "custom.lookup" as const},
        policy: {capability: "custom.lookup" as const, toolGroups: ["internet"]},
      },
    ];

    expect(expandSubagentToolGroups(["internet"], {commandModules})).toEqual([
      "browser",
      "custom.lookup",
    ]);
    expect(resolveSubagentToolPolicy(["internet"], {commandModules}).allowedTools).toEqual([
      "browser",
      "custom.lookup",
    ]);
  });

  it("uses command policy capabilities as tool-group grant keys", () => {
    const commandModules = [
      {
        descriptor: {name: "custom.lookup" as const},
        policy: {capability: "custom.lookup.read" as const, toolGroups: ["internet"]},
      },
    ];

    expect(resolveSubagentToolPolicy(["internet"], {commandModules}).allowedTools).toEqual([
      "browser",
      "custom.lookup.read",
    ]);
  });

  it("adds command catalog policy group members supplied by the caller", () => {
    const commandCatalog = createCommandCatalog([
      {
        descriptor: {
          name: "custom.lookup",
          summary: "Lookup custom data.",
          description: "Lookup custom data.",
          usage: "panda custom lookup",
          inputModes: ["json"],
          outputModes: ["json"],
          arguments: [],
          examples: [],
        },
        route: {
          helpArgv: ["custom", "lookup"],
          jsonArgv: ["custom", "lookup", "--json", "@payload.json"],
        },
        policy: {capability: "custom.lookup", toolGroups: ["internet"]},
      },
    ]);

    expect(expandSubagentToolGroups(["internet"], {commandCatalog})).toEqual([
      "browser",
      "custom.lookup",
    ]);
    expect(resolveSubagentToolPolicy(["internet"], {commandCatalog}).allowedTools).toEqual([
      "browser",
      "custom.lookup",
    ]);
    expect(describeSubagentToolGroups({commandCatalog}).internet.toolNames).toEqual([
      "browser",
      "custom.lookup",
    ]);
  });

  it("resolves operation-aware execution tool policies", () => {
    expect(resolveSubagentToolPolicy(["core"], {
      commandCatalog: DEFAULT_AGENT_COMMAND_CATALOG,
    })).toMatchObject({
      allowedTools: expect.arrayContaining(["bash", "skill.load", "a2a.send", "vent.send"]),
      agentSkill: {
        allowedOperations: ["load"],
      },
    });
    expect(resolveSubagentToolPolicy(["core", "skill_maintenance"], {
      commandCatalog: DEFAULT_AGENT_COMMAND_CATALOG,
    })).toMatchObject({
      agentSkill: {
        allowedOperations: ["load", "set", "patch", "delete"],
      },
    });
    expect(resolveSubagentToolPolicy(["core", "memory", "execute"], {
      commandCatalog: DEFAULT_AGENT_COMMAND_CATALOG,
    })).toMatchObject({
      bash: {allowed: true},
      postgresReadonly: {allowed: true},
    });
    expect(resolveSubagentToolPolicy(["skill_maintenance"], {
      commandCatalog: DEFAULT_AGENT_COMMAND_CATALOG,
    }).allowedTools).toEqual([
      "skill.list",
      "skill.show",
      "skill.load",
      "skill.set",
      "skill.patch",
      "skill.delete",
    ]);
    expect(resolveSubagentToolPolicy(["operate"], {
      commandCatalog: DEFAULT_AGENT_COMMAND_CATALOG,
    }).agentSkill?.allowedOperations).toEqual(["load", "set", "patch", "delete"]);
  });

  it("fails loudly for unknown tool groups instead of treating raw tool names as groups", () => {
    expect(() => normalizeSubagentToolGroups(["core", "bash"])).toThrow(
      'Unknown subagent tool group "bash".',
    );
  });

  it("rejects the removed workspace read group for new inputs", () => {
    expect(() => normalizeSubagentToolGroups(["workspace_read"])).toThrow(
      'Unknown subagent tool group "workspace_read".',
    );
  });

  it("strips the historical workspace read group from persisted rows", () => {
    expect(normalizePersistedSubagentToolGroups(["core", "workspace_read", "core"])).toEqual([
      "core",
    ]);
  });
});
