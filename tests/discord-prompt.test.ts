import {describe, expect, it} from "vitest";

import {renderDiscordInboundText} from "../src/prompts/channels/discord.js";

function baseInput() {
  return {
    connectorKey: "discord-main",
    conversationId: "12345",
    actualChannelId: "12345",
    actorId: "23456",
    externalMessageId: "34567",
    attachments: [],
    embeds: [],
    stickers: [],
  };
}

describe("Discord inbound prompt", () => {
  it("names an embed-only GIF message instead of calling it an attachment", () => {
    const text = renderDiscordInboundText({
      ...baseInput(),
      embeds: [{type: "gifv", media: [{kind: "video", status: "downloaded"}]}],
    });
    expect(text).toContain("Discord message with one GIF embed.");
    expect(text).not.toContain("one attachment");
  });

  it("names a sticker-only Lottie message and keeps its limitation explicit", () => {
    const text = renderDiscordInboundText({
      ...baseInput(),
      stickers: [{
        id: "45678",
        name: "wave",
        format: "lottie",
        status: "unsupported",
        reason: "unsupported_format",
      }],
    });
    expect(text).toContain("Discord message with one Lottie sticker.");
    expect(text).toContain("status=unsupported reason=unsupported_format");
  });
});
