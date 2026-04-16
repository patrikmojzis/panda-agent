import {describe, expect, it} from "vitest";

import {
    filterToolsForSubagentRole,
    getPandaSubagentRolePolicy,
    PostgresReadonlyQueryTool,
    Tool,
    z,
} from "../src/index.js";
import {buildPandaToolsets} from "../src/panda/definition.js";

class FakeReadonlyPool {
  async connect(): Promise<never> {
    throw new Error("not used in filter tests");
  }
}

class FakeAgentDocumentTool extends Tool<typeof FakeAgentDocumentTool.schema> {
  static schema = z.object({
    target: z.string(),
  });

  name = "agent_document";
  description = "Not allowed";
  schema = FakeAgentDocumentTool.schema;

  async handle(): Promise<{ ok: true }> {
    return { ok: true };
  }
}

describe("Panda subagent policy", () => {
  it("maps roles to explicit specialist toolsets", () => {
    expect(getPandaSubagentRolePolicy("explore")).toMatchObject({
      toolset: "explore",
      thinking: "low",
    });
    expect(getPandaSubagentRolePolicy("memory_explorer")).toMatchObject({
      toolset: "memoryExplorer",
      thinking: "medium",
    });
  });

  it("builds the explore toolset with readonly workspace tools plus media only", () => {
    const toolsets = buildPandaToolsets({
      postgresReadonly: {
        pool: new FakeReadonlyPool(),
      },
    });

    expect(toolsets.explore.map((tool) => tool.name)).toEqual([
      "read_file",
      "glob_files",
      "grep_files",
      "view_media",
    ]);
  });

  it("keeps the memory explorer Postgres-only", () => {
    const toolsets = buildPandaToolsets({
      postgresReadonly: {
        pool: new FakeReadonlyPool(),
      },
    });

    expect(toolsets.memoryExplorer.map((tool) => tool.name)).toEqual([
      "postgres_readonly_query",
    ]);
  });

  it("keeps the helper filter aligned with the explicit explore toolset", () => {
    const toolsets = buildPandaToolsets({
      postgresReadonly: {
        pool: new FakeReadonlyPool(),
      },
    });
    const tools = filterToolsForSubagentRole(
      [
        ...toolsets.main,
        ...toolsets.explore,
        new FakeAgentDocumentTool(),
      ],
      "explore",
    );

    expect(tools.map((tool) => tool.name)).toEqual([
      "read_file",
      "glob_files",
      "grep_files",
      "view_media",
    ]);
  });

  it("keeps the helper filter aligned with the explicit memory toolset", () => {
    const toolsets = buildPandaToolsets({
      postgresReadonly: {
        pool: new FakeReadonlyPool(),
      },
    });
    const tools = filterToolsForSubagentRole(
      [
        ...toolsets.main,
        new PostgresReadonlyQueryTool({ pool: new FakeReadonlyPool() }),
        new FakeAgentDocumentTool(),
      ],
      "memory_explorer",
    );

    expect(tools.map((tool) => tool.name)).toEqual([
      "postgres_readonly_query",
    ]);
  });
});
