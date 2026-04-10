import {afterEach, describe, expect, it, vi} from "vitest";

import {ChannelTypingDispatcher, stringToUserMessage, type ThreadMessageRecord} from "../src/index.js";
import {resolveChannelRouteTarget} from "../src/features/channels/core/route-target.js";
import {
    CHANNEL_TYPING_KEEPALIVE_MS,
    createChannelTypingEventHandler,
} from "../src/features/thread-runtime/channel-typing.js";

function createInputRecord(
  overrides: Partial<ThreadMessageRecord> = {},
): ThreadMessageRecord {
  return {
    id: "message-1",
    threadId: "thread-1",
    sequence: 1,
    origin: "input",
    source: "telegram",
    channelId: "chat-1",
    message: stringToUserMessage("hello"),
    metadata: {
      route: {
        source: "telegram",
        connectorKey: "connector-1",
        externalConversationId: "chat-1",
        externalActorId: "user-1",
      },
    },
    createdAt: 1,
    ...overrides,
  };
}

function createRunFinishedEvent(
  threadId = "thread-1",
  runId = "run-1",
  status: "completed" | "failed" = "completed",
) {
  return {
    type: "run_finished" as const,
    threadId,
    run: {
      id: runId,
      threadId,
      status,
      startedAt: 1,
      finishedAt: 2,
      ...(status === "failed" ? { error: "boom" } : {}),
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("channel typing core", () => {
  it("routes typing requests to the matching adapter", async () => {
    const send = vi.fn(async () => {});
    const dispatcher = new ChannelTypingDispatcher([{
      channel: "telegram",
      send,
    }]);

    await dispatcher.dispatch({
      channel: " telegram ",
      target: {
        source: "telegram",
        connectorKey: "connector-1",
        externalConversationId: "chat-1",
      },
      phase: "start",
    });

    expect(send).toHaveBeenCalledWith({
      channel: "telegram",
      target: {
        source: "telegram",
        connectorKey: "connector-1",
        externalConversationId: "chat-1",
      },
      phase: "start",
    });
  });

  it("throws when no typing adapter is registered for the channel", async () => {
    const dispatcher = new ChannelTypingDispatcher([]);

    await expect(dispatcher.dispatch({
      channel: "telegram",
      target: {
        source: "telegram",
        connectorKey: "connector-1",
        externalConversationId: "chat-1",
      },
      phase: "start",
    })).rejects.toThrow("No typing adapter registered for channel telegram.");
  });

  it("reads the current inbound route from message metadata", () => {
    expect(resolveChannelRouteTarget({
      source: "telegram",
      metadata: {
        route: {
          connectorKey: "connector-1",
          externalConversationId: "chat-1",
          externalActorId: "user-1",
        },
      },
    })).toEqual({
      channel: "telegram",
      target: {
        source: "telegram",
        connectorKey: "connector-1",
        externalConversationId: "chat-1",
        externalActorId: "user-1",
      },
    });

    expect(resolveChannelRouteTarget({
      source: "telegram",
      metadata: {
        route: {
          connectorKey: "",
          externalConversationId: "chat-1",
        },
      },
    })).toBeNull();
  });
});

describe("createChannelTypingEventHandler", () => {
  it("starts keepalive typing on inputs_applied and stops on run_finished", async () => {
    vi.useFakeTimers();

    const send = vi.fn(async () => {});
    const handler = createChannelTypingEventHandler(new ChannelTypingDispatcher([{
      channel: "telegram",
      send,
    }]));

    await handler({
      type: "inputs_applied",
      threadId: "thread-1",
      runId: "run-1",
      messages: [createInputRecord()],
    });

    expect(send).toHaveBeenNthCalledWith(1, {
      channel: "telegram",
      target: {
        source: "telegram",
        connectorKey: "connector-1",
        externalConversationId: "chat-1",
        externalActorId: "user-1",
      },
      phase: "start",
    });

    await vi.advanceTimersByTimeAsync(CHANNEL_TYPING_KEEPALIVE_MS);

    expect(send).toHaveBeenNthCalledWith(2, {
      channel: "telegram",
      target: {
        source: "telegram",
        connectorKey: "connector-1",
        externalConversationId: "chat-1",
        externalActorId: "user-1",
      },
      phase: "keepalive",
    });

    await handler(createRunFinishedEvent());

    expect(send).toHaveBeenNthCalledWith(3, {
      channel: "telegram",
      target: {
        source: "telegram",
        connectorKey: "connector-1",
        externalConversationId: "chat-1",
        externalActorId: "user-1",
      },
      phase: "stop",
    });
  });

  it("re-targets typing within the same run when a new route arrives", async () => {
    const send = vi.fn(async () => {});
    const handler = createChannelTypingEventHandler(new ChannelTypingDispatcher([{
      channel: "telegram",
      send,
    }]));

    await handler({
      type: "inputs_applied",
      threadId: "thread-1",
      runId: "run-1",
      messages: [createInputRecord()],
    });
    await handler({
      type: "inputs_applied",
      threadId: "thread-1",
      runId: "run-1",
      messages: [createInputRecord({
        id: "message-2",
        metadata: {
          route: {
            source: "telegram",
            connectorKey: "connector-1",
            externalConversationId: "chat-2",
            externalActorId: "user-2",
          },
        },
      })],
    });

    expect(send.mock.calls).toEqual([
      [{
        channel: "telegram",
        target: {
          source: "telegram",
          connectorKey: "connector-1",
          externalConversationId: "chat-1",
          externalActorId: "user-1",
        },
        phase: "start",
      }],
      [{
        channel: "telegram",
        target: {
          source: "telegram",
          connectorKey: "connector-1",
          externalConversationId: "chat-1",
          externalActorId: "user-1",
        },
        phase: "stop",
      }],
      [{
        channel: "telegram",
        target: {
          source: "telegram",
          connectorKey: "connector-1",
          externalConversationId: "chat-2",
          externalActorId: "user-2",
        },
        phase: "start",
      }],
    ]);
  });

  it("ignores messages without a live inbound route", async () => {
    const send = vi.fn(async () => {});
    const handler = createChannelTypingEventHandler(new ChannelTypingDispatcher([{
      channel: "telegram",
      send,
    }]));

    await handler({
      type: "inputs_applied",
      threadId: "thread-1",
      runId: "run-1",
      messages: [createInputRecord({ metadata: undefined })],
    });

    expect(send).not.toHaveBeenCalled();
  });

  it("disables a session after a keepalive failure without retrying it forever", async () => {
    vi.useFakeTimers();

    const send = vi.fn(async (request: { phase: string }) => {
      if (request.phase === "keepalive") {
        throw new Error("channel flaky");
      }
    });
    const handler = createChannelTypingEventHandler(new ChannelTypingDispatcher([{
      channel: "telegram",
      send,
    }]));

    await handler({
      type: "inputs_applied",
      threadId: "thread-1",
      runId: "run-1",
      messages: [createInputRecord()],
    });
    await vi.advanceTimersByTimeAsync(CHANNEL_TYPING_KEEPALIVE_MS);
    await vi.advanceTimersByTimeAsync(CHANNEL_TYPING_KEEPALIVE_MS);
    await handler(createRunFinishedEvent("thread-1", "run-1", "failed"));

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls).toEqual([
      [{
        channel: "telegram",
        target: {
          source: "telegram",
          connectorKey: "connector-1",
          externalConversationId: "chat-1",
          externalActorId: "user-1",
        },
        phase: "start",
      }],
      [{
        channel: "telegram",
        target: {
          source: "telegram",
          connectorKey: "connector-1",
          externalConversationId: "chat-1",
          externalActorId: "user-1",
        },
        phase: "keepalive",
      }],
    ]);
  });
});
