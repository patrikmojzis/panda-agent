import {Readable} from "node:stream";

import type {WAMessage} from "baileys";
import {describe, expect, it, vi} from "vitest";

import {
  collectWhatsAppMediaParts,
  downloadWhatsAppSupportedMedia,
} from "../src/integrations/channels/whatsapp/media.js";

const mocks = vi.hoisted(() => ({
  downloadMediaMessage: vi.fn(),
}));

vi.mock("baileys/lib/Utils/messages.js", () => ({
  downloadMediaMessage: mocks.downloadMediaMessage,
  normalizeMessageContent: (message: unknown) => message ?? undefined,
}));

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

  it("rejects declared oversize media before opening a network stream", async () => {
    const mediaStore = {writeMediaFile: vi.fn()};
    await expect(downloadWhatsAppSupportedMedia(waMessage({imageMessage: {fileLength: 6}}), {
      connectorKey: "main",
      mediaStore,
      reuploadRequest: vi.fn(),
      maxBytes: 5,
      timeoutMs: 1_000,
    })).rejects.toMatchObject({reason: "media_too_large"});

    expect(mocks.downloadMediaMessage).not.toHaveBeenCalled();
    expect(mediaStore.writeMediaFile).not.toHaveBeenCalled();
  });

  it("streams exact-limit media to disk without buffering it in the adapter", async () => {
    mocks.downloadMediaMessage.mockResolvedValueOnce(Readable.from([Buffer.from("me"), Buffer.from("dia")]));
    const mediaStore = {
      writeMediaFile: vi.fn(async (input) => ({
        id: "media-1",
        source: input.source,
        connectorKey: input.connectorKey,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        localPath: "/media/file",
        createdAt: input.createdAt,
      })),
    };

    await expect(downloadWhatsAppSupportedMedia(waMessage({imageMessage: {fileLength: 5}}), {
      connectorKey: "main",
      mediaStore,
      reuploadRequest: vi.fn(),
      maxBytes: 5,
      timeoutMs: 1_000,
    })).resolves.toEqual([expect.objectContaining({sizeBytes: 5})]);

    expect(mocks.downloadMediaMessage).toHaveBeenCalledWith(
      expect.anything(),
      "stream",
      expect.objectContaining({options: expect.objectContaining({signal: expect.any(AbortSignal)})}),
      expect.anything(),
    );
  });

  it("stops an underreported stream at the actual byte limit", async () => {
    mocks.downloadMediaMessage.mockResolvedValueOnce(Readable.from([Buffer.from("123456")]));
    const mediaStore = {writeMediaFile: vi.fn()};

    await expect(downloadWhatsAppSupportedMedia(waMessage({imageMessage: {}}), {
      connectorKey: "main",
      mediaStore,
      reuploadRequest: vi.fn(),
      maxBytes: 5,
      timeoutMs: 1_000,
    })).rejects.toMatchObject({reason: "media_too_large"});
    expect(mediaStore.writeMediaFile).not.toHaveBeenCalled();
  });

  it("aborts a stalled media stream at the configured deadline", async () => {
    const stalled = new Readable({read() {}});
    mocks.downloadMediaMessage.mockResolvedValueOnce(stalled);

    await expect(downloadWhatsAppSupportedMedia(waMessage({imageMessage: {}}), {
      connectorKey: "main",
      mediaStore: {writeMediaFile: vi.fn()},
      reuploadRequest: vi.fn(),
      maxBytes: 5,
      timeoutMs: 5,
    })).rejects.toMatchObject({reason: "media_timeout"});
    expect(stalled.destroyed).toBe(true);
  });
});
