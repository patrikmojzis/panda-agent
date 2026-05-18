import type {WAMessage} from "baileys";
import {describe, expect, it} from "vitest";

import {collectWhatsAppMediaParts} from "../src/integrations/channels/whatsapp/media.js";

function waMessage(message: NonNullable<WAMessage["message"]>): WAMessage {
  return {
    key: {
      id: "wamid-1",
      remoteJid: "421900000000@s.whatsapp.net",
      fromMe: false,
    },
    message,
  } as WAMessage;
}

describe("whatsapp media", () => {
  it("collects supported media parts with MIME defaults and metadata", () => {
    expect(collectWhatsAppMediaParts(waMessage({
      imageMessage: {
        fileLength: 128,
      },
      videoMessage: {
        fileLength: 1024,
      },
      documentMessage: {
        fileName: "report.pdf",
        mimetype: "application/pdf",
        fileLength: {
          toNumber: () => 2048,
        },
      },
      stickerMessage: {
        fileLength: 256,
        isAnimated: true,
      },
      audioMessage: {
        mimetype: "audio/opus",
        fileLength: 456,
        ptt: false,
      },
    }))).toEqual([
      {
        mimeType: "image/jpeg",
        sizeBytes: 128,
      },
      {
        mimeType: "video/mp4",
        sizeBytes: 1024,
        metadata: {
          whatsappMediaKind: "video",
        },
      },
      {
        mimeType: "application/pdf",
        sizeBytes: 2048,
        hintFilename: "report.pdf",
      },
      {
        mimeType: "image/webp",
        sizeBytes: 256,
        metadata: {
          whatsappMediaKind: "sticker",
          isAnimated: true,
        },
      },
      {
        mimeType: "audio/opus",
        sizeBytes: 456,
        metadata: {
          whatsappMediaKind: "audio",
          ptt: false,
        },
      },
    ]);
  });

  it("returns no media parts for text-only messages", () => {
    expect(collectWhatsAppMediaParts(waMessage({
      conversation: "hello",
    }))).toEqual([]);
  });
});
