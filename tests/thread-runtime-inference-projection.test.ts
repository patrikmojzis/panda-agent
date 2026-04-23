import {mkdtemp, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {describe, expect, it, vi} from "vitest";
import type {AssistantMessage, ToolResultMessage} from "@mariozechner/pi-ai";

import {Agent, BrowserTool, type LlmRuntime, stringToUserMessage} from "../src/index.js";
import {
    createCompactBoundaryMessage,
    projectTranscriptForInference,
    type ResolvedThreadDefinition,
    type ThreadMessageRecord,
    ThreadRuntimeCoordinator,
} from "../src/domain/threads/runtime/index.js";
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
    const runtime = createMockRuntime(
      createAssistantMessage([
        {type: "text", text: "fresh reply"},
      ]),
      createAssistantMessage([
        {type: "text", text: "Nothing else to do."},
      ]),
    );
    const store = new TestThreadRuntimeStore();

    await store.createThread({
      id: "thread-inference-projection",
      sessionId: "session-inference-projection",
      context: {
        sessionId: "session-inference-projection",
        agentKey: "projection-agent",
      },
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
    expect(storedTranscript.map((record) => record.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(storedTranscript[0]?.message).toMatchObject({
      role: "user",
      content: "old request",
    });
    expect(storedTranscript[1]?.message).toMatchObject({
      role: "assistant",
      content: [{type: "text", text: "old reply"}],
    });
  });

  it("redacts browser screenshot image blocks before persisting the transcript", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "runtime-browser-artifact-runtime-"));
    const runtime = createMockRuntime(
      createAssistantMessage([
        {
          type: "toolCall",
          id: "call-browser-1",
          name: "browser",
          arguments: {action: "screenshot"},
        },
      ]),
      createAssistantMessage([
        {type: "text", text: "saved it"},
      ]),
      createAssistantMessage([
        {type: "text", text: "looked at the saved screenshot again"},
      ]),
      createAssistantMessage([
        {type: "text", text: "Nothing else to do."},
      ]),
      createAssistantMessage([
        {type: "text", text: "Nothing else to do."},
      ]),
    );
    const store = new TestThreadRuntimeStore();
    const screenshotPath = path.join(directory, "shot.png");
    await writeFile(
      screenshotPath,
      Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO6p6WQAAAAASUVORK5CYII=", "base64"),
    );

    try {
      await store.createThread({
        id: "thread-browser-redaction",
        sessionId: "session-browser-redaction",
        context: {
          sessionId: "session-browser-redaction",
          agentKey: "projection-agent",
        },
      });

      const browserTool = new BrowserTool({
        service: {
          handle: vi.fn(async () => ({
            content: [
              {type: "text" as const, text: `Browser screenshot saved to ${screenshotPath}`},
              {type: "image" as const, data: "A".repeat(4096), mimeType: "image/png"},
            ],
            details: {
              action: "screenshot",
              path: screenshotPath,
              mimeType: "image/png",
              artifact: {
                kind: "image",
                source: "browser",
                path: screenshotPath,
                mimeType: "image/png",
              },
            },
          })),
        },
      });

      const definition: ResolvedThreadDefinition = {
        agent: new Agent({
          name: "projection-agent",
          instructions: "Reply briefly",
          tools: [browserTool],
        }),
        runtime,
      };
      const coordinator = new ThreadRuntimeCoordinator({
        store,
        leaseManager: new SelectiveLeaseManager(),
        resolveDefinition: async () => definition,
      });

      await coordinator.submitInput("thread-browser-redaction", {
        message: stringToUserMessage("take a screenshot"),
        source: "tui",
      });
      await coordinator.waitForIdle("thread-browser-redaction");

      const storedTranscript = await store.loadTranscript("thread-browser-redaction");
      const persistedToolResult = storedTranscript.find((record) => record.message.role === "toolResult");

      expect(persistedToolResult?.message).toMatchObject({
        role: "toolResult",
        toolName: "browser",
        content: [
          {type: "text", text: `Browser screenshot saved to ${screenshotPath}`},
        ],
        details: {
          action: "screenshot",
          path: screenshotPath,
          artifact: {
            kind: "image",
            source: "browser",
            path: screenshotPath,
            mimeType: "image/png",
          },
        },
      });

      await coordinator.submitInput("thread-browser-redaction", {
        message: stringToUserMessage("what did you save?"),
        source: "tui",
      });
      await coordinator.waitForIdle("thread-browser-redaction");

      const replayRequest = runtime.complete.mock.calls.at(-1)?.[0];
      const replayedToolResult = replayRequest?.context.messages.find((message: {role?: string}) => message.role === "toolResult");

      expect(replayedToolResult).toMatchObject({
        role: "toolResult",
        toolName: "browser",
        content: [
          {type: "text", text: `Browser screenshot saved to ${screenshotPath}`},
          {type: "image", mimeType: "image/png"},
        ],
      });
    } finally {
      await rm(directory, {recursive: true, force: true});
    }
  });

  it("keeps replayed artifacts text-only when dropImages would strip them", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "runtime-browser-artifact-drop-images-"));
    const runtime = createMockRuntime(
      createAssistantMessage([
        {
          type: "toolCall",
          id: "call-browser-1",
          name: "browser",
          arguments: {action: "screenshot"},
        },
      ]),
      createAssistantMessage([
        {type: "text", text: "saved it"},
      ]),
      createAssistantMessage([
        {type: "text", text: "image stayed dropped"},
      ]),
      createAssistantMessage([
        {type: "text", text: "Nothing else to do."},
      ]),
      createAssistantMessage([
        {type: "text", text: "Nothing else to do."},
      ]),
    );
    const store = new TestThreadRuntimeStore();
    const screenshotPath = path.join(directory, "shot.png");
    await writeFile(
      screenshotPath,
      Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO6p6WQAAAAASUVORK5CYII=", "base64"),
    );

    try {
      await store.createThread({
        id: "thread-browser-drop-images",
        sessionId: "session-browser-drop-images",
        context: {
          sessionId: "session-browser-drop-images",
          agentKey: "projection-agent",
        },
        inferenceProjection: {
          dropImages: {
            olderThanMs: 0,
          },
        },
      });

      const browserTool = new BrowserTool({
        service: {
          handle: vi.fn(async () => ({
            content: [
              {type: "text" as const, text: `Browser screenshot saved to ${screenshotPath}`},
              {type: "image" as const, data: "A".repeat(4096), mimeType: "image/png"},
            ],
            details: {
              action: "screenshot",
              path: screenshotPath,
              mimeType: "image/png",
              artifact: {
                kind: "image",
                source: "browser",
                path: screenshotPath,
                mimeType: "image/png",
              },
            },
          })),
        },
      });

      const definition: ResolvedThreadDefinition = {
        agent: new Agent({
          name: "projection-agent",
          instructions: "Reply briefly",
          tools: [browserTool],
        }),
        runtime,
      };
      const coordinator = new ThreadRuntimeCoordinator({
        store,
        leaseManager: new SelectiveLeaseManager(),
        resolveDefinition: async () => definition,
      });

      await coordinator.submitInput("thread-browser-drop-images", {
        message: stringToUserMessage("take a screenshot"),
        source: "tui",
      });
      await coordinator.waitForIdle("thread-browser-drop-images");

      await coordinator.submitInput("thread-browser-drop-images", {
        message: stringToUserMessage("what did you save?"),
        source: "tui",
      });
      await coordinator.waitForIdle("thread-browser-drop-images");

      const replayRequest = runtime.complete.mock.calls.at(-1)?.[0];
      const replayedToolResult = replayRequest?.context.messages.find((message: {role?: string}) => message.role === "toolResult");

      expect(replayedToolResult).toMatchObject({
        role: "toolResult",
        toolName: "browser",
        content: [
          {type: "text", text: `Browser screenshot saved to ${screenshotPath}`},
        ],
      });
      expect((replayedToolResult?.content as Array<{type: string}>).some((part) => part.type === "image")).toBe(false);
    } finally {
      await rm(directory, {recursive: true, force: true});
    }
  });

  it("fails soft when a persisted artifact path is missing", async () => {
    const runtime = createMockRuntime(
      createAssistantMessage([
        {type: "text", text: "still fine"},
      ]),
      createAssistantMessage([
        {type: "text", text: "Nothing else to do."},
      ]),
    );
    const store = new TestThreadRuntimeStore();

    await store.createThread({
      id: "thread-missing-artifact",
      sessionId: "session-missing-artifact",
      context: {
        sessionId: "session-missing-artifact",
        agentKey: "projection-agent",
      },
    });
    await store.enqueueInput("thread-missing-artifact", {
      message: stringToUserMessage("previous request"),
      source: "tui",
    });
    await store.applyPendingInputs("thread-missing-artifact");
    await store.appendRuntimeMessage("thread-missing-artifact", {
      message: createToolResultMessage("call-1", [
        {type: "text", text: "Artifact was stored on disk"},
      ], {
        toolName: "view_media",
        details: {
          artifact: {
            kind: "image",
            source: "view_media",
            path: "/definitely/missing/image.png",
            mimeType: "image/png",
          },
        },
      }),
      source: "tool:view_media",
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

    await coordinator.submitInput("thread-missing-artifact", {
      message: stringToUserMessage("new request"),
      source: "tui",
    });
    await coordinator.waitForIdle("thread-missing-artifact");

    const request = runtime.complete.mock.calls[0]?.[0];
    const toolResult = request?.context.messages.find((message: {role?: string}) => message.role === "toolResult");

    expect(toolResult).toMatchObject({
      role: "toolResult",
      toolName: "view_media",
      content: [
        {type: "text", text: "Artifact was stored on disk"},
      ],
    });
  });
});
