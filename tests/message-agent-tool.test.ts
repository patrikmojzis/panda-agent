import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
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

function createDisposableExecutionEnvironment(paths: Partial<{
  rootHostPath: string;
  rootCorePath: string;
  workspaceCorePath: string;
  inboxCorePath: string;
  artifactsCorePath: string;
}> = {}): NonNullable<DefaultAgentSessionContext["executionEnvironment"]> {
  const rootCorePath = paths.rootCorePath ?? "/root/.panda/environments/panda/worker-a";
  return {
    id: "worker:session-a",
    agentKey: "panda",
    kind: "disposable_container",
    state: "ready",
    executionMode: "remote",
    initialCwd: "/workspace",
    rootPath: "/workspace",
    source: "binding",
    credentialPolicy: {mode: "allowlist", envKeys: []},
    skillPolicy: {mode: "allowlist", skillKeys: []},
    toolPolicy: {},
    metadata: {
      filesystem: {
        envDir: "worker-a",
        root: {
          ...(paths.rootHostPath ? {hostPath: paths.rootHostPath} : {}),
          corePath: rootCorePath,
          parentRunnerPath: "/environments/worker-a",
        },
        workspace: {
          corePath: paths.workspaceCorePath ?? path.join(rootCorePath, "workspace"),
          parentRunnerPath: "/environments/worker-a/workspace",
          workerPath: "/workspace",
        },
        inbox: {
          corePath: paths.inboxCorePath ?? path.join(rootCorePath, "inbox"),
          parentRunnerPath: "/environments/worker-a/inbox",
          workerPath: "/inbox",
        },
        artifacts: {
          corePath: paths.artifactsCorePath ?? path.join(rootCorePath, "artifacts"),
          parentRunnerPath: "/environments/worker-a/artifacts",
          workerPath: "/artifacts",
        },
      },
    },
  };
}

function expectedSenderEnvironment() {
  return {
    id: "worker:session-a",
    kind: "disposable_container",
    envDir: "worker-a",
    parentRunnerPaths: {
      root: "/environments/worker-a",
      workspace: "/environments/worker-a/workspace",
      inbox: "/environments/worker-a/inbox",
      artifacts: "/environments/worker-a/artifacts",
    },
    workerPaths: {
      workspace: "/workspace",
      inbox: "/inbox",
      artifacts: "/artifacts",
    },
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

  it("passes disposable sender environment hints without leaking core paths", async () => {
    const tool = new MessageAgentTool<DefaultAgentSessionContext>();
    const context = createContext({
      executionEnvironment: createDisposableExecutionEnvironment({
        rootHostPath: "/Users/patrikmojzis/.panda/environments/panda/worker-a",
      }),
    });

    await tool.run({
      sessionId: "session-b",
      items: [{type: "text", text: "done"}],
    }, createRunContext(context));

    const senderEnvironment = context.queueMessage.mock.calls[0]?.[0]?.senderEnvironment;
    expect(senderEnvironment).toEqual(expectedSenderEnvironment());
    expect(JSON.stringify(senderEnvironment)).not.toContain("/root/.panda");
    expect(JSON.stringify(senderEnvironment)).not.toContain("/Users/patrikmojzis");
  });

  it("does not leak core paths when disposable attachments fail validation", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "panda-message-agent-tool-"));
    directories.add(tempDir);
    const artifacts = path.join(tempDir, "artifacts");
    const hugeFile = path.join(artifacts, "huge.bin");
    await mkdir(artifacts, {recursive: true});
    await writeFile(hugeFile, Buffer.alloc(20 * 1024 * 1024 + 1));

    const tool = new MessageAgentTool<DefaultAgentSessionContext>();
    const context = createContext({
      executionEnvironment: createDisposableExecutionEnvironment({
        rootCorePath: tempDir,
        artifactsCorePath: artifacts,
      }),
    });

    await expect(tool.run({
      sessionId: "session-b",
      items: [{type: "file", path: "/artifacts/huge.bin"}],
    }, createRunContext(context))).rejects.toThrow("Attachment /artifacts/huge.bin is too large");
    await expect(tool.run({
      sessionId: "session-b",
      items: [{type: "file", path: "/artifacts/missing.bin"}],
    }, createRunContext(context))).rejects.toThrow("No readable file found at /artifacts/missing.bin");
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

  it("turns A2A policy failures into recoverable tool errors", async () => {
    const tool = new MessageAgentTool<DefaultAgentSessionContext>();
    const context = createContext();
    context.queueMessage.mockRejectedValueOnce(new Error("A2A is not allowed from session-a to session-b."));

    await expect(tool.run({
      sessionId: "session-b",
      items: [{type: "text", text: "hello"}],
    }, createRunContext(context))).rejects.toThrow(ToolError);
  });

  it("keeps the thread alive when A2A rejects a message", async () => {
    const queueMessage = vi.fn(async () => {
      throw new Error("A2A is not allowed from session-a to session-b.");
    });
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
      createAssistantMessage([{type: "text", text: "I could not send it."}]),
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

    expect(outputs).toContainEqual(expect.objectContaining({
      role: "toolResult",
      toolName: "message_agent",
      isError: true,
    }));
    expect(outputs).toContainEqual(expect.objectContaining({
      role: "assistant",
    }));
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
