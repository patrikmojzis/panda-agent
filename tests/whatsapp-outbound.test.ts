import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import type { WASocket } from "baileys";
import { describe, expect, it, vi } from "vitest";

import { createWhatsAppOutboundAdapter } from "../src/index.js";

function mockSocket(sendMessage: ReturnType<typeof vi.fn>): WASocket {
  return {
    sendMessage,
  } as unknown as WASocket;
}

describe("createWhatsAppOutboundAdapter", () => {
  it("sends text, image, and file items through the live socket", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "panda-whatsapp-outbound-"));
    const imagePath = path.join(tempDir, "photo.jpg");
    const filePath = path.join(tempDir, "report.pdf");
    await writeFile(imagePath, "image-bytes");
    await writeFile(filePath, "file-bytes");

    const sendMessage = vi.fn()
      .mockResolvedValueOnce({ key: { id: "msg-text" } })
      .mockResolvedValueOnce({ key: { id: "msg-image" } })
      .mockResolvedValueOnce({ key: { id: "msg-file" } });
    const adapter = createWhatsAppOutboundAdapter({
      connectorKey: "main",
      getSocket: () => mockSocket(sendMessage),
    });

    const result = await adapter.send({
      channel: "whatsapp",
      target: {
        source: "whatsapp",
        connectorKey: "main",
        externalConversationId: "421911111111@s.whatsapp.net",
      },
      items: [
        { type: "text", text: "hello" },
        { type: "image", path: imagePath, caption: "photo" },
        { type: "file", path: filePath, filename: "report.pdf", mimeType: "application/pdf", caption: "report" },
      ],
    });

    expect(sendMessage).toHaveBeenNthCalledWith(1, "421911111111@s.whatsapp.net", {
      text: "hello",
    });
    expect(sendMessage).toHaveBeenNthCalledWith(2, "421911111111@s.whatsapp.net", {
      image: expect.any(Buffer),
      caption: "photo",
    });
    expect(sendMessage).toHaveBeenNthCalledWith(3, "421911111111@s.whatsapp.net", {
      document: expect.any(Buffer),
      fileName: "report.pdf",
      mimetype: "application/pdf",
      caption: "report",
    });
    expect(result).toEqual({
      ok: true,
      channel: "whatsapp",
      target: {
        source: "whatsapp",
        connectorKey: "main",
        externalConversationId: "421911111111@s.whatsapp.net",
      },
      sent: [
        { type: "text", externalMessageId: "msg-text" },
        { type: "image", externalMessageId: "msg-image" },
        { type: "file", externalMessageId: "msg-file" },
      ],
    });
  });

  it("fails when the live socket is unavailable", async () => {
    const adapter = createWhatsAppOutboundAdapter({
      connectorKey: "main",
      getSocket: () => null,
    });

    await expect(adapter.send({
      channel: "whatsapp",
      target: {
        source: "whatsapp",
        connectorKey: "main",
        externalConversationId: "421911111111@s.whatsapp.net",
      },
      items: [{ type: "text", text: "hello" }],
    })).rejects.toThrow("WhatsApp outbound is unavailable because the connector socket is not connected.");
  });
});
