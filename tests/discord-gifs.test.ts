import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {afterEach, describe, expect, it, vi} from "vitest";

import type {CommandRequest} from "../src/domain/commands/types.js";
import {
  createDiscordGifSendCommand,
  DISCORD_GIF_SEND_COMMAND_NAME,
} from "../src/integrations/channels/discord/commands.js";
import {
  createDiscordGifService,
  DISCORD_GIF_MAX_BYTES,
  DISCORD_GIF_MAX_REDIRECTS,
  DISCORD_GIF_TIMEOUT_MS,
} from "../src/integrations/channels/discord/gifs.js";

const tempDirs: string[] = [];
const gifBytes = Buffer.concat([Buffer.from("GIF89a", "ascii"), Buffer.from([1, 2, 3])]);

function request(input: CommandRequest["input"]): CommandRequest {
  return {
    command: DISCORD_GIF_SEND_COMMAND_NAME,
    input,
    scope: {
      agentKey: "panda",
      sessionId: "session-1",
      threadId: "thread-1",
      allowedCommands: [DISCORD_GIF_SEND_COMMAND_NAME],
    },
  };
}

function binding() {
  return {
    source: "discord",
    connectorKey: "discord-main",
    externalConversationId: "12345",
    sessionId: "session-1",
    createdAt: 1,
    updatedAt: 1,
  } as const;
}

function safeFetchResult(overrides: Record<string, unknown> = {}) {
  return {
    url: "https://cdn.example/reaction.gif",
    finalUrl: "https://cdn.example/reaction.gif",
    status: 200,
    statusText: "OK",
    contentType: "image/gif",
    headers: new Headers({"content-type": "image/gif"}),
    bodyBytes: new Uint8Array(gifBytes),
    bodyText: "",
    downloadedBytes: gifBytes.byteLength,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, {recursive: true, force: true})));
});

describe("Discord GIF source validation", () => {
  it("accepts local GIF87a/GIF89a files and rejects bad signatures", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-discord-gif-"));
    tempDirs.push(dir);
    const valid = path.join(dir, "valid.gif");
    const invalid = path.join(dir, "invalid.gif");
    await fs.writeFile(valid, gifBytes);
    await fs.writeFile(invalid, Buffer.from("<html>not a gif</html>"));
    const service = createDiscordGifService();

    await expect(service.validateLocalFile(valid)).resolves.toEqual({
      path: valid,
      filename: "valid.gif",
      sizeBytes: gifBytes.byteLength,
    });
    await expect(service.validateLocalFile(invalid)).rejects.toThrow("valid GIF87a or GIF89a signature");
  });

  it("rejects local GIFs over 10 MiB", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-discord-gif-large-"));
    tempDirs.push(dir);
    const file = path.join(dir, "large.gif");
    await fs.writeFile(file, gifBytes);
    await fs.truncate(file, DISCORD_GIF_MAX_BYTES + 1);

    await expect(createDiscordGifService().validateLocalFile(file)).rejects.toThrow("byte limit");
  });

  it("downloads a direct HTTPS GIF with the hardened limits and never stores its URL", async () => {
    const fetchResource = vi.fn(async () => safeFetchResult());
    const writeMedia = vi.fn(async (input) => ({
      id: "media-1",
      source: input.source,
      connectorKey: input.connectorKey,
      mimeType: input.mimeType,
      sizeBytes: input.bytes.byteLength,
      localPath: "/agent/media/discord-remote.gif",
      originalFilename: input.hintFilename,
      metadata: input.metadata,
      createdAt: 1,
    }));
    const service = createDiscordGifService({
      env: {DATA_DIR: "/agent"},
      fetchResource,
      createMediaStore: () => ({writeMedia}),
    });

    await expect(service.downloadRemoteGif({
      agentKey: "panda",
      connectorKey: "discord-main",
      url: "https://cdn.example/reaction.gif?secret=1",
    })).resolves.toEqual({
      path: "/agent/media/discord-remote.gif",
      filename: "discord-remote.gif",
      sizeBytes: gifBytes.byteLength,
    });
    expect(fetchResource).toHaveBeenCalledWith("https://cdn.example/reaction.gif?secret=1", expect.objectContaining({
      allowedProtocols: ["https:"],
      timeoutMs: DISCORD_GIF_TIMEOUT_MS,
      maxRedirects: DISCORD_GIF_MAX_REDIRECTS,
      maxResponseBytes: DISCORD_GIF_MAX_BYTES,
    }));
    expect(JSON.stringify(writeMedia.mock.calls[0]?.[0])).not.toContain("cdn.example");
    expect(writeMedia).toHaveBeenCalledWith(expect.objectContaining({
      mimeType: "image/gif",
      metadata: {kind: "discord_gif"},
    }));
  });

  it("blocks private targets, redirects to private targets, and HTTPS downgrades", async () => {
    const directFetch = vi.fn();
    const directPrivate = createDiscordGifService({
      fetchOptions: {
        lookupHostname: async () => ["127.0.0.1"],
        fetchImpl: directFetch,
      },
    });
    await expect(directPrivate.downloadRemoteGif({
      agentKey: "panda",
      connectorKey: "discord-main",
      url: "https://private.example/reaction.gif",
    })).rejects.toThrow("blocked a private address");
    expect(directFetch).not.toHaveBeenCalled();

    const redirectPrivateFetch = vi.fn(async () => new Response(null, {
      status: 302,
      headers: {Location: "https://private.example/reaction.gif"},
    }));
    const redirectPrivate = createDiscordGifService({
      fetchOptions: {
        lookupHostname: async (hostname) => hostname === "private.example" ? ["127.0.0.1"] : ["93.184.216.34"],
        fetchImpl: redirectPrivateFetch,
      },
    });
    await expect(redirectPrivate.downloadRemoteGif({
      agentKey: "panda",
      connectorKey: "discord-main",
      url: "https://public.example/reaction.gif",
    })).rejects.toThrow("blocked a private address");
    expect(redirectPrivateFetch).toHaveBeenCalledOnce();

    const downgradeFetch = vi.fn(async () => new Response(null, {
      status: 302,
      headers: {Location: "http://public.example/reaction.gif"},
    }));
    const downgrade = createDiscordGifService({
      fetchOptions: {
        lookupHostname: async () => ["93.184.216.34"],
        fetchImpl: downgradeFetch,
      },
    });
    await expect(downgrade.downloadRemoteGif({
      agentKey: "panda",
      connectorKey: "discord-main",
      url: "https://public.example/reaction.gif",
    })).rejects.toThrow("only supports https:// URLs");
    expect(downgradeFetch).toHaveBeenCalledOnce();
  });

  it("rejects HTML masquerading as GIF, bad signatures, oversize results, and non-HTTPS URLs", async () => {
    const cases = [
      safeFetchResult({contentType: "text/html"}),
      safeFetchResult({bodyBytes: new Uint8Array(Buffer.from("not-gif")), downloadedBytes: 7}),
      safeFetchResult({downloadedBytes: DISCORD_GIF_MAX_BYTES + 1}),
    ];
    for (const result of cases) {
      const service = createDiscordGifService({fetchResource: vi.fn(async () => result)});
      await expect(service.downloadRemoteGif({
        agentKey: "panda",
        connectorKey: "discord-main",
        url: "https://cdn.example/reaction.gif",
      })).rejects.toThrow();
    }
    await expect(createDiscordGifService().downloadRemoteGif({
      agentKey: "panda",
      connectorKey: "discord-main",
      url: "http://cdn.example/reaction.gif",
    })).rejects.toThrow("must use HTTPS");
  });

  it("propagates the bounded timeout and enforces the three-redirect maximum", async () => {
    const timedOut = createDiscordGifService({
      fetchResource: vi.fn(async () => {
        throw new Error(`web.fetch timed out after ${String(DISCORD_GIF_TIMEOUT_MS)}ms.`);
      }),
    });
    await expect(timedOut.downloadRemoteGif({
      agentKey: "panda",
      connectorKey: "discord-main",
      url: "https://public.example/reaction.gif",
    })).rejects.toThrow("timed out after 20000ms");

    let redirect = 0;
    const fetchImpl = vi.fn(async () => {
      redirect += 1;
      return new Response(null, {
        status: 302,
        headers: {Location: `https://public.example/redirect-${String(redirect)}.gif`},
      });
    });
    const tooManyRedirects = createDiscordGifService({
      fetchOptions: {
        lookupHostname: async () => ["93.184.216.34"],
        fetchImpl,
      },
    });
    await expect(tooManyRedirects.downloadRemoteGif({
      agentKey: "panda",
      connectorKey: "discord-main",
      url: "https://public.example/reaction.gif",
    })).rejects.toThrow("redirect limit of 3");
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});

describe("discord.gif.send command", () => {
  it("requires exactly one source before queueing", async () => {
    const enqueueDelivery = vi.fn();
    const command = createDiscordGifSendCommand({
      listConversationBindings: vi.fn(async () => [binding()]),
      enqueueDelivery,
    }, {resolveReadablePath: vi.fn()}, createDiscordGifService());

    for (const input of [
      {connectorKey: "discord-main", conversationId: "12345"},
      {connectorKey: "discord-main", conversationId: "12345", filePath: "a.gif", url: "https://cdn.example/a.gif"},
    ]) {
      await expect(command.execute(request(input))).rejects.toThrow("exactly one of filePath or url");
    }
    expect(enqueueDelivery).not.toHaveBeenCalled();
  });

  it("queues a local GIF as an ordinary Discord file delivery", async () => {
    const enqueueDelivery = vi.fn(async () => ({id: "delivery-1"}));
    const gifs = {
      validateLocalFile: vi.fn(async () => ({path: "/safe/reaction.gif", filename: "reaction.gif", sizeBytes: 9})),
      downloadRemoteGif: vi.fn(),
    };
    const command = createDiscordGifSendCommand({
      listConversationBindings: vi.fn(async () => [binding()]),
      enqueueDelivery,
    }, {
      resolveReadablePath: vi.fn(async () => ({path: "/safe/reaction.gif", displayPath: "reaction.gif"})),
    }, gifs);

    const result = await command.execute(request({
      connectorKey: "discord-main",
      conversationId: "12345",
      filePath: "reaction.gif",
      caption: "Mood",
      threadId: "23456",
      guildId: "34567",
      replyToMessageId: "45678",
    }));

    expect(enqueueDelivery).toHaveBeenCalledWith({
      threadId: "thread-1",
      channel: "discord",
      target: {
        source: "discord",
        connectorKey: "discord-main",
        externalConversationId: "12345",
        replyToMessageId: "45678",
        deliveryContext: {discord: {threadId: "23456", guildId: "34567"}},
      },
      items: [{
        type: "file",
        path: "/safe/reaction.gif",
        filename: "reaction.gif",
        mimeType: "image/gif",
        caption: "Mood",
      }],
      metadata: {discord: {kind: "gif"}},
    });
    expect(result.output).toEqual({ok: true, status: "queued", deliveryId: "delivery-1", source: "local", sizeBytes: 9});
  });

  it("does not persist the remote source URL in the queued delivery or result", async () => {
    const enqueueDelivery = vi.fn(async () => ({id: "delivery-1"}));
    const command = createDiscordGifSendCommand({
      listConversationBindings: vi.fn(async () => [binding()]),
      enqueueDelivery,
    }, {resolveReadablePath: vi.fn()}, {
      validateLocalFile: vi.fn(),
      downloadRemoteGif: vi.fn(async () => ({path: "/agent/media/saved.gif", filename: "saved.gif", sizeBytes: 9})),
    });
    const secretUrl = "https://cdn.example/reaction.gif?secret=1";

    const result = await command.execute(request({
      connectorKey: "discord-main",
      conversationId: "12345",
      url: secretUrl,
    }));

    expect(JSON.stringify(enqueueDelivery.mock.calls[0]?.[0])).not.toContain(secretUrl);
    expect(JSON.stringify(result.output)).not.toContain(secretUrl);
  });

  it("rejects captions over Discord's 2000-character limit", async () => {
    const enqueueDelivery = vi.fn();
    const command = createDiscordGifSendCommand({
      listConversationBindings: vi.fn(async () => [binding()]),
      enqueueDelivery,
    }, {resolveReadablePath: vi.fn()}, createDiscordGifService());
    await expect(command.execute(request({
      connectorKey: "discord-main",
      conversationId: "12345",
      filePath: "reaction.gif",
      caption: "x".repeat(2_001),
    }))).rejects.toThrow("must not exceed 2000 characters");
    expect(enqueueDelivery).not.toHaveBeenCalled();
  });
});
