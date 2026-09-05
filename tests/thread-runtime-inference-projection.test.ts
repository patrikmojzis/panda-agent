import {mkdtemp, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {describe, expect, it, vi} from "vitest";
import type {AssistantMessage, ToolResultMessage} from "@earendil-works/pi-ai";

import {Agent, BrowserTool, type LlmRuntime, stringToUserMessage} from "../src/index.js";
import {
    createCompactBoundaryMessage,
    projectTranscriptForInference,
    type ResolvedThreadDefinition,
    type ThreadMessageRecord,
    type ThreadRunOwner,
    ThreadRuntimeCoordinator,
    type ThreadRuntimeCoordinatorOptions,
} from "../src/app/sdk/thread-runtime.js";
import {TestThreadRuntimeStore} from "./helpers/test-runtime-store.js";

const TEST_RUN_OWNER: ThreadRunOwner = {
  source: "panda-core",
  connectorKey: "test",
  holderId: "thread-runtime-inference-projection-test",
};

async function createTestCoordinator(
  options: Omit<ThreadRuntimeCoordinatorOptions, "maxConcurrentRuns">,
): Promise<ThreadRuntimeCoordinator> {
  const coordinator = new ThreadRuntimeCoordinator({...options, maxConcurrentRuns: 1});
  await coordinator.handleStoreNotificationStatus("listening");
  await coordinator.start(TEST_RUN_OWNER);
  return coordinator;
}

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
          compactedThroughSequence: 2,
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

  it.each([
    {label: "a longer user-turn floor", rule: {preserveTailMessages: 2, preserveRecentUserTurns: 2}, expected: [5, 6, 7, 8, 9]},
    {label: "a longer message floor", rule: {preserveTailMessages: 6, preserveRecentUserTurns: 1}, expected: [4, 5, 6, 7, 8, 9]},
    {label: "fewer user turns than requested", rule: {preserveRecentUserTurns: 99}, expected: [3, 4, 5, 6, 7, 8, 9]},
    {label: "a checkpoint outside the latest turn", rule: {preserveRecentUserTurns: 1}, expected: [5, 8, 9]},
  ])("preserves $label without counting compact summaries as user turns", ({rule, expected}) => {
    const boundary = (sequence: number) => createRecord(sequence, createCompactBoundaryMessage("Saved context"), {
      origin: "runtime", source: "compact",
      metadata: {kind: "compact_boundary", compactedThroughSequence: sequence - 1, preservedTailUserTurns: 1, trigger: "manual"},
    });
    const transcript = [
      createRecord(1, createAssistantMessage([{type: "text", text: "preface"}])),
      boundary(2),
      createRecord(3, stringToUserMessage("first turn")),
      createRecord(4, createAssistantMessage([{type: "text", text: "first reply"}])),
      boundary(5),
      createRecord(6, stringToUserMessage("second turn")),
      createRecord(7, createAssistantMessage([{type: "text", text: "second reply"}])),
      createRecord(8, stringToUserMessage("third turn")),
      createRecord(9, createAssistantMessage([{type: "text", text: "third reply"}])),
    ];

    const projected = projectTranscriptForInference(transcript, {dropMessages: rule}, 20_000);
    expect(projected.map((record) => record.sequence)).toEqual(expected);
    for (const record of projected) expect(record).toBe(transcript[record.sequence - 1]);
    expect(transcript).toHaveLength(9);
  });

  it("keeps only the checkpoint when a user-turn floor has no ordinary user turn", () => {
    const boundary = createRecord(2, createCompactBoundaryMessage("Saved context"), {
      origin: "runtime", source: "compact",
      metadata: {kind: "compact_boundary", compactedThroughSequence: 1, preservedTailUserTurns: 1, trigger: "manual"},
    });
    const transcript = [
      createRecord(1, createAssistantMessage([{type: "text", text: "preface"}])),
      boundary,
      createRecord(3, createAssistantMessage([{type: "text", text: "reply"}])),
    ];

    expect(projectTranscriptForInference(transcript, {dropMessages: {preserveRecentUserTurns: 2}}, 20_000)).toEqual([boundary]);
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
        {type: "toolCall", id: "call-2", name: "echo", arguments: {message: "image only"}},
      ])),
      createRecord(4, createToolResultMessage("call-1", [
        {type: "text", text: "preview"},
        {type: "image", data: "ZmFrZQ==", mimeType: "image/png"},
      ])),
      createRecord(5, createToolResultMessage("call-2", [
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
    expect(projected[1]).toBe(transcript[2]);
    expect(projected[2]?.message).toMatchObject({
      role: "toolResult",
      content: [{type: "text", text: "preview"}],
    });
  });

  it("preserves unchanged message instances and whitespace when dropping images", () => {
    const transcript = [
      createRecord(1, stringToUserMessage("  plain text\n")),
      createRecord(2, {role: "user", content: [{type: "text", text: "  block text\n"}], timestamp: 2}),
      createRecord(3, {role: "user", content: [], timestamp: 3}),
      createRecord(4, createAssistantMessage([
        {type: "toolCall", id: "call-1", name: "echo", arguments: {}},
        {type: "toolCall", id: "call-2", name: "echo", arguments: {}},
      ])),
      createRecord(5, createToolResultMessage("call-1", [{type: "text", text: "  tool text\n"}])),
      createRecord(6, createToolResultMessage("call-2", [])),
      createRecord(7, {
        role: "user",
        content: [{type: "image", data: "ZmFrZQ==", mimeType: "image/png"}],
        timestamp: 7,
      }),
    ];
    const original = structuredClone(transcript);

    const projected = projectTranscriptForInference(transcript, {
      dropImages: {preserveTailMessages: 1},
    }, 20_000);

    expect(projected).toHaveLength(transcript.length);
    for (const [index, record] of transcript.entries()) {
      expect(projected[index]).toBe(record);
    }
    expect(transcript).toEqual(original);
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
    const inferenceProjection = {
      dropMessages: {
        preserveRecentUserTurns: 1,
      },
    };

    await store.createThread({
      id: "thread-inference-projection",
      sessionId: "session-inference-projection",
    });

    await store.enqueueInput("thread-inference-projection", {
      message: stringToUserMessage("old request"),
      source: "tui",
    });
    const seedRun = await store.createRun("thread-inference-projection");
    await store.applyPendingInputs("thread-inference-projection", seedRun.id);
    await store.completeRun(seedRun.id);
    await store.appendRuntimeMessage("thread-inference-projection", {
      message: createAssistantMessage([{type: "text", text: "old reply"}]),
      source: "assistant",
    });

    const definition: ResolvedThreadDefinition = {
      agent: new Agent({
        name: "projection-agent",
        instructions: "Reply briefly",
      }),
      inferenceProjection,
      runtime,
    };
    const coordinator = await createTestCoordinator({
      store,
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

    const storedTranscript = await store.loadTranscriptHistory("thread-inference-projection");
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
      const coordinator = await createTestCoordinator({
        store,
        resolveDefinition: async () => definition,
      });

      await coordinator.submitInput("thread-browser-redaction", {
        message: stringToUserMessage("take a screenshot"),
        source: "tui",
      });
      await coordinator.waitForIdle("thread-browser-redaction");

      const storedTranscript = await store.loadTranscriptHistory("thread-browser-redaction");
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
        inferenceProjection: {
          dropImages: {
            olderThanMs: 0,
          },
        },
      };
      const coordinator = await createTestCoordinator({
        store,
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
    });
    await store.enqueueInput("thread-missing-artifact", {
      message: stringToUserMessage("previous request"),
      source: "tui",
    });
    const seedRun = await store.createRun("thread-missing-artifact");
    await store.applyPendingInputs("thread-missing-artifact", seedRun.id);
    await store.completeRun(seedRun.id);
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
    const coordinator = await createTestCoordinator({
      store,
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
