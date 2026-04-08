import { describe, expect, it } from "vitest";

import {
  buildTelegramConversationId,
  buildTelegramInboundText,
  buildTelegramPairCommand,
  buildTelegramStartText,
  normalizeTelegramCommand,
  type MediaDescriptor,
} from "../src/index.js";

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
    expect(buildTelegramStartText({ actorId: "123" })).toContain("--actor 123");
    expect(buildTelegramStartText({ actorId: "123" })).toContain("<pre><code>");
  });

  it("adds a media manifest to inbound text", () => {
    expect(buildTelegramInboundText({
      connectorKey: "bot-main",
      externalConversationId: "123",
      externalActorId: "456",
      externalMessageId: "789",
      chatId: "123",
      chatType: "private",
      text: "hello",
      media: [],
    })).toContain("<panda-channel-context>");
    expect(buildTelegramInboundText({
      connectorKey: "bot-main",
      externalConversationId: "123",
      externalActorId: "456",
      externalMessageId: "789",
      chatId: "123",
      chatType: "private",
      media: [mediaDescriptor()],
    })).toContain("attachments:");
    expect(buildTelegramInboundText({
      connectorKey: "bot-main",
      externalConversationId: "123",
      externalActorId: "456",
      externalMessageId: "789",
      chatId: "123",
      chatType: "private",
      text: "caption",
      media: [
        mediaDescriptor({
          originalFilename: "photo.jpg",
        }),
      ],
    })).toContain("photo.jpg");
  });
});
