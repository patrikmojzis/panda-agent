import {afterEach, describe, expect, it, vi} from "vitest";

import {Agent, type PandaSessionContext, RunContext, ToolError, WebResearchTool,} from "../src/index.js";

function createAgent() {
  return new Agent({
    name: "test-agent",
    instructions: "Use tools",
  });
}

function createRunContext(
  context: PandaSessionContext,
  options: {
    signal?: AbortSignal;
    onToolProgress?: (progress: Record<string, unknown>) => void;
  } = {},
): RunContext<PandaSessionContext> {
  return new RunContext({
    agent: createAgent(),
    turn: 1,
    maxTurns: 5,
    messages: [],
    context,
    signal: options.signal,
    onToolProgress: options.onToolProgress as any,
  });
}

describe("WebResearchTool", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("returns a cited answer, parsed sources, and progress events", async () => {
    const answerText = "Otters won a tiny scientific victory today.";
    const progress: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        model: "gpt-5",
        reasoning: {effort: "low"},
        tools: [{type: "web_search"}],
        tool_choice: "auto",
        include: ["web_search_call.action.sources"],
      });
      expect(body.input).toContain("User query: otter science news");
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer openai-test-key",
        "Content-Type": "application/json",
      });

      return new Response(JSON.stringify({
        id: "resp_123",
        status: "completed",
        output_text: answerText,
        output: [
          {
            id: "ws_1",
            type: "web_search_call",
            status: "completed",
            action: {
              type: "search",
              query: "otter science news",
              sources: [
                {title: "Otter Times", url: "https://example.com/a"},
                {title: "Otter Times", url: "https://example.com/a"},
                {title: "Science Desk", url: "https://example.com/b"},
              ],
            },
          },
          {
            type: "message",
            content: [{
              type: "output_text",
              text: answerText,
              annotations: [
                {url: "https://example.com/a", title: "Otter Times", start_index: 0, end_index: answerText.length},
                {url: "https://example.com/b", title: "Science Desk", start_index: 0, end_index: answerText.length},
                {url: "https://example.com/a", title: "Otter Times", start_index: 0, end_index: answerText.length},
              ],
            }],
          },
        ],
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    });

    const tool = new WebResearchTool({
      env: {OPENAI_API_KEY: "openai-test-key"} as NodeJS.ProcessEnv,
      fetchImpl: fetchMock as typeof fetch,
    });

    const result = await tool.run(
      {query: "otter science news"},
      createRunContext(
        {cwd: "/workspace/panda"},
        {onToolProgress: (entry) => progress.push(entry)},
      ),
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(progress.map((entry) => entry.status)).toEqual(["researching", "formatting"]);
    expect(result.details).toMatchObject({
      query: "otter science news",
      provider: "openai",
      model: "gpt-5",
      responseId: "resp_123",
      status: "completed",
      citations: [
        {index: 1, title: "Otter Times", url: "https://example.com/a"},
        {index: 2, title: "Science Desk", url: "https://example.com/b"},
      ],
      sources: [
        {title: "Otter Times", url: "https://example.com/a"},
        {title: "Science Desk", url: "https://example.com/b"},
      ],
    });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Otters won a tiny scientific victory today. [[1]](https://example.com/a) [[2]](https://example.com/b)"),
    });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Sources:\n- [Otter Times](<https://example.com/a>)\n- [Science Desk](<https://example.com/b>)"),
    });
  });

  it("wraps source URLs in angle brackets so markdown survives parentheses", async () => {
    const tool = new WebResearchTool({
      env: {OPENAI_API_KEY: "openai-test-key"} as NodeJS.ProcessEnv,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        id: "resp_paren",
        status: "completed",
        output_text: "Readable answer.",
        output: [{
          id: "ws_1",
          type: "web_search_call",
          status: "completed",
          action: {
            type: "search",
            query: "paren link",
            sources: [
              {title: "Paren Source", url: "https://example.com/path_(with_parens)"},
            ],
          },
        }],
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      })) as typeof fetch,
    });

    const result = await tool.run(
      {query: "paren link"},
      createRunContext({cwd: "/workspace/panda"}),
    );

    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("- [Paren Source](<https://example.com/path_(with_parens)>)"),
    });
  });

  it("falls back to the final message output text when top-level output_text is missing", async () => {
    const tool = new WebResearchTool({
      env: {OPENAI_API_KEY: "openai-test-key"} as NodeJS.ProcessEnv,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        id: "resp_456",
        status: "completed",
        output: [{
          type: "message",
          content: [{
            type: "output_text",
            text: "Fallback answer from the message block.",
            annotations: [],
          }],
        }],
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      })) as typeof fetch,
    });

    const result = await tool.run(
      {query: "fallback query"},
      createRunContext({cwd: "/workspace/panda"}),
    );

    expect(result.content[0]).toMatchObject({
      type: "text",
      text: "Fallback answer from the message block.",
    });
    expect(result.details).toMatchObject({
      citations: [],
      sources: [],
    });
  });

  it("dedupes and caps fallback sources derived from citations", async () => {
    const answerText = "Many independent sources support the claim.";
    const annotations = Array.from({length: 21}, (_, index) => ({
      url: `https://example.com/source-${index + 1}`,
      title: `Source ${index + 1}`,
      start_index: 0,
      end_index: answerText.length,
    }));
    const tool = new WebResearchTool({
      env: {OPENAI_API_KEY: "openai-test-key"} as NodeJS.ProcessEnv,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        id: "resp_789",
        status: "completed",
        output_text: answerText,
        output: [{
          type: "message",
          content: [{
            type: "output_text",
            text: answerText,
            annotations,
          }],
        }],
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      })) as typeof fetch,
    });

    const result = await tool.run(
      {query: "many sources"},
      createRunContext({cwd: "/workspace/panda"}),
    );

    expect(result.details).toMatchObject({
      sources: Array.from({length: 20}, (_, index) => ({
        title: `Source ${index + 1}`,
        url: `https://example.com/source-${index + 1}`,
      })),
    });
    const lines = (result.content[0] as {type: string; text: string}).text.split("\n");
    expect(lines.filter((line) => line.startsWith("- ["))).toHaveLength(10);
  });

  it("fails fast when OPENAI_API_KEY is missing", async () => {
    const tool = new WebResearchTool({
      env: {},
      fetchImpl: vi.fn() as typeof fetch,
    });

    await expect(tool.run(
      {query: "missing key"},
      createRunContext({cwd: "/workspace/panda"}),
    )).rejects.toMatchObject({
      message: "OPENAI_API_KEY is not configured.",
    });
  });

  it("surfaces OpenAI API errors", async () => {
    const tool = new WebResearchTool({
      env: {OPENAI_API_KEY: "openai-test-key"} as NodeJS.ProcessEnv,
      fetchImpl: vi.fn(async () => new Response("rate limit", {
        status: 429,
        statusText: "Too Many Requests",
      })) as typeof fetch,
    });

    await expect(tool.run(
      {query: "rate limited"},
      createRunContext({cwd: "/workspace/panda"}),
    )).rejects.toMatchObject({
      message: "OpenAI web research API error (429): rate limit",
    });
  });

  it("times out stalled responses", async () => {
    vi.useFakeTimers();
    const tool = new WebResearchTool({
      env: {OPENAI_API_KEY: "openai-test-key"} as NodeJS.ProcessEnv,
      timeoutMs: 25,
      fetchImpl: vi.fn(async (_input, init) => await new Promise<Response>((_resolve, reject) => {
        const onAbort = () => reject(new Error("aborted"));
        if (init?.signal?.aborted) {
          onAbort();
          return;
        }
        init?.signal?.addEventListener("abort", onAbort, {once: true});
      })) as typeof fetch,
    });

    const promise = tool.run(
      {query: "slow query"},
      createRunContext({cwd: "/workspace/panda"}),
    );
    await vi.advanceTimersByTimeAsync(30);

    await expect(promise).rejects.toBeInstanceOf(ToolError);
    await expect(promise).rejects.toMatchObject({
      message: "web_research timed out after 25ms.",
    });
  });

  it("rejects incomplete OpenAI responses", async () => {
    const tool = new WebResearchTool({
      env: {OPENAI_API_KEY: "openai-test-key"} as NodeJS.ProcessEnv,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        id: "resp_in_progress",
        status: "in_progress",
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      })) as typeof fetch,
    });

    await expect(tool.run(
      {query: "in progress"},
      createRunContext({cwd: "/workspace/panda"}),
    )).rejects.toMatchObject({
      message: "OpenAI web research did not complete successfully (status: in_progress).",
    });
  });

  it("rejects malformed successful responses that contain no final answer", async () => {
    const tool = new WebResearchTool({
      env: {OPENAI_API_KEY: "openai-test-key"} as NodeJS.ProcessEnv,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        id: "resp_empty",
        status: "completed",
        output: [],
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      })) as typeof fetch,
    });

    await expect(tool.run(
      {query: "empty answer"},
      createRunContext({cwd: "/workspace/panda"}),
    )).rejects.toMatchObject({
      message: "OpenAI web research response did not include final answer text.",
    });
  });
});
