import {describe, expect, it} from "vitest";

import {
    BraveSearchTool,
    BrowserTool,
    filterToolsForSubagentRole,
    getPandaSubagentRolePolicy,
    GlobFilesTool,
    GrepFilesTool,
    MediaTool,
    PostgresReadonlyQueryTool,
    ReadFileTool,
    Tool,
    WebFetchTool,
    WebResearchTool,
    z,
} from "../src/index.js";

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
  it("keeps readonly workspace tools available and excludes memory and web_research tools for the explore role", () => {
    const tools = filterToolsForSubagentRole(
      [
        new ReadFileTool(),
        new GlobFilesTool(),
        new GrepFilesTool(),
        new MediaTool(),
        new WebFetchTool(),
        new PostgresReadonlyQueryTool({ pool: new FakeReadonlyPool() }),
        new BraveSearchTool(),
        new WebResearchTool(),
      ],
      "explore",
    );

    expect(tools.map((tool) => tool.name)).toEqual([
      "read_file",
      "glob_files",
      "grep_files",
      "view_media",
      "web_fetch",
    ]);
  });

  it("keeps browser excluded for the explore role", () => {
    const tools = filterToolsForSubagentRole(
      [
        new ReadFileTool(),
        new GlobFilesTool(),
        new GrepFilesTool(),
        new MediaTool(),
        new WebFetchTool(),
        new BraveSearchTool(),
        new BrowserTool(),
        new WebResearchTool(),
      ],
      "explore",
    );

    expect(tools.map((tool) => tool.name)).toEqual([
      "read_file",
      "glob_files",
      "grep_files",
      "view_media",
      "web_fetch",
    ]);
  });

  it("uses low thinking for the explore role", () => {
    expect(getPandaSubagentRolePolicy("explore").thinking).toBe("low");
  });

  it("keeps the memory explorer Postgres-only", () => {
    const tools = filterToolsForSubagentRole(
      [
        new ReadFileTool(),
        new GlobFilesTool(),
        new GrepFilesTool(),
        new MediaTool(),
        new WebFetchTool(),
        new PostgresReadonlyQueryTool({ pool: new FakeReadonlyPool() }),
        new FakeAgentDocumentTool(),
      ],
      "memory_explorer",
    );

    expect(tools.map((tool) => tool.name)).toEqual([
      "postgres_readonly_query",
    ]);
  });

  it("uses medium thinking for the memory explorer role", () => {
    expect(getPandaSubagentRolePolicy("memory_explorer").thinking).toBe("medium");
  });
});
