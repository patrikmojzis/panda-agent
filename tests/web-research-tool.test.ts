import {afterEach, describe, expect, it, vi} from "vitest";

import {
  Agent,
  BackgroundJobWaitTool,
  type DefaultAgentSessionContext,
  RunContext,
  type ToolResultPayload,
  WebResearchTool,
} from "../src/index.js";
import {BackgroundToolJobService} from "../src/domain/threads/runtime/tool-job-service.js";
import type {ThreadToolJobRecord} from "../src/domain/threads/runtime/types.js";
import type {WebResearchToolOptions} from "../src/panda/tools/web-research-tool.js";
import {TestThreadRuntimeStore} from "./helpers/test-runtime-store.js";

function createAgent() {
  return new Agent({
    name: "test-agent",
    instructions: "Use tools",
  });
}

function createRunContext(
  context: Partial<DefaultAgentSessionContext> = {},
  options: {
    signal?: AbortSignal;
  } = {},
): RunContext<DefaultAgentSessionContext> {
  return new RunContext({
    agent: createAgent(),
    turn: 1,
    maxTurns: 5,
    messages: [],
    context: {
      threadId: "thread-1",
      sessionId: "session-main",
      agentKey: "panda",
      cwd: "/workspace/panda",
      ...context,
    },
    signal: options.signal,
  });
}

async function createWebResearchHarness(options: Omit<WebResearchToolOptions, "jobService"> = {}): Promise<{
  jobService: BackgroundToolJobService;
  run: RunContext<DefaultAgentSessionContext>;
  tool: WebResearchTool;
  waitTool: BackgroundJobWaitTool;
}> {
  const store = new TestThreadRuntimeStore();
  await store.createThread({
    id: "thread-1",
    sessionId: "session-main",
  });
  const jobService = new BackgroundToolJobService({store});
  return {
    jobService,
    run: createRunContext(),
    tool: new WebResearchTool({
      ...options,
      jobService,
    }),
    waitTool: new BackgroundJobWaitTool({
      service: jobService,
      defaultWaitTimeoutMs: 1_000,
    }),
  };
}

async function runAndWait(params: {
  query: string;
  jobService: BackgroundToolJobService;
  run: RunContext<DefaultAgentSessionContext>;
  tool: WebResearchTool;
  waitTool: BackgroundJobWaitTool;
  timeoutMs?: number;
}): Promise<{
  output: ToolResultPayload;
  record: ThreadToolJobRecord;
  started: Record<string, unknown>;
}> {
  const started = await params.tool.run({query: params.query}, params.run) as Record<string, unknown>;
  expect(started).toMatchObject({
    kind: "web_research",
    status: "running",
    summary: params.query,
  });
  const jobId = String(started.jobId);
  const record = await params.jobService.wait("thread-1", jobId, params.timeoutMs ?? 1_000);
  const output = await params.waitTool.run({
    jobId,
    timeoutMs: 0,
  }, params.run) as ToolResultPayload;
  return {output, record, started};
}

describe("WebResearchTool", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("starts a background job and materializes a cited answer through background_job_wait", async () => {
    const answerText = "Otters won a tiny scientific victory today.";
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

    const harness = await createWebResearchHarness({
      env: {OPENAI_API_KEY: "openai-test-key"} as NodeJS.ProcessEnv,
      fetchImpl: fetchMock as typeof fetch,
    });

    const {output, record} = await runAndWait({
      query: "otter science news",
      ...harness,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(record).toMatchObject({
      kind: "web_research",
      status: "completed",
      progress: {
        status: "formatting",
        query: "otter science news",
        model: "gpt-5",
        responseId: "resp_123",
      },
    });
    expect(output.details).toMatchObject({
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
    expect(output.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Otters won a tiny scientific victory today. [[1]](https://example.com/a) [[2]](https://example.com/b)"),
    });
    expect(output.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Sources:\n- [Otter Times](<https://example.com/a>)\n- [Science Desk](<https://example.com/b>)"),
    });
  });

  it("wraps source URLs in angle brackets so markdown survives parentheses", async () => {
    const harness = await createWebResearchHarness({
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

    const {output} = await runAndWait({
      query: "paren link",
      ...harness,
    });

    expect(output.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("- [Paren Source](<https://example.com/path_(with_parens)>)"),
    });
  });

  it("falls back to the final message output text when top-level output_text is missing", async () => {
    const harness = await createWebResearchHarness({
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

    const {output} = await runAndWait({
      query: "fallback query",
      ...harness,
    });

    expect(output.content[0]).toMatchObject({
      type: "text",
      text: "Fallback answer from the message block.",
    });
    expect(output.details).toMatchObject({
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
    const harness = await createWebResearchHarness({
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

    const {output} = await runAndWait({
      query: "many sources",
      ...harness,
    });

    expect(output.details).toMatchObject({
      sources: Array.from({length: 20}, (_, index) => ({
        title: `Source ${index + 1}`,
        url: `https://example.com/source-${index + 1}`,
      })),
    });
    const lines = (output.content[0] as {type: string; text: string}).text.split("\n");
    expect(lines.filter((line) => line.startsWith("- ["))).toHaveLength(10);
  });

  it("fails fast when OPENAI_API_KEY is missing", async () => {
    const harness = await createWebResearchHarness({
      env: {},
      fetchImpl: vi.fn() as typeof fetch,
    });

    const started = await harness.tool.run({query: "missing key"}, harness.run) as Record<string, unknown>;
    const record = await harness.jobService.wait("thread-1", String(started.jobId), 1_000);

    expect(record).toMatchObject({
      status: "failed",
      error: "OPENAI_API_KEY is not configured.",
    });
  });

  it("surfaces OpenAI API errors", async () => {
    const harness = await createWebResearchHarness({
      env: {OPENAI_API_KEY: "openai-test-key"} as NodeJS.ProcessEnv,
      fetchImpl: vi.fn(async () => new Response("rate limit", {
        status: 429,
        statusText: "Too Many Requests",
      })) as typeof fetch,
    });

    const started = await harness.tool.run({query: "rate limited"}, harness.run) as Record<string, unknown>;
    const record = await harness.jobService.wait("thread-1", String(started.jobId), 1_000);

    expect(record).toMatchObject({
      status: "failed",
      error: "OpenAI web research API error (429): rate limit",
    });
  });

  it("times out stalled responses", async () => {
    vi.useFakeTimers();
    const harness = await createWebResearchHarness({
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

    const started = await harness.tool.run({query: "slow query"}, harness.run) as Record<string, unknown>;
    await vi.advanceTimersByTimeAsync(30);
    const record = await harness.jobService.wait("thread-1", String(started.jobId), 1_000);

    expect(record).toMatchObject({
      status: "failed",
      error: "web_research timed out after 25ms.",
    });
  });

  it("rejects incomplete OpenAI responses", async () => {
    const harness = await createWebResearchHarness({
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

    const started = await harness.tool.run({query: "in progress"}, harness.run) as Record<string, unknown>;
    const record = await harness.jobService.wait("thread-1", String(started.jobId), 1_000);

    expect(record).toMatchObject({
      status: "failed",
      error: "OpenAI web research did not complete successfully (status: in_progress).",
    });
  });

  it("rejects malformed successful responses that contain no final answer", async () => {
    const harness = await createWebResearchHarness({
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

    const started = await harness.tool.run({query: "empty answer"}, harness.run) as Record<string, unknown>;
    const record = await harness.jobService.wait("thread-1", String(started.jobId), 1_000);

    expect(record).toMatchObject({
      status: "failed",
      error: "OpenAI web research response did not include final answer text.",
    });
  });
});
