import {describe, expect, it, vi} from "vitest";

import type {WriteMediaInput} from "../src/domain/channels/media-store.js";
import {
  DISCORD_ATTACHMENT_DOWNLOAD_LIMIT_BYTES,
  downloadDiscordSupportedAttachments,
} from "../src/integrations/channels/discord/media.js";

function createMediaStore() {
  return {
    writeMedia: vi.fn(async (input: WriteMediaInput) => ({
      id: "media-1",
      source: input.source,
      connectorKey: input.connectorKey,
      mimeType: input.mimeType,
      sizeBytes: input.bytes.byteLength,
      localPath: "/tmp/discord-media.png",
      originalFilename: input.hintFilename,
      metadata: input.metadata,
      createdAt: 1,
    })),
  };
}

describe("Discord inbound attachment downloads", () => {
  it("downloads allowed Discord CDN attachments into the media store without persisting CDN URLs", async () => {
    const mediaStore = createMediaStore();
    const cdnUrl = "https://cdn.discordapp.com/attachments/channel/attachment/private.png?ex=secret";
    const proxyUrl = "https://media.discordapp.net/attachments/channel/attachment/proxy.png?ex=secret";
    const fetchImpl = vi.fn(async () => new Response(Buffer.from("image"), {
      status: 200,
      headers: {"content-length": "5"},
    }));

    const result = await downloadDiscordSupportedAttachments([{
      id: "attachment-1",
      filename: "../../private.png",
      content_type: "image/png",
      size: 5,
      url: cdnUrl,
      proxy_url: proxyUrl,
    }], {
      connectorKey: "bot-1",
      mediaStore,
      fetchImpl,
    });

    expect(result.media).toHaveLength(1);
    expect(result.unavailable).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledWith(cdnUrl, expect.objectContaining({
      signal: expect.any(AbortSignal),
    }));
    expect(mediaStore.writeMedia).toHaveBeenCalledWith(expect.objectContaining({
      source: "discord",
      connectorKey: "bot-1",
      mimeType: "image/png",
      sizeBytes: 5,
      hintFilename: "../../private.png",
      metadata: {
        discordAttachmentId: "attachment-1",
      },
    }));
    expect(JSON.stringify(mediaStore.writeMedia.mock.calls[0]?.[0])).not.toContain(cdnUrl);
    expect(JSON.stringify(mediaStore.writeMedia.mock.calls[0]?.[0])).not.toContain(proxyUrl);
    expect(JSON.stringify(result)).not.toContain(cdnUrl);
    expect(JSON.stringify(result)).not.toContain(proxyUrl);
  });

  it("skips non-Discord attachment URLs before fetch", async () => {
    const mediaStore = createMediaStore();
    const fetchImpl = vi.fn();
    const onUnavailable = vi.fn();

    const result = await downloadDiscordSupportedAttachments([{
      id: "attachment-1",
      filename: "report.pdf",
      content_type: "application/pdf",
      size: 10,
      url: "https://example.invalid/private/report.pdf",
    }], {
      connectorKey: "bot-1",
      mediaStore,
      fetchImpl,
      onUnavailable,
    });

    expect(result.media).toEqual([]);
    expect(result.unavailable).toEqual([expect.objectContaining({
      id: "attachment-1",
      reason: "Discord attachment URL is not a supported CDN URL.",
    })]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(mediaStore.writeMedia).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("example.invalid");
    expect(onUnavailable).toHaveBeenCalledWith(expect.objectContaining({
      id: "attachment-1",
    }));
  });

  it("skips declared oversized attachments without fetching", async () => {
    const mediaStore = createMediaStore();
    const fetchImpl = vi.fn();

    const result = await downloadDiscordSupportedAttachments([{
      id: "attachment-1",
      content_type: "application/zip",
      size: DISCORD_ATTACHMENT_DOWNLOAD_LIMIT_BYTES + 1,
      url: "https://cdn.discordapp.com/attachments/channel/attachment/archive.zip",
    }], {
      connectorKey: "bot-1",
      mediaStore,
      fetchImpl,
    });

    expect(result.media).toEqual([]);
    expect(result.unavailable).toEqual([expect.objectContaining({
      id: "attachment-1",
      reason: "Discord attachment exceeds the 25 MB download limit.",
    })]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(mediaStore.writeMedia).not.toHaveBeenCalled();
  });

  it("preserves partial success when one attachment download fails", async () => {
    const mediaStore = createMediaStore();
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("missing")) {
        return new Response("missing", {status: 404});
      }

      return new Response(Buffer.from("ok"), {
        status: 200,
        headers: {"content-length": "2"},
      });
    });

    const result = await downloadDiscordSupportedAttachments([
      {
        id: "attachment-ok",
        filename: "ok.png",
        content_type: "image/png",
        size: 2,
        url: "https://cdn.discordapp.com/attachments/channel/attachment/ok.png",
      },
      {
        id: "attachment-missing",
        filename: "missing.png",
        content_type: "image/png",
        size: 2,
        url: "https://cdn.discordapp.com/attachments/channel/attachment/missing.png",
      },
    ], {
      connectorKey: "bot-1",
      mediaStore,
      fetchImpl,
    });

    expect(result.media).toHaveLength(1);
    expect(result.media[0]).toMatchObject({
      id: "media-1",
      originalFilename: "ok.png",
    });
    expect(result.unavailable).toEqual([expect.objectContaining({
      id: "attachment-missing",
      reason: "Discord attachment download failed.",
    })]);
    expect(mediaStore.writeMedia).toHaveBeenCalledOnce();
  });

  it("treats fetch failures as unavailable without exposing the failing URL in the reason", async () => {
    const mediaStore = createMediaStore();
    const privateUrl = "https://media.discordapp.net/attachments/channel/attachment/private.png?secret=1";
    const fetchImpl = vi.fn(async () => {
      throw new Error(`network failed for ${privateUrl}`);
    });

    const result = await downloadDiscordSupportedAttachments([{
      id: "attachment-1",
      content_type: "image/png",
      size: 5,
      url: privateUrl,
    }], {
      connectorKey: "bot-1",
      mediaStore,
      fetchImpl,
    });

    expect(result.media).toEqual([]);
    expect(result.unavailable).toEqual([expect.objectContaining({
      id: "attachment-1",
      reason: "Discord attachment download failed.",
    })]);
    expect(JSON.stringify(result)).not.toContain(privateUrl);
    expect(mediaStore.writeMedia).not.toHaveBeenCalled();
  });
});
