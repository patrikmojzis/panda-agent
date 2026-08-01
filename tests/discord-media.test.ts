import {describe, expect, it, vi} from "vitest";

import type {WriteMediaInput} from "../src/domain/channels/media-store.js";
import {
  DISCORD_ATTACHMENT_DOWNLOAD_LIMIT_BYTES,
  downloadDiscordSupportedAttachments,
  downloadDiscordSupportedEmbeds,
  downloadDiscordSupportedStickers,
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

  it("downloads proxy-only Discord attachments with normalized metadata aliases", async () => {
    const mediaStore = createMediaStore();
    const proxyUrl = "https://media.discordapp.net/attachments/channel/attachment/photo.jpg?ex=secret";
    const fetchImpl = vi.fn(async () => new Response(Buffer.from("photo"), {
      status: 200,
      headers: {"content-length": "5"},
    }));

    const result = await downloadDiscordSupportedAttachments([{
      id: "attachment-1",
      filename: "photo.jpg",
      contentType: "image/jpeg",
      sizeBytes: 5,
      proxy_url: proxyUrl,
    }], {
      connectorKey: "bot-1",
      mediaStore,
      fetchImpl,
    });

    expect(result.media).toHaveLength(1);
    expect(result.unavailable).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledWith(proxyUrl, expect.objectContaining({
      signal: expect.any(AbortSignal),
    }));
    expect(mediaStore.writeMedia).toHaveBeenCalledWith(expect.objectContaining({
      source: "discord",
      connectorKey: "bot-1",
      mimeType: "image/jpeg",
      sizeBytes: 5,
      hintFilename: "photo.jpg",
      metadata: {
        discordAttachmentId: "attachment-1",
      },
    }));
    expect(JSON.stringify(mediaStore.writeMedia.mock.calls[0]?.[0])).not.toContain(proxyUrl);
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

  it("reports metadata-only attachments without a downloadable CDN URL", async () => {
    const mediaStore = createMediaStore();
    const fetchImpl = vi.fn();
    const onUnavailable = vi.fn();

    const result = await downloadDiscordSupportedAttachments([{
      id: "attachment-1",
      filename: "photo.jpg",
      content_type: "image/jpeg",
      size: 5,
    }], {
      connectorKey: "bot-1",
      mediaStore,
      fetchImpl,
      onUnavailable,
    });

    expect(result.media).toEqual([]);
    expect(result.unavailable).toEqual([{
      id: "attachment-1",
      filename: "photo.jpg",
      contentType: "image/jpeg",
      sizeBytes: 5,
      reason: "Discord attachment does not include a downloadable CDN URL.",
    }]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(mediaStore.writeMedia).not.toHaveBeenCalled();
    expect(onUnavailable).toHaveBeenCalledWith(expect.objectContaining({
      id: "attachment-1",
      reason: "Discord attachment does not include a downloadable CDN URL.",
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

describe("Discord inbound embed and sticker media", () => {
  it("downloads one trusted Discord-proxied GIF embed without persisting source URLs", async () => {
    const mediaStore = createMediaStore();
    const privateUrl = "https://klipy.example/private-page";
    const proxyUrl = "https://media.discordapp.net/external/private-preview.gif";
    const fetchImpl = vi.fn(async () => new Response(Buffer.from("GIF89a"), {
      headers: {"content-type": "image/gif", "content-length": "6"},
    }));

    const result = await downloadDiscordSupportedEmbeds([{
      type: "gifv",
      title: "Reaction",
      provider: {name: "Klipy", url: privateUrl},
      video: {
        url: privateUrl,
        proxy_url: proxyUrl,
        content_type: "image/gif",
        width: 320,
        height: 240,
      },
    }], {connectorKey: "bot-1", mediaStore, fetchImpl});

    expect(result.summaries).toEqual([{
      type: "gifv",
      title: "Reaction",
      providerName: "Klipy",
      media: [{
        kind: "video",
        contentType: "image/gif",
        width: 320,
        height: 240,
        status: "downloaded",
      }],
    }]);
    expect(result.media).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledWith(proxyUrl, expect.objectContaining({
      redirect: "error",
      signal: expect.any(AbortSignal),
    }));
    expect(mediaStore.writeMedia).toHaveBeenCalledWith(expect.objectContaining({
      mimeType: "image/gif",
      metadata: {
        discordMediaKind: "embed",
        discordEmbedIndex: 0,
        discordEmbedType: "gifv",
      },
    }));
    expect(JSON.stringify(result)).not.toContain(privateUrl);
    expect(JSON.stringify(result)).not.toContain(proxyUrl);
  });

  it("keeps untrusted embed media as explicit metadata without fetching it", async () => {
    const mediaStore = createMediaStore();
    const fetchImpl = vi.fn();
    const result = await downloadDiscordSupportedEmbeds([{
      type: "image",
      image: {url: "https://example.invalid/private.gif", content_type: "image/gif"},
    }], {connectorKey: "bot-1", mediaStore, fetchImpl});

    expect(result).toEqual({
      media: [],
      summaries: [{
        type: "image",
        media: [{
          kind: "image",
          contentType: "image/gif",
          status: "metadata_only",
          reason: "untrusted_url",
        }],
      }],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("redacts Discord media URLs from embed text and skips empty visual candidates", async () => {
    const mediaStore = createMediaStore();
    const proxyUrl = "https://media.discordapp.net/external/safe.gif";
    const result = await downloadDiscordSupportedEmbeds([{
      type: "gifv",
      title: "Preview https://cdn.discordapp.com/attachments/private.gif?token=secret",
      video: {width: 320},
      image: {proxy_url: proxyUrl, content_type: "image/gif"},
    }], {
      connectorKey: "bot-1",
      mediaStore,
      fetchImpl: vi.fn(async () => new Response("GIF89a", {headers: {"content-type": "image/gif"}})),
    });

    expect(result.summaries[0]).toMatchObject({
      title: "Preview [discord-media]",
      media: [{kind: "image", status: "downloaded"}],
    });
    expect(JSON.stringify(result.summaries)).not.toContain("discordapp.com");
  });

  it("downloads PNG and GIF stickers while keeping Lottie metadata-only", async () => {
    const mediaStore = createMediaStore();
    const fetchImpl = vi.fn(async (url: string) => new Response(
      Buffer.from(url.endsWith(".gif") ? "GIF89a" : "png"),
      {headers: {"content-type": url.endsWith(".gif") ? "image/gif" : "image/png"}},
    ));
    const result = await downloadDiscordSupportedStickers([
      {id: "1", name: "Static", format_type: 1},
      {id: "2", name: "Animated", format_type: 4},
      {id: "3", name: "Lottie", format_type: 3},
    ], {connectorKey: "bot-1", mediaStore, fetchImpl});

    expect(result.media).toHaveLength(2);
    expect(result.summaries).toEqual([
      {id: "1", name: "Static", format: "png", status: "downloaded"},
      {id: "2", name: "Animated", format: "gif", status: "downloaded"},
      {id: "3", name: "Lottie", format: "lottie", status: "unsupported", reason: "unsupported_format"},
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("marks Discord media with invalid response MIME as unsupported", async () => {
    const mediaStore = createMediaStore();
    const result = await downloadDiscordSupportedEmbeds([{
      type: "gifv",
      video: {proxy_url: "https://media.discordapp.net/external/not-media", content_type: "image/gif"},
    }], {
      connectorKey: "bot-1",
      mediaStore,
      fetchImpl: vi.fn(async () => new Response("<html>", {headers: {"content-type": "text/html"}})),
    });

    expect(result.media).toEqual([]);
    expect(result.summaries[0]?.media[0]).toMatchObject({
      status: "unsupported",
      reason: "invalid_content_type",
    });
    expect(mediaStore.writeMedia).not.toHaveBeenCalled();
  });
});
