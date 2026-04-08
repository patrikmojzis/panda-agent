import { describe, expect, it, vi, afterEach } from "vitest";

import {
  Agent,
  BraveSearchTool,
  RunContext,
  ToolError,
  type PandaSessionContext,
} from "../src/index.js";

function createAgent() {
  return new Agent({
    name: "test-agent",
    instructions: "Use tools",
  });
}

function createRunContext(context: PandaSessionContext): RunContext<PandaSessionContext> {
  return new RunContext({
    agent: createAgent(),
    turn: 1,
    maxTurns: 5,
    messages: [],
    context,
  });
}

describe("BraveSearchTool", () => {
  const priorFetch = global.fetch;

  afterEach(() => {
    global.fetch = priorFetch;
    vi.restoreAllMocks();
  });

  it("fails fast when BRAVE_API_KEY is missing", async () => {
    const tool = new BraveSearchTool({
      env: {},
    });

    await expect(tool.run(
      { query: "panda" },
      createRunContext({ cwd: "/workspace/panda" }),
    )).rejects.toBeInstanceOf(ToolError);
  });

  it("returns structured Brave web results", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const requestUrl = new URL(String(input));
      expect(requestUrl.searchParams.get("q")).toBe("latest TypeScript release");
      expect(requestUrl.searchParams.get("count")).toBe("2");
      expect(requestUrl.searchParams.get("country")).toBe("ALL");
      expect(requestUrl.searchParams.get("freshness")).toBe("week");
      expect(requestUrl.searchParams.get("search_lang")).toBe("jp");

      return new Response(JSON.stringify({
        web: {
          results: [
            {
              title: "TypeScript 5.x",
              url: "https://devblogs.microsoft.com/typescript/",
              description: "Official release notes.",
              age: "2 days ago",
            },
            {
              title: "What changed",
              url: "https://example.com/typescript",
              description: "Summary of the release.",
            },
          ],
        },
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    });
    global.fetch = fetchMock as typeof global.fetch;

    const tool = new BraveSearchTool({
      env: {
        BRAVE_API_KEY: "BSA-test-key",
      },
    });

    const result = await tool.run(
      {
        query: "latest TypeScript release",
        count: 2,
        country: "vn",
        freshness: "week",
        search_lang: "ja",
      },
      createRunContext({ cwd: "/workspace/panda" }),
    );

    expect(result).toMatchObject({
      provider: "brave",
      query: "latest TypeScript release",
      country: "ALL",
      freshness: "week",
      resultCount: 2,
      search_lang: "jp",
      results: [
        {
          title: "TypeScript 5.x",
          url: "https://devblogs.microsoft.com/typescript/",
          snippet: "Official release notes.",
          siteName: "devblogs.microsoft.com",
          published: "2 days ago",
        },
        {
          title: "What changed",
          url: "https://example.com/typescript",
          snippet: "Summary of the release.",
          siteName: "example.com",
          published: null,
        },
      ],
    });
  });

  it("rejects unsupported search_lang values before calling Brave", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as typeof global.fetch;

    const tool = new BraveSearchTool({
      env: {
        BRAVE_API_KEY: "BSA-test-key",
      },
    });

    await expect(tool.run(
      {
        query: "latest TypeScript release",
        search_lang: "xx",
      },
      createRunContext({ cwd: "/workspace/panda" }),
    )).rejects.toBeInstanceOf(ToolError);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
