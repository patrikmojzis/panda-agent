import {mkdtemp, writeFile} from "node:fs/promises";
import path from "node:path";
import {tmpdir} from "node:os";

import type {Api} from "grammy";
import {describe, expect, it, vi} from "vitest";

import {createTelegramOutboundAdapter} from "../src/integrations/channels/telegram/outbound.js";

function createApiMock() {
  return {
    sendMessage: vi.fn(),
    sendPhoto: vi.fn(),
    sendDocument: vi.fn(),
  } as unknown as Api;
}

describe("createTelegramOutboundAdapter", () => {
  it("formats outbound text and captions as Telegram HTML", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "panda-telegram-outbound-"));
    const imagePath = path.join(tempDir, "photo.jpg");
    const filePath = path.join(tempDir, "report.pdf");
    await writeFile(imagePath, "image-bytes");
    await writeFile(filePath, "file-bytes");

    const api = createApiMock();
    vi.mocked(api.sendMessage)
      .mockResolvedValueOnce({message_id: 101});
    vi.mocked(api.sendPhoto)
      .mockResolvedValueOnce({message_id: 102});
    vi.mocked(api.sendDocument)
      .mockResolvedValueOnce({message_id: 103});

    const adapter = createTelegramOutboundAdapter({
      api,
      connectorKey: "main",
    });

    const result = await adapter.send({
      channel: "telegram",
      target: {
        source: "telegram",
        connectorKey: "main",
        externalConversationId: "777",
      },
      items: [
        {type: "text", text: "**Tools**\n\n- Bash\n- Web"},
        {type: "image", path: imagePath, caption: "**Photo** _caption_"},
        {type: "file", path: filePath, filename: "report.pdf", caption: "**Report**"},
      ],
    });

    expect(api.sendMessage).toHaveBeenCalledWith("777", "<b>Tools</b>\n\n• Bash\n• Web", {
      parse_mode: "HTML",
    });
    expect(api.sendPhoto).toHaveBeenCalledWith("777", expect.anything(), {
      caption: "<b>Photo</b> <i>caption</i>",
      parse_mode: "HTML",
    });
    expect(api.sendDocument).toHaveBeenCalledWith("777", expect.anything(), {
      caption: "<b>Report</b>",
      parse_mode: "HTML",
    });
    expect(result).toEqual({
      ok: true,
      channel: "telegram",
      target: {
        source: "telegram",
        connectorKey: "main",
        externalConversationId: "777",
      },
      sent: [
        {type: "text", externalMessageId: "101"},
        {type: "image", externalMessageId: "102"},
        {type: "file", externalMessageId: "103"},
      ],
    });
  });

  it("falls back to plain text when Telegram rejects formatted entities", async () => {
    const api = createApiMock();
    vi.mocked(api.sendMessage)
      .mockRejectedValueOnce(new Error("400: Bad Request: can't parse entities"))
      .mockResolvedValueOnce({message_id: 104});

    const adapter = createTelegramOutboundAdapter({
      api,
      connectorKey: "main",
    });

    await adapter.send({
      channel: "telegram",
      target: {
        source: "telegram",
        connectorKey: "main",
        externalConversationId: "777",
      },
      items: [
        {type: "text", text: "**still send it**"},
      ],
    });

    expect(api.sendMessage).toHaveBeenNthCalledWith(1, "777", "<b>still send it</b>", {
      parse_mode: "HTML",
    });
    expect(api.sendMessage).toHaveBeenNthCalledWith(2, "777", "**still send it**", {});
  });
});
