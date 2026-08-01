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

  it("shows safe attachment failures and tells the agent to inspect every downloaded path together", () => {
    const text = renderDiscordInboundText({
      ...baseInput(),
      attachments: [
        {id: "one", filename: "one.jpeg", contentType: "image/jpeg", status: "downloaded"},
        {id: "two", filename: "two.jpeg", contentType: "image/jpeg", status: "failed", reason: "http_error", httpStatus: 403},
        {id: "three", filename: "three.jpeg", contentType: "image/jpeg", status: "downloaded"},
      ],
      media: [
        "- id: media-one\n  path: /safe/one.jpg",
        "- id: media-three\n  path: /safe/three.jpg",
      ],
    });

    expect(text).toContain("status=failed reason=http_error http_status=403");
    expect(text).toContain("all 2 downloaded media files belong to this message");
    expect(text).toContain("inspect each path with view_media and do not ask for separate uploads");
  });
});
