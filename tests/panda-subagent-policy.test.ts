import {describe, expect, it} from "vitest";

import {buildDefaultAgentToolsetsFromRegistry, createDefaultAgentToolRegistry,} from "../src/panda/definition.js";
import {getDefaultAgentSubagentRolePolicy} from "../src/panda/subagents/policy.js";
import {Tool, z} from "../src/index.js";

class FakeReadonlyPool {
  async connect(): Promise<never> {
    throw new Error("not used in subagent policy tests");
  }
}

class FakeAgentSkillTool extends Tool<typeof FakeAgentSkillTool.schema> {
  static schema = z.object({
    skillKey: z.string(),
  });

  name = "agent_skill";
  description = "Allowed in skill maintainer";
  schema = FakeAgentSkillTool.schema;

  async handle(): Promise<{ ok: true }> {
    return { ok: true };
  }
}

class FakeWikiTool extends Tool<typeof FakeWikiTool.schema> {
  static schema = z.object({
    operation: z.string(),
  });

  name = "wiki";
  description = "Allowed for memory specialists";
  schema = FakeWikiTool.schema;

  async handle(): Promise<{ ok: true }> {
    return { ok: true };
  }
}

describe("default agent subagent policy", () => {
  function createToolsetsWithExtras(options: {
    memoryExtras?: readonly Tool[];
    skillMaintainerExtras?: readonly Tool[];
  } = {}) {
    return buildDefaultAgentToolsetsFromRegistry(
      createDefaultAgentToolRegistry({
        postgresReadonly: {
          pool: new FakeReadonlyPool(),
        },
      }),
      [],
      options.memoryExtras ?? [],
      options.skillMaintainerExtras ?? [],
    );
  }

  function createBaseToolsets() {
    return createToolsetsWithExtras();
  }

  it("maps roles to explicit specialist toolsets", () => {
    expect(getDefaultAgentSubagentRolePolicy("workspace")).toMatchObject({
      toolset: "workspace",
      thinking: "low",
    });
    expect(getDefaultAgentSubagentRolePolicy("memory")).toMatchObject({
      toolset: "memory",
      thinking: "medium",
    });
    expect(getDefaultAgentSubagentRolePolicy("browser")).toMatchObject({
      toolset: "browser",
      thinking: "medium",
    });
    expect(getDefaultAgentSubagentRolePolicy("skill_maintainer")).toMatchObject({
      toolset: "skill_maintainer",
      thinking: "medium",
    });
  });

  it("builds the workspace toolset with readonly workspace tools plus media only", () => {
    const toolsets = createBaseToolsets();

    expect(toolsets.workspace.map((tool) => tool.name)).toEqual([
      "current_datetime",
      "read_file",
      "glob_files",
      "grep_files",
      "view_media",
    ]);
  });

  it("keeps the memory subagent minimal without wiki extras", () => {
    const toolsets = createBaseToolsets();

    expect(toolsets.memory.map((tool) => tool.name)).toEqual([
      "current_datetime",
      "postgres_readonly_query",
    ]);
  });

  it("lets the memory subagent receive wiki when memory extras are configured", () => {
    const toolsets = createToolsetsWithExtras({
      memoryExtras: [new FakeWikiTool()],
    });

    expect(toolsets.memory.map((tool) => tool.name)).toEqual([
      "current_datetime",
      "postgres_readonly_query",
      "wiki",
    ]);
  });

  it("gives the browser subagent browser plus readonly artifact inspection tools", () => {
    const toolsets = createBaseToolsets();

    expect(toolsets.browser.map((tool) => tool.name)).toEqual([
      "current_datetime",
      "read_file",
      "glob_files",
      "grep_files",
      "view_media",
      "browser",
    ]);
  });

  it("gives the skill maintainer Postgres, skill editing, and readonly workspace inspection", () => {
    const toolsets = createToolsetsWithExtras({
      skillMaintainerExtras: [new FakeAgentSkillTool()],
    });

    expect(toolsets.skill_maintainer.map((tool) => tool.name)).toEqual([
      "current_datetime",
      "postgres_readonly_query",
      "read_file",
      "glob_files",
      "grep_files",
      "view_media",
      "agent_skill",
    ]);
  });
});
