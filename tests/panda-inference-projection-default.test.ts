import {describe, expect, it} from "vitest";
import type {AssistantMessage, ToolResultMessage} from "@earendil-works/pi-ai";

import {createThreadDefinition, DEFAULT_INFERENCE_PROJECTION,} from "../src/app/runtime/create-runtime.js";
import {projectTranscriptForInference} from "../src/domain/threads/runtime/index.js";
import type {ThreadMessageRecord, ThreadRecord} from "../src/domain/threads/runtime/types.js";

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

function createThread(
  overrides: Partial<ThreadRecord> = {},
): ThreadRecord {
  const now = Date.now();
  return {
    id: "thread-defaults",
    sessionId: "session-main",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createTranscriptRecord(
  sequence: number,
  content: string,
  createdAt: number,
): ThreadMessageRecord {
  return {
    id: `record-${sequence}`,
    threadId: "thread-defaults",
    sequence,
    origin: "input",
    source: "tui",
    message: {
      role: "user",
      content,
    },
    createdAt,
  };
}

function createRuntimeTranscriptRecord(
  sequence: number,
  message: AssistantMessage | ToolResultMessage,
  createdAt: number,
): ThreadMessageRecord {
  return {
    id: `record-${sequence}`,
    threadId: "thread-defaults",
    sequence,
    origin: "runtime",
    source: message.role === "toolResult" ? `tool:${message.toolName}` : "assistant",
    message,
    createdAt,
  };
}

describe("createThreadDefinition inference projection defaults", () => {
  it("does not project the transcript by default", () => {
    const definition = createThreadDefinition({
      thread: createThread(),
      session: {
        id: "session-main",
        agentKey: "panda",
      },
      fallbackContext: {
        cwd: "/tmp/panda",
      },
    });

    expect(DEFAULT_INFERENCE_PROJECTION).toEqual({});
    expect(definition.inferenceProjection).toEqual(DEFAULT_INFERENCE_PROJECTION);
    expect(DEFAULT_INFERENCE_PROJECTION).not.toHaveProperty("dropMessages");
    expect(DEFAULT_INFERENCE_PROJECTION).not.toHaveProperty("dropToolCalls");
    expect(DEFAULT_INFERENCE_PROJECTION).not.toHaveProperty("dropImages");
    expect(definition.inferenceProjection?.dropMessages).toBeUndefined();
  });

  it("keeps old text messages when only the Panda default projection is active", () => {
    const now = 5 * DAY_MS;
    const transcript = [
      createTranscriptRecord(1, "older than the former two-day cutoff", now - (3 * DAY_MS)),
      createTranscriptRecord(2, "recent request", now - HOUR_MS),
    ];

    const projected = projectTranscriptForInference(
      transcript,
      DEFAULT_INFERENCE_PROJECTION,
      now,
    );

    expect(projected.map((record) => record.sequence)).toEqual([1, 2]);
  });

  it("keeps old thinking, tool calls, tool results, and images in Panda's default projection", () => {
    const toolCall: AssistantMessage = {
      role: "assistant",
      content: [
        {type: "thinking", thinking: "inspect the artifact"},
        {type: "toolCall", id: "call-1", name: "inspect", arguments: {}},
      ],
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
      stopReason: "toolUse",
      timestamp: 1,
    };
    const toolResult: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "inspect",
      content: [
        {type: "text", text: "result"},
        {type: "image", data: "ZmFrZQ==", mimeType: "image/png"},
      ],
      isError: false,
      timestamp: 2,
    };
    const transcript = [
      createTranscriptRecord(1, "inspect the image", 1),
      createRuntimeTranscriptRecord(2, toolCall, 2),
      createRuntimeTranscriptRecord(3, toolResult, 3),
    ];

    expect(projectTranscriptForInference(transcript, DEFAULT_INFERENCE_PROJECTION, 10 * DAY_MS)).toEqual(transcript);
  });

  it("merges session runtime overrides on top of the Panda default", () => {
    const definition = createThreadDefinition({
      thread: createThread(),
      session: {
        id: "session-main",
        agentKey: "panda",
      },
      fallbackContext: {
        cwd: "/tmp/panda",
      },
      runtimeConfig: {
        sessionId: "session-main",
        thinkingConfigured: false,
        inferenceProjection: {
          dropMessages: {
            olderThanMs: 60_000,
            preserveRecentUserTurns: 1,
          },
          dropThinking: {
            olderThanMs: 60_000,
          },
        },
      },
    });

    expect(definition.inferenceProjection).toEqual({
      ...DEFAULT_INFERENCE_PROJECTION,
      dropMessages: {
        olderThanMs: 60_000,
        preserveRecentUserTurns: 1,
      },
      dropThinking: {
        olderThanMs: 60_000,
      },
    });

    const projected = projectTranscriptForInference([
      createTranscriptRecord(1, "old request", 0),
      createTranscriptRecord(2, "protected recent turn", 90_000),
    ], definition.inferenceProjection, 120_000);

    expect(projected.map((record) => record.sequence)).toEqual([2]);
  });
});
