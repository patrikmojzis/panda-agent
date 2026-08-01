import {describe, expect, it, vi} from "vitest";

import type {WriteMediaInput} from "../src/domain/channels/media-store.js";
import {
  DISCORD_ATTACHMENT_DOWNLOAD_LIMIT_BYTES,
  downloadDiscordSupportedAttachments,
  downloadDiscordSupportedEmbeds,
  downloadDiscordSupportedStickers,
} from "../src/integrations/channels/discord/media.js";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x01]);

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
    const fetchImpl = vi.fn(async () => new Response(PNG_BYTES, {
      status: 200,
      headers: {"content-length": String(PNG_BYTES.byteLength), "content-type": "image/png"},
    }));

    const result = await downloadDiscordSupportedAttachments([{
      id: "attachment-1",
      filename: "../../private.png",
      content_type: "image/png",
      size: PNG_BYTES.byteLength,
      url: cdnUrl,
      proxy_url: proxyUrl,
    }], {
      connectorKey: "bot-1",
      mediaStore,
      fetchImpl,
    });

    expect(result.media).toHaveLength(1);
    expect(result.unavailable).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledWith(proxyUrl, expect.objectContaining({
      redirect: "error",
      signal: expect.any(AbortSignal),
    }));
    expect(mediaStore.writeMedia).toHaveBeenCalledWith(expect.objectContaining({
      source: "discord",
      connectorKey: "bot-1",
      mimeType: "image/png",
      sizeBytes: PNG_BYTES.byteLength,
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
    const fetchImpl = vi.fn(async () => new Response(JPEG_BYTES, {
      status: 200,
      headers: {"content-length": String(JPEG_BYTES.byteLength), "content-type": "image/jpeg; charset=binary"},
    }));

    const result = await downloadDiscordSupportedAttachments([{
      id: "attachment-1",
      filename: "photo.jpg",
      contentType: "image/jpeg",
      sizeBytes: 999,
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
      sizeBytes: JPEG_BYTES.byteLength,
      hintFilename: "photo.jpg",
      metadata: {
        discordAttachmentId: "attachment-1",
      },
    }));
    expect(JSON.stringify(mediaStore.writeMedia.mock.calls[0]?.[0])).not.toContain(proxyUrl);
    expect(JSON.stringify(result)).not.toContain(proxyUrl);
  });

  it("falls back from a failed proxy to the trusted CDN URL", async () => {
    const mediaStore = createMediaStore();
    const proxyUrl = "https://media.discordapp.net/attachments/channel/attachment/photo.jpeg?proxy=secret";
    const cdnUrl = "https://cdn.discordapp.com/attachments/channel/attachment/photo.jpeg?cdn=secret";
    const fetchImpl = vi.fn(async (url: string) => url === proxyUrl
      ? new Response("forbidden", {status: 403})
      : new Response(JPEG_BYTES, {
        status: 200,
        headers: {"content-type": "image/jpeg", "content-length": String(JPEG_BYTES.byteLength)},
      }));

    const result = await downloadDiscordSupportedAttachments([{
      id: "attachment-1",
      filename: "photo.jpeg",
      content_type: "image/jpeg",
      size: 999,
      proxy_url: proxyUrl,
      url: cdnUrl,
    }], {connectorKey: "bot-1", mediaStore, fetchImpl});

    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([proxyUrl, cdnUrl]);
    expect(result.media).toHaveLength(1);
    expect(result.summaries).toEqual([expect.objectContaining({
      id: "attachment-1",
      sizeBytes: 999,
      status: "downloaded",
    })]);
    expect(mediaStore.writeMedia).toHaveBeenCalledWith(expect.objectContaining({
      mimeType: "image/jpeg",
      sizeBytes: JPEG_BYTES.byteLength,
    }));
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("accepts octet-stream JPEG bytes only when the signature matches", async () => {
    const mediaStore = createMediaStore();
    const fetchImpl = vi.fn(async () => new Response(JPEG_BYTES, {
      status: 200,
      headers: {"content-type": "application/octet-stream"},
    }));

    const result = await downloadDiscordSupportedAttachments([{
      id: "attachment-1",
      filename: "photo.jpeg",
      content_type: "image/jpeg",
      url: "https://cdn.discordapp.com/attachments/channel/attachment/photo.jpeg",
    }], {connectorKey: "bot-1", mediaStore, fetchImpl});

    expect(result.summaries).toEqual([expect.objectContaining({status: "downloaded"})]);
    expect(mediaStore.writeMedia).toHaveBeenCalledWith(expect.objectContaining({mimeType: "image/jpeg"}));
  });

  it.each([
    ["HTML content type", "text/html", JPEG_BYTES, "invalid_content_type"],
    ["HTML bytes", "image/jpeg", Buffer.from("<html>not an image</html>"), "invalid_signature"],
    ["wrong image signature", "image/png", JPEG_BYTES, "invalid_signature"],
  ])("rejects %s without leaking its signed URL", async (_label, contentType, bytes, reason) => {
    const mediaStore = createMediaStore();
    const privateUrl = "https://cdn.discordapp.com/attachments/channel/attachment/private.jpeg?token=secret";
    const result = await downloadDiscordSupportedAttachments([{
      id: "attachment-1",
      filename: "private.jpeg",
      content_type: "image/jpeg",
      url: privateUrl,
    }], {
      connectorKey: "bot-1",
      mediaStore,
      fetchImpl: vi.fn(async () => new Response(bytes, {headers: {"content-type": contentType}})),
    });

    expect(result.unavailable).toEqual([expect.objectContaining({reason, status: "unsupported"})]);
    expect(mediaStore.writeMedia).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(privateUrl);
    expect(JSON.stringify(result)).not.toContain("token=secret");
  });

  it("keeps one deadline active while reading the response body", async () => {
    const mediaStore = createMediaStore();
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => new Response(new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")), {once: true});
      },
    }), {headers: {"content-type": "image/jpeg"}}));

    const result = await downloadDiscordSupportedAttachments([{
      id: "attachment-1",
      filename: "slow.jpeg",
      content_type: "image/jpeg",
      url: "https://cdn.discordapp.com/attachments/channel/attachment/slow.jpeg",
    }], {connectorKey: "bot-1", mediaStore, fetchImpl, timeoutMs: 5});

    expect(result.unavailable).toEqual([expect.objectContaining({reason: "timeout", status: "failed"})]);
    expect(mediaStore.writeMedia).not.toHaveBeenCalled();
  });

  it("keeps three JPEG attachments from one message in input order", async () => {
    const mediaStore = createMediaStore();
    const attachments = ["one.jpeg", "two.jpeg", "three.jpeg"].map((filename, index) => ({
      id: `attachment-${String(index + 1)}`,
      filename,
      content_type: "image/jpeg",
      size: 100 + index,
      proxy_url: `https://media.discordapp.net/attachments/channel/${String(index + 1)}/${filename}?secret=${String(index)}`,
    }));
    const result = await downloadDiscordSupportedAttachments(attachments, {
      connectorKey: "bot-1",
      mediaStore,
      fetchImpl: vi.fn(async () => new Response(JPEG_BYTES, {headers: {"content-type": "image/jpeg"}})),
    });

    expect(result.media).toHaveLength(3);
    expect(result.summaries.map((summary) => [summary.id, summary.status])).toEqual([
      ["attachment-1", "downloaded"],
      ["attachment-2", "downloaded"],
      ["attachment-3", "downloaded"],
    ]);
    expect(mediaStore.writeMedia.mock.calls.map(([input]) => input.hintFilename)).toEqual([
      "one.jpeg",
      "two.jpeg",
      "three.jpeg",
    ]);
    expect(JSON.stringify(result)).not.toContain("secret=");
  });

  it("reports storage failures without trying a second download candidate", async () => {
    const mediaStore = createMediaStore();
    mediaStore.writeMedia.mockRejectedValueOnce(new Error("private storage path"));
    const fetchImpl = vi.fn(async () => new Response(JPEG_BYTES, {headers: {"content-type": "image/jpeg"}}));
    const result = await downloadDiscordSupportedAttachments([{
      id: "attachment-1",
      filename: "photo.jpeg",
      content_type: "image/jpeg",
      proxy_url: "https://media.discordapp.net/attachments/channel/attachment/photo.jpeg?proxy=secret",
      url: "https://cdn.discordapp.com/attachments/channel/attachment/photo.jpeg?cdn=secret",
    }], {connectorKey: "bot-1", mediaStore, fetchImpl});

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(result.unavailable).toEqual([expect.objectContaining({
      reason: "storage_failed",
      status: "failed",
      attempts: [{candidate: "proxy", reason: "storage_failed"}],
    })]);
    expect(JSON.stringify(result)).not.toContain("private storage path");
    expect(JSON.stringify(result)).not.toContain("secret");
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
      reason: "untrusted_url",
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
      status: "metadata_only",
      reason: "no_trusted_media",
      attempts: [],
    }]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(mediaStore.writeMedia).not.toHaveBeenCalled();
    expect(onUnavailable).toHaveBeenCalledWith(expect.objectContaining({
      id: "attachment-1",
      reason: "no_trusted_media",
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
      reason: "too_large",
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

      return new Response(PNG_BYTES, {
        status: 200,
        headers: {"content-length": String(PNG_BYTES.byteLength), "content-type": "image/png"},
      });
    });

    const result = await downloadDiscordSupportedAttachments([
      {
        id: "attachment-ok",
        filename: "ok.png",
        content_type: "image/png",
        size: PNG_BYTES.byteLength,
        url: "https://cdn.discordapp.com/attachments/channel/attachment/ok.png",
      },
      {
        id: "attachment-missing",
        filename: "missing.png",
        content_type: "image/png",
        size: PNG_BYTES.byteLength,
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
      reason: "http_error",
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
      reason: "download_failed",
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
