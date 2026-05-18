import {describe, expect, it} from "vitest";

import {
  extractAddedTelegramReactionEmojis,
  isAllowedTelegramReactionEmoji,
  parseTelegramReactionMessageId,
} from "../src/integrations/channels/telegram/reactions.js";

describe("telegram reactions", () => {
  it("parses positive numeric Telegram message ids", () => {
    expect(parseTelegramReactionMessageId("123")).toBe(123);
    expect(() => parseTelegramReactionMessageId("0")).toThrow("Invalid Telegram message id 0.");
    expect(() => parseTelegramReactionMessageId("123abc")).toThrow("Invalid Telegram message id 123abc.");
    expect(() => parseTelegramReactionMessageId("wat")).toThrow("Invalid Telegram message id wat.");
  });

  it("keeps only newly added emoji reactions", () => {
    expect(extractAddedTelegramReactionEmojis([
      {type: "emoji", emoji: "🔥"},
      {type: "custom_emoji", custom_emoji_id: "1"},
    ], [
      {type: "emoji", emoji: "🔥"},
      {type: "emoji", emoji: " 👍 "},
      {type: "emoji", emoji: ""},
      {type: "custom_emoji", custom_emoji_id: "2"},
    ])).toEqual(["👍"]);
  });

  it("exposes Telegram's allowed model-facing reaction set", () => {
    expect(isAllowedTelegramReactionEmoji("🔥")).toBe(true);
    expect(isAllowedTelegramReactionEmoji("💪")).toBe(false);
  });
});
