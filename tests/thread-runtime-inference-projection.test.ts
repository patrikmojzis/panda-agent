import {describe, expect, it, vi} from "vitest";
import type {AssistantMessage, ToolResultMessage} from "@mariozechner/pi-ai";

import {
    Agent,
    createCompactBoundaryMessage,
    type LlmRuntime,
    projectTranscriptForInference,
    type ResolvedThreadDefinition,
    stringToUserMessage,
    type ThreadMessageRecord,
    ThreadRuntimeCoordinator,
} from "../src/index.js";
import {TestThreadRuntimeStore} from "./helpers/test-runtime-store.js";

function createAssistantMessage(
  content: AssistantMessage["content"],
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  const stopReason = content.some((block) => block.type === "toolCall") ? "toolUse" : "stop";

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
    stopReason,
    timestamp: Date.now(),
    ...overrides,
  };
}

function createToolResultMessage(
  toolCallId: string,
  content: ToolResultMessage["content"],
  overrides: Partial<ToolResultMessage> = {},
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "echo",
    content,
    isError: false,
    timestamp: Date.now(),
    ...overrides,
  };
}

function createRecord(
  sequence: number,
  message: ThreadMessageRecord["message"],
  overrides: Partial<ThreadMessageRecord> = {},
): ThreadMessageRecord {
  return {
    id: `record-${sequence}`,
    threadId: "thread-projection",
    sequence,
    origin: message.role === "user" ? "input" : "runtime",
    source: message.role === "user" ? "tui" : message.role === "toolResult" ? `tool:${message.toolName}` : "assistant",
    message,
    createdAt: sequence * 1_000,
    ...overrides,
  };
}

function createMockRuntime(...responses: AssistantMessage[]): LlmRuntime & {
  complete: ReturnType<typeof vi.fn>;
} {
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

class SelectiveLeaseManager {
  async tryAcquire(threadId: string) {
    return {
      threadId,
      release: async () => {},
    };
  }
}

describe("projectTranscriptForInference", () => {
  it("leaves the transcript alone when no projection rules are enabled", () => {
    const transcript = [
      createRecord(1, stringToUserMessage("request")),
      createRecord(2, createToolResultMessage("missing-call", [
        {type: "text", text: "result"},
      ])),
    ];

    const projected = projectTranscriptForInference(transcript, {}, 20_000);

    expect(projected).toEqual(transcript);
  });

  it("drops messages older than ttl while preserving the latest compact boundary", () => {
    const boundary = createCompactBoundaryMessage("Intent:\n- continue");
    const transcript = [
      createRecord(1, stringToUserMessage("old user request")),
      createRecord(2, createAssistantMessage([{type: "text", text: "old assistant reply"}])),
      createRecord(3, boundary, {
        origin: "runtime",
        source: "compact",
        metadata: {
          kind: "compact_boundary",
          compactedUpToSequence: 2,
          preservedTailUserTurns: 3,
          trigger: "manual",
        },
      }),
    ];

    const projected = projectTranscriptForInference(transcript, {
      dropMessages: {olderThanMs: 100_000},
    }, 200_000);

    expect(projected.map((record) => record.sequence)).toEqual([3]);
    expect(projected[0]?.source).toBe("compact");
  });

  it("treats configured floors as absolute and drops everything outside them immediately", () => {
    const transcript = [
      createRecord(1, stringToUserMessage("first")),
      createRecord(2, createAssistantMessage([{type: "text", text: "first reply"}])),
      createRecord(3, stringToUserMessage("keep this turn")),
      createRecord(4, createAssistantMessage([{type: "text", text: "and this reply"}])),
    ];

    const projected = projectTranscriptForInference(transcript, {
      dropMessages: {
        preserveTailMessages: 2,
        olderThanMs: 1,
      },
    }, 4_500);

    expect(projected.map((record) => record.sequence)).toEqual([3, 4]);
  });

  it("drops thinking blocks and removes empty assistant messages", () => {
    const transcript = [
      createRecord(1, createAssistantMessage([
        {type: "thinking", thinking: "private chain of thought"},
      ])),
      createRecord(2, createAssistantMessage([
        {type: "thinking", thinking: "reasoning"},
        {type: "text", text: "public answer"},
      ])),
    ];

    const projected = projectTranscriptForInference(transcript, {
      dropThinking: {olderThanMs: 10_000},
    }, 20_000);

    expect(projected).toHaveLength(1);
    expect(projected[0]?.message).toMatchObject({
      role: "assistant",
      content: [{type: "text", text: "public answer"}],
    });
  });

  it("drops old tool calls and matching tool results while preserving assistant text", () => {
    const transcript = [
      createRecord(1, stringToUserMessage("run the tool")),
      createRecord(2, createAssistantMessage([
        {type: "text", text: "Checking that now."},
        {type: "toolCall", id: "call-1", name: "echo", arguments: {message: "hello"}},
      ])),
      createRecord(3, createToolResultMessage("call-1", [
        {type: "text", text: "hello"},
      ])),
    ];

    const projected = projectTranscriptForInference(transcript, {
      dropToolCalls: {olderThanMs: 10_000},
    }, 20_000);

    expect(projected).toHaveLength(2);
    expect(projected.map((record) => record.sequence)).toEqual([1, 2]);
    expect(projected[1]?.message).toMatchObject({
      role: "assistant",
      content: [{type: "text", text: "Checking that now."}],
    });
  });

  it("keeps an old tool call when its result is protected so the sequence stays coherent", () => {
    const transcript = [
      createRecord(1, stringToUserMessage("run the tool")),
      createRecord(2, createAssistantMessage([
        {type: "toolCall", id: "call-1", name: "echo", arguments: {message: "hello"}},
      ])),
      createRecord(3, createToolResultMessage("call-1", [
        {type: "text", text: "hello"},
      ])),
    ];

    const projected = projectTranscriptForInference(transcript, {
      dropToolCalls: {
        preserveTailMessages: 1,
      },
    }, 20_000);

    expect(projected.map((record) => record.sequence)).toEqual([1, 2, 3]);
  });

  it("hard-removes images from old user and tool-result messages and drops empty shells", () => {
    const transcript = [
      createRecord(1, {
        role: "user",
        content: [{type: "image", data: "ZmFrZQ==", mimeType: "image/png"}],
        timestamp: 1,
      }),
      createRecord(2, {
        role: "user",
        content: [
          {type: "text", text: "See attachment"},
          {type: "image", data: "ZmFrZQ==", mimeType: "image/png"},
        ],
        timestamp: 2,
      }),
      createRecord(3, createAssistantMessage([
        {type: "toolCall", id: "call-1", name: "echo", arguments: {message: "preview"}},
      ])),
      createRecord(4, createToolResultMessage("call-1", [
        {type: "text", text: "preview"},
        {type: "image", data: "ZmFrZQ==", mimeType: "image/png"},
      ])),
    ];

    const projected = projectTranscriptForInference(transcript, {
      dropImages: {olderThanMs: 10_000},
    }, 20_000);

    expect(projected).toHaveLength(3);
    expect(projected[0]?.message).toMatchObject({
      role: "user",
      content: [{type: "text", text: "See attachment"}],
    });
    expect(projected[1]?.message).toMatchObject({
      role: "assistant",
      content: [{type: "toolCall", id: "call-1", name: "echo", arguments: {message: "preview"}}],
    });
    expect(projected[2]?.message).toMatchObject({
      role: "toolResult",
      content: [{type: "text", text: "preview"}],
    });
  });

  it("applies combined rules without leaving empty messages or dangling tool results", () => {
    const transcript = [
      createRecord(1, {
        role: "user",
        content: [{type: "image", data: "ZmFrZQ==", mimeType: "image/png"}],
        timestamp: 1,
      }),
      createRecord(2, createAssistantMessage([
        {type: "thinking", thinking: "secret"},
        {type: "toolCall", id: "call-1", name: "echo", arguments: {message: "hello"}},
      ])),
      createRecord(3, createToolResultMessage("call-1", [
        {type: "image", data: "ZmFrZQ==", mimeType: "image/png"},
      ])),
      createRecord(4, stringToUserMessage("keep the latest user turn")),
    ];

    const projected = projectTranscriptForInference(transcript, {
      dropToolCalls: {olderThanMs: 10_000},
      dropThinking: {olderThanMs: 10_000},
      dropImages: {olderThanMs: 10_000},
    }, 20_000);

    expect(projected.map((record) => record.sequence)).toEqual([4]);
  });
});

describe("ThreadRuntimeCoordinator inference projection", () => {
  it("shrinks replayed model context without mutating stored transcript", async () => {
    const runtime = createMockRuntime(createAssistantMessage([
      {type: "text", text: "fresh reply"},
    ]));
    const store = new TestThreadRuntimeStore();

    await store.createThread({
      id: "thread-inference-projection",
      agentKey: "projection-agent",
      inferenceProjection: {
        dropMessages: {
          preserveRecentUserTurns: 1,
        },
      },
    });

    await store.enqueueInput("thread-inference-projection", {
      message: stringToUserMessage("old request"),
      source: "tui",
    });
    await store.applyPendingInputs("thread-inference-projection");
    await store.appendRuntimeMessage("thread-inference-projection", {
      message: createAssistantMessage([{type: "text", text: "old reply"}]),
      source: "assistant",
    });

    const definition: ResolvedThreadDefinition = {
      agent: new Agent({
        name: "projection-agent",
        instructions: "Reply briefly",
      }),
      runtime,
    };
    const coordinator = new ThreadRuntimeCoordinator({
      store,
      leaseManager: new SelectiveLeaseManager(),
      resolveDefinition: async () => definition,
    });

    await coordinator.submitInput("thread-inference-projection", {
      message: stringToUserMessage("new request"),
      source: "tui",
    });
    await coordinator.waitForIdle("thread-inference-projection");

    const request = runtime.complete.mock.calls[0]?.[0];
    expect(request?.context.messages).toMatchObject([
      {
        role: "user",
        content: "new request",
      },
    ]);

    const storedTranscript = await store.loadTranscript("thread-inference-projection");
    expect(storedTranscript.map((record) => record.sequence)).toEqual([1, 2, 3, 4]);
    expect(storedTranscript[0]?.message).toMatchObject({
      role: "user",
      content: "old request",
    });
    expect(storedTranscript[1]?.message).toMatchObject({
      role: "assistant",
      content: [{type: "text", text: "old reply"}],
    });
  });
});
