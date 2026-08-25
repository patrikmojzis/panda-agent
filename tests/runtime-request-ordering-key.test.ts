import {describe, expect, it} from "vitest";

import {
  deriveRuntimeRequestIngressIdempotencyKey,
  deriveRuntimeRequestOrderingKey,
} from "../src/domain/threads/requests/ordering-key.js";

describe("runtime request ordering keys", () => {
  it("shares one causal stream across message and reaction events for a conversation", () => {
    const message = deriveRuntimeRequestOrderingKey({
      kind: "telegram_message",
      payload: {
        connectorKey: "bot-1",
        externalConversationId: "chat-1",
        chatId: "chat-1",
        chatType: "private",
        externalActorId: "actor-1",
        externalMessageId: "message-1",
        media: [],
      },
    });
    const reaction = deriveRuntimeRequestOrderingKey({
      kind: "telegram_reaction",
      payload: {
        connectorKey: "bot-1",
        externalConversationId: "chat-1",
        chatId: "chat-1",
        chatType: "private",
        externalActorId: "actor-1",
        updateId: 1,
        targetMessageId: "message-1",
        addedEmojis: ["👍"],
      },
    });

    expect(message).toBe(reaction);
    expect(message).toMatch(/^v1:[0-9a-f]{64}$/);
  });

  it("separates connectors and target sessions", () => {
    const telegram = (connectorKey: string) => deriveRuntimeRequestOrderingKey({
      kind: "telegram_message",
      payload: {
        connectorKey,
        externalConversationId: "chat-1",
        chatId: "chat-1",
        chatType: "private",
        externalActorId: "actor-1",
        externalMessageId: "message-1",
        media: [],
      },
    });
    const session = (sessionId: string) => deriveRuntimeRequestOrderingKey({
      kind: "compact_session",
      payload: {sessionId, customInstructions: ""},
    });

    expect(telegram("bot-1")).not.toBe(telegram("bot-2"));
    expect(session("session-1")).not.toBe(session("session-2"));
  });

  it("serializes subagent creation with its parent session lifecycle", () => {
    const createSubagent = deriveRuntimeRequestOrderingKey({
      kind: "create_subagent_session",
      payload: {
        sessionId: "child-session",
        threadId: "child-thread",
        parentSessionId: "parent-session",
        prompt: "Inspect the archive seam.",
      },
    });
    const archiveParent = deriveRuntimeRequestOrderingKey({
      kind: "archive_session",
      payload: {sessionId: "parent-session"},
    });
    const archiveChild = deriveRuntimeRequestOrderingKey({
      kind: "archive_session",
      payload: {sessionId: "child-session"},
    });

    expect(createSubagent).toBe(archiveParent);
    expect(createSubagent).not.toBe(archiveChild);
  });

  it("deduplicates one transport event without merging other connectors or event kinds", () => {
    const key = (
      kind: "telegram_message" | "telegram_reaction",
      connectorKey = "bot-1",
      externalEventScope = "chat-1",
    ) => (
      deriveRuntimeRequestIngressIdempotencyKey({
        kind,
        connectorKey,
        externalEventScope,
        externalEventId: "event-42",
      })
    );

    expect(key("telegram_message")).toBe(key("telegram_message"));
    expect(key("telegram_message")).toMatch(/^ingress:v1:[0-9a-f]{64}$/);
    expect(key("telegram_message")).not.toBe(key("telegram_reaction"));
    expect(key("telegram_message")).not.toBe(key("telegram_message", "bot-2"));
    expect(key("telegram_message")).not.toBe(key("telegram_message", "bot-1", "chat-2"));
  });
});
