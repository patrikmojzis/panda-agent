import {describe, expect, it} from "vitest";

import type {MediaDescriptor} from "../src/domain/channels/index.js";
import {
    buildTelegramConversationId,
    buildTelegramInboundText,
    buildTelegramPairCommand,
    buildTelegramReactionText,
    normalizeTelegramCommand,
} from "../src/integrations/channels/telegram/helpers.js";

function mediaDescriptor(overrides: Partial<MediaDescriptor> = {}): MediaDescriptor {
  return {
    id: "media-1",
    source: "telegram",
    connectorKey: "bot-main",
    mimeType: "image/jpeg",
    sizeBytes: 128,
    localPath: "/tmp/example.jpg",
    createdAt: 0,
    ...overrides,
  };
}

describe("telegram helpers", () => {
  it("builds deterministic conversation ids", () => {
    expect(buildTelegramConversationId("42")).toBe("42");
    expect(buildTelegramConversationId("42", "9")).toBe("42:9");
  });

  it("normalizes telegram commands with optional bot username", () => {
    expect(normalizeTelegramCommand("/start", "panda_bot")).toBe("start");
    expect(normalizeTelegramCommand("/new@panda_bot hello", "panda_bot")).toBe("new");
    expect(normalizeTelegramCommand("/new@other_bot", "panda_bot")).toBeNull();
    expect(normalizeTelegramCommand("hello", "panda_bot")).toBeNull();
  });

  it("builds pairing bootstrap text", () => {
    expect(buildTelegramPairCommand("123", "local")).toBe(
      "panda telegram pair --identity local --actor 123",
    );
  });

  it("adds a media manifest to inbound text", () => {
    expect(buildTelegramInboundText({
      connectorKey: "bot-main",
      externalConversationId: "123",
      externalActorId: "456",
      externalMessageId: "789",
      identityId: "alice-id",
      identityHandle: "alice",
      chatId: "123",
      chatType: "private",
      text: "hello",
      media: [],
    })).toContain("<runtime-channel-context>");
    expect(buildTelegramInboundText({
      connectorKey: "bot-main",
      externalConversationId: "123",
      externalActorId: "456",
      externalMessageId: "789",
      identityId: "alice-id",
      identityHandle: "alice",
      chatId: "123",
      chatType: "private",
      media: [mediaDescriptor()],
    })).toContain("attachments:");
    expect(buildTelegramInboundText({
      connectorKey: "bot-main",
      externalConversationId: "123",
      externalActorId: "456",
      externalMessageId: "789",
      identityId: "alice-id",
      identityHandle: "alice",
      chatId: "123",
      chatType: "private",
      text: "caption",
      media: [
        mediaDescriptor({
          originalFilename: "photo.jpg",
        }),
      ],
    })).toContain("photo.jpg");
    expect(buildTelegramInboundText({
      connectorKey: "bot-main",
      externalConversationId: "123",
      externalActorId: "456",
      externalMessageId: "789",
      identityId: "alice-id",
      identityHandle: "alice",
      chatId: "123",
      chatType: "private",
      text: "hello",
      media: [],
    })).toContain("identity_handle: alice");
  });

  it("builds reaction text with reaction-specific context fields", () => {
    const text = buildTelegramReactionText({
      connectorKey: "bot-main",
      externalConversationId: "123",
      externalActorId: "456",
      externalMessageId: "telegram-reaction:789",
      identityId: "alice-id",
      identityHandle: "alice",
      chatId: "123",
      chatType: "private",
      username: "alice",
      firstName: "Alice",
      lastName: "Liddell",
      targetMessageId: "777",
      addedEmojis: ["🔥", "👍"],
    });

    expect(text).toContain("reaction_target_message_id: 777");
    expect(text).toContain("identity_id: alice-id");
    expect(text).toContain("identity_handle: alice");
    expect(text).toContain("reaction_added_emojis: 🔥, 👍");
    expect(text).toContain("reaction_actor_id: 456");
    expect(text).toContain("reaction_actor_username: alice");
    expect(text).toContain("Added reactions: 🔥, 👍");
  });
});
