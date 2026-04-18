import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import type {AssistantMessage} from "@mariozechner/pi-ai";
import {afterEach, describe, expect, it, vi} from "vitest";

import {Agent, RunContext, stringToUserMessage, Thread, ToolError,} from "../src/index.js";
import {MessageAgentTool} from "../src/panda/index.js";
import type {DefaultAgentSessionContext} from "../src/app/runtime/panda-session-context.js";

function createContext(
  overrides: Partial<DefaultAgentSessionContext> = {},
): DefaultAgentSessionContext & {
  queueMessage: ReturnType<typeof vi.fn>;
} {
  const queueMessage = vi.fn(async (input) => ({
    delivery: {
      id: "delivery-1",
      status: "pending",
      attemptCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      threadId: input.senderThreadId,
      channel: "a2a",
      target: {
        source: "a2a",
        connectorKey: "local",
        externalConversationId: input.sessionId ?? "session-b",
        externalActorId: input.agentKey ?? "koala",
      },
      items: input.items,
    },
    targetAgentKey: input.agentKey ?? "koala",
    targetSessionId: input.sessionId ?? "session-b",
    messageId: "a2a:123",
  }));

  return {
    cwd: process.cwd(),
    agentKey: "panda",
    sessionId: "session-a",
    threadId: "thread-a",
    queueMessage,
    messageAgent: {
      queueMessage,
    },
    ...overrides,
  };
}

function createRunContext(context: DefaultAgentSessionContext): RunContext<DefaultAgentSessionContext> {
  return new RunContext({
    agent: new Agent(),
    turn: 0,
    maxTurns: 10,
    messages: [],
    context,
  });
}

function createAssistantMessage(
  content: AssistantMessage["content"],
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
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
    complete: vi.fn().mockImplementation(async () => {
      const response = responses.shift();
      if (!response) {
        throw new Error("No more mock responses queued");
      }

      return response;
    }),
    stream: vi.fn(() => {
      throw new Error("Streaming was not expected in this test");
    }),
  };
}

describe("MessageAgentTool", () => {
  const directories = new Set<string>();

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const directory of directories) {
      await rm(directory, {recursive: true, force: true});
    }
    directories.clear();
  });

  it("resolves relative attachments and queues a fire-and-forget A2A message", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "panda-message-agent-tool-"));
    directories.add(tempDir);
    const relativeFile = "report.txt";
    const absoluteFile = path.join(tempDir, relativeFile);
    await writeFile(absoluteFile, "hello", "utf8");

    const tool = new MessageAgentTool<DefaultAgentSessionContext>();
    const context = createContext({
      cwd: tempDir,
    });

    const result = await tool.run({
      sessionId: "session-b",
      items: [
        {type: "text", text: "see attached"},
        {type: "file", path: relativeFile, filename: "report.txt"},
      ],
    }, createRunContext(context));

    expect(context.queueMessage).toHaveBeenCalledWith({
      senderAgentKey: "panda",
      senderSessionId: "session-a",
      senderThreadId: "thread-a",
      senderRunId: undefined,
      agentKey: undefined,
      sessionId: "session-b",
      items: [
        {type: "text", text: "see attached"},
        {type: "file", path: absoluteFile, filename: "report.txt"},
      ],
    });
    expect(result).toEqual({
      ok: true,
      status: "queued",
      deliveryId: "delivery-1",
      targetAgentKey: "koala",
      targetSessionId: "session-b",
      messageId: "a2a:123",
    });
  });

  it("fails cleanly when the runtime does not expose A2A messaging", async () => {
    const tool = new MessageAgentTool<DefaultAgentSessionContext>();

    await expect(tool.run({
      sessionId: "session-b",
      items: [{type: "text", text: "hello"}],
    }, createRunContext({
      cwd: process.cwd(),
      agentKey: "panda",
      sessionId: "session-a",
      threadId: "thread-a",
    }))).rejects.toBeInstanceOf(ToolError);
  });

  it("runs through the real thread loop when Panda calls the tool", async () => {
    const queueMessage = vi.fn(async (input) => ({
      delivery: {
        id: "delivery-1",
        status: "pending",
        attemptCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        threadId: input.senderThreadId,
        channel: "a2a",
        target: {
          source: "a2a",
          connectorKey: "local",
          externalConversationId: input.sessionId ?? "session-b",
          externalActorId: "koala",
        },
        items: input.items,
      },
      targetAgentKey: "koala",
      targetSessionId: input.sessionId ?? "session-b",
      messageId: "a2a:thread-smoke",
    }));
    const runtime = createMockRuntime(
      createAssistantMessage([{
        type: "toolCall",
        id: "call_1",
        name: "message_agent",
        arguments: {
          sessionId: "session-b",
          items: [{type: "text", text: "ping"}],
        },
      }]),
      createAssistantMessage([{type: "text", text: "queued"}]),
    );

    const thread = new Thread({
      agent: new Agent({
        name: "panda",
        instructions: "Use tools when needed.",
        tools: [new MessageAgentTool()],
      }),
      model: "openai/gpt-4o-mini",
      messages: [stringToUserMessage("message the other panda")],
      runtime,
      context: {
        cwd: process.cwd(),
        agentKey: "panda",
        sessionId: "session-a",
        threadId: "thread-a",
        messageAgent: {
          queueMessage,
        },
      } satisfies DefaultAgentSessionContext,
    });

    const outputs = [];
    for await (const output of thread.run()) {
      outputs.push(output);
    }

    expect(queueMessage).toHaveBeenCalledWith({
      senderAgentKey: "panda",
      senderSessionId: "session-a",
      senderThreadId: "thread-a",
      senderRunId: undefined,
      agentKey: undefined,
      sessionId: "session-b",
      items: [{type: "text", text: "ping"}],
    });
    expect(outputs).toContainEqual(expect.objectContaining({
      role: "toolResult",
      toolName: "message_agent",
      details: {
        ok: true,
        status: "queued",
        deliveryId: "delivery-1",
        targetAgentKey: "koala",
        targetSessionId: "session-b",
        messageId: "a2a:thread-smoke",
      },
    }));
  });
});
