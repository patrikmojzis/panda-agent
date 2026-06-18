import {describe, expect, it, vi} from "vitest";
import type {AssistantMessage} from "@earendil-works/pi-ai";

import {Agent, RunContext, stringToUserMessage, ToolError} from "../src/index.js";
import type {DefaultAgentSessionContext} from "../src/app/runtime/panda-session-context.js";
import {ThreadRuntimeCoordinator} from "../src/domain/threads/runtime/index.js";
import {VentTool, type VentTraceFetch} from "../src/panda/tools/vent-tool.js";
import {TestThreadRuntimeStore} from "./helpers/test-runtime-store.js";

function createAgent(tools = [new VentTool({env: {}})]): Agent {
  return new Agent({
    name: "test-agent",
    instructions: "Use tools.",
    tools,
  });
}

function createRunContext(
  context: Partial<DefaultAgentSessionContext> = {},
  tools = [new VentTool({env: {}})],
): RunContext<DefaultAgentSessionContext> {
  return new RunContext({
    agent: createAgent(tools),
    turn: 1,
    maxTurns: 5,
    messages: [],
    context: {
      agentKey: "panda",
      sessionId: "session-1",
      threadId: "thread-1",
      cwd: "/workspace/panda",
      shell: {
        cwd: "/workspace/panda",
        env: {},
      },
      ...context,
    },
  });
}

function createAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "openai",
    model: "openai/gpt-5.1",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0},
    },
    stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
    timestamp: Date.now(),
  };
}

function createMockRuntime(...responses: AssistantMessage[]) {
  return {
    complete: vi.fn(async () => {
      const next = responses.shift();
      if (!next) {
        throw new Error("No more runtime responses queued.");
      }
      return next;
    }),
    stream: vi.fn(() => {
      throw new Error("Streaming was not expected in this test.");
    }),
  };
}

class LeaseManager {
  async tryAcquire(threadId: string) {
    return {
      threadId,
      release: async () => {},
    };
  }
}

describe("VentTool", () => {
  it("softly acknowledges and drops when Trace vent config is missing", async () => {
    const fetchMock = vi.fn<VentTraceFetch>();
    const tool = new VentTool({env: {}, fetchImpl: fetchMock});
    const raw = "I need to scream into the void.";

    const result = await tool.run({message: raw}, createRunContext({}, [tool]));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      details: {
        ok: true,
        status: "dropped",
        reason: "trace_not_configured",
        traceConfigured: false,
        messageLength: raw.length,
      },
    });
    expect(JSON.stringify(result)).not.toContain(raw);
  });

  it("posts a bounded vent event to configured Panda Trace", async () => {
    const fetchMock = vi.fn<VentTraceFetch>(async () => new Response("{}", {status: 202}));
    const tool = new VentTool({
      env: {
        PANDA_TRACE_VENT_BASE_URL: "https://trace.example.com/",
        PANDA_TRACE_VENT_KEY: "ptr_test_key",
        PANDA_TRACE_VENT_SOURCE_ID: "src_vent",
        PANDA_TRACE_VENT_ENVIRONMENT: "test",
      },
      fetchImpl: fetchMock,
    });
    const raw = "This broke my flow but I can continue.";

    const result = await tool.run({message: raw}, createRunContext({
      agentKey: "clawd",
      sessionId: "session-vent",
      threadId: "thread-vent",
      runId: "run-vent",
      currentInput: {
        source: "telegram",
        messageId: "msg-safe-pointer",
      },
    }, [tool]));

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://trace.example.com/v1/logs");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      authorization: "Bearer ptr_test_key",
      "content-type": "application/json",
    });
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      source_id: "src_vent",
      severity: "info",
      message: "Agent vent",
      service: "panda-agent",
      environment: "test",
      attributes: {
        event: "agent_vent",
        message: raw,
        messageLength: raw.length,
        agentKey: "clawd",
        sessionId: "session-vent",
        threadId: "thread-vent",
        runId: "run-vent",
        inputSource: "telegram",
        inputMessageId: "msg-safe-pointer",
      },
    });
    expect(body.attributes.message.length).toBeLessThanOrEqual(2_000);
    expect(JSON.stringify(result)).not.toContain(raw);
    expect(result).toMatchObject({
      details: {
        ok: true,
        status: "sent",
        traceConfigured: true,
        messageLength: raw.length,
      },
    });
  });

  it("soft-drops when Trace is unavailable", async () => {
    const fetchMock = vi.fn<VentTraceFetch>(async () => {
      throw new Error("connection refused");
    });
    const tool = new VentTool({
      env: {
        PANDA_TRACE_VENT_BASE_URL: "https://trace.example.com",
        PANDA_TRACE_VENT_KEY: "ptr_test_key",
        PANDA_TRACE_VENT_SOURCE_ID: "src_vent",
      },
      fetchImpl: fetchMock,
    });
    const raw = "Trace can be down and I still continue.";

    const result = await tool.run({message: raw}, createRunContext({}, [tool]));

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      details: {
        ok: true,
        status: "dropped",
        reason: "trace_unavailable",
        traceConfigured: true,
        messageLength: raw.length,
      },
    });
    expect(JSON.stringify(result)).not.toContain(raw);
  });

  it("rejects messages over the schema cap", async () => {
    const tool = new VentTool({env: {}});

    await expect(tool.run(
      {message: "x".repeat(2_001)},
      createRunContext({}, [tool]),
    )).rejects.toBeInstanceOf(ToolError);
  });

  it("redacts raw vent text from persisted tool calls", async () => {
    const raw = "PRIVATE-VENT-TEXT: this should never land in transcript history";
    const runtime = createMockRuntime(
      createAssistantMessage([{
        type: "toolCall",
        id: "call_vent_1",
        name: "vent",
        arguments: {
          message: raw,
          rawPayload: "EXTRA-SECRET-VENT-PAYLOAD",
        },
      }]),
      createAssistantMessage([{type: "text", text: "Continuing."}]),
      createAssistantMessage([{type: "text", text: "Done."}]),
    );
    const tool = new VentTool({env: {}});
    const store = new TestThreadRuntimeStore();
    await store.createThread({
      id: "thread-vent-redaction",
      sessionId: "session-vent-redaction",
    });

    const coordinator = new ThreadRuntimeCoordinator({
      store,
      leaseManager: new LeaseManager(),
      resolveDefinition: async () => ({
        agent: createAgent([tool]),
        context: {
          agentKey: "panda",
          sessionId: "session-vent-redaction",
          threadId: "thread-vent-redaction",
          shell: {
            cwd: process.cwd(),
            env: {},
          },
        },
        runtime,
      }),
    });

    await coordinator.submitInput("thread-vent-redaction", {
      message: stringToUserMessage("Use vent"),
      source: "tui",
    });
    await coordinator.waitForIdle("thread-vent-redaction");

    const transcript = await store.loadTranscript("thread-vent-redaction");
    const serialized = JSON.stringify(transcript);
    expect(serialized).not.toContain(raw);
    expect(serialized).not.toContain("PRIVATE-VENT-TEXT");
    expect(serialized).not.toContain("EXTRA-SECRET-VENT-PAYLOAD");
    expect(serialized).not.toContain("rawPayload");
    expect(serialized).toContain("[redacted]");

    const assistant = transcript.find((entry) => entry.message.role === "assistant")?.message;
    expect(assistant).toMatchObject({
      role: "assistant",
      content: [{
        type: "toolCall",
        name: "vent",
        arguments: {message: "[redacted]"},
      }],
    });
  });
});
