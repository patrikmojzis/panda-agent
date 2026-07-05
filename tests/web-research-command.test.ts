import {describe, expect, it, vi} from "vitest";

import {BackgroundToolJobService} from "../src/domain/threads/runtime/tool-job-service.js";
import {
  createOpenAIWebResearchCommand,
  OPENAI_WEB_RESEARCH_COMMAND_NAME,
} from "../src/integrations/web/commands.js";
import {TestThreadRuntimeStore} from "./helpers/test-runtime-store.js";

describe("web research command", () => {
  it("starts an OpenAI hosted web research background job", async () => {
    const store = new TestThreadRuntimeStore();
    await store.createThread({
      id: "thread-1",
      sessionId: "session-main",
    });
    const jobService = new BackgroundToolJobService({store});
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      id: "resp_123",
      status: "completed",
      output_text: "TypeScript shipped a release.",
      output: [{
        type: "message",
        content: [{
          type: "output_text",
          text: "TypeScript shipped a release.",
          annotations: [{
            url: "https://example.com/typescript",
            title: "TypeScript Blog",
            start_index: 0,
            end_index: 29,
          }],
        }],
      }],
    }), {
      status: 200,
      headers: {"content-type": "application/json"},
    }));
    const command = createOpenAIWebResearchCommand({
      jobService,
      apiKey: "openai-test-key",
      fetchImpl,
    });

    const result = await command.execute({
      command: OPENAI_WEB_RESEARCH_COMMAND_NAME,
      input: {
        query: "latest TypeScript release",
      },
      scope: {
        agentKey: "panda",
        sessionId: "session-main",
        threadId: "thread-1",
      },
    });

    expect(result.output).toMatchObject({
      kind: "web_research",
      status: "running",
      summary: "latest TypeScript release",
      progress: {
        status: "researching",
        query: "latest TypeScript release",
      },
    });
    const jobId = String(result.output.jobId);
    const record = await jobService.wait("thread-1", jobId, 1_000);
    expect(record).toMatchObject({
      status: "completed",
      result: {
        contentText: expect.stringContaining("TypeScript shipped a release."),
        details: {
          query: "latest TypeScript release",
          provider: "openai",
          responseId: "resp_123",
        },
      },
    });
    expect(result.command).toBe(OPENAI_WEB_RESEARCH_COMMAND_NAME);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("starts preferred OpenAI web research jobs with model and effort overrides", async () => {
    const store = new TestThreadRuntimeStore();
    await store.createThread({
      id: "thread-1",
      sessionId: "session-main",
    });
    const jobService = new BackgroundToolJobService({store});
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      id: "resp_456",
      status: "completed",
      output_text: "OpenAI hosted search answered.",
      output: [{
        type: "message",
        content: [{
          type: "output_text",
          text: "OpenAI hosted search answered.",
          annotations: [],
        }],
      }],
    }), {
      status: 200,
      headers: {"content-type": "application/json"},
    }));
    const command = createOpenAIWebResearchCommand({
      jobService,
      apiKey: "openai-test-key",
      fetchImpl,
    });

    const result = await command.execute({
      command: OPENAI_WEB_RESEARCH_COMMAND_NAME,
      input: {
        query: "agent command architecture",
        model: "gpt-5.1",
        effort: "medium",
      },
      scope: {
        agentKey: "panda",
        sessionId: "session-main",
        threadId: "thread-1",
      },
    });

    expect(result.command).toBe(OPENAI_WEB_RESEARCH_COMMAND_NAME);
    expect(result.output).toMatchObject({
      kind: "web_research",
      status: "running",
      summary: "agent command architecture",
      progress: {
        status: "researching",
        query: "agent command architecture",
        model: "gpt-5.1",
      },
    });
    const jobId = String(result.output.jobId);
    await jobService.wait("thread-1", jobId, 1_000);

    const request = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(request).toMatchObject({
      model: "gpt-5.1",
      reasoning: {
        effort: "medium",
      },
    });
  });
});
