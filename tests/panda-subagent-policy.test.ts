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
    expect(getPandaSubagentRolePolicy("workspace")).toMatchObject({
      toolset: "workspace",
      thinking: "low",
    });
    expect(getPandaSubagentRolePolicy("memory")).toMatchObject({
      toolset: "memory",
      thinking: "medium",
    });
    expect(getPandaSubagentRolePolicy("browser")).toMatchObject({
      toolset: "browser",
      thinking: "medium",
    });
  });

  it("builds the workspace toolset with readonly workspace tools plus media only", () => {
    const toolsets = buildPandaToolsets({
      postgresReadonly: {
        pool: new FakeReadonlyPool(),
      },
    });

    expect(toolsets.workspace.map((tool) => tool.name)).toEqual([
      "read_file",
      "glob_files",
      "grep_files",
      "view_media",
    ]);
  });

  it("keeps the memory subagent Postgres-only", () => {
    const toolsets = buildPandaToolsets({
      postgresReadonly: {
        pool: new FakeReadonlyPool(),
      },
    });

    expect(toolsets.memory.map((tool) => tool.name)).toEqual([
      "postgres_readonly_query",
    ]);
  });

  it("gives the browser subagent browser plus readonly artifact inspection tools", () => {
    const toolsets = buildPandaToolsets({
      postgresReadonly: {
        pool: new FakeReadonlyPool(),
      },
    });

    expect(toolsets.browser.map((tool) => tool.name)).toEqual([
      "read_file",
      "glob_files",
      "grep_files",
      "view_media",
      "browser",
    ]);
  });

  it("keeps the helper filter aligned with the explicit workspace toolset", () => {
    const toolsets = buildPandaToolsets({
      postgresReadonly: {
        pool: new FakeReadonlyPool(),
      },
    });
    const tools = filterToolsForSubagentRole(
      [
        ...toolsets.main,
        ...toolsets.workspace,
        new FakeAgentDocumentTool(),
      ],
      "workspace",
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
      "memory",
    );

    expect(tools.map((tool) => tool.name)).toEqual([
      "postgres_readonly_query",
    ]);
  });

  it("keeps the helper filter aligned with the explicit browser toolset", () => {
    const toolsets = buildPandaToolsets({
      postgresReadonly: {
        pool: new FakeReadonlyPool(),
      },
    });
    const tools = filterToolsForSubagentRole(
      [
        ...toolsets.main,
        ...toolsets.browser,
        new FakeAgentDocumentTool(),
      ],
      "browser",
    );

    expect(tools.map((tool) => tool.name)).toEqual([
      "read_file",
      "glob_files",
      "grep_files",
      "view_media",
      "browser",
    ]);
  });
});
