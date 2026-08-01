import {describe, expect, it, vi} from "vitest";

import {
  createDiscordRestClient,
  type DiscordApiFetchInit,
  type DiscordApiFetchResponse,
} from "../src/integrations/channels/discord/api.js";

const privateToken = "discord-private-token-fragment-12345678";

function okMessageResponse(id = "message-1"): DiscordApiFetchResponse {
  return {
    ok: true,
    status: 200,
    json: async () => ({id}),
  };
}

describe("Discord REST createMessage", () => {
  it("sends native sticker ids in the JSON message body", async () => {
    const fetcher = vi.fn(async () => okMessageResponse());
    const client = createDiscordRestClient({apiBaseUrl: "https://discord.example/api/v10", fetcher});
    const body = {
      allowed_mentions: {parse: []},
      sticker_ids: ["111", "222"],
    } as const;

    await client.createMessage(privateToken, "channel-1", body);

    expect(fetcher).toHaveBeenCalledWith(
      "https://discord.example/api/v10/channels/channel-1/messages",
      expect.objectContaining({body: JSON.stringify(body)}),
    );
  });

  it("keeps text-only sends on the JSON request path", async () => {
    const fetcher = vi.fn(async () => okMessageResponse());
    const client = createDiscordRestClient({
      apiBaseUrl: "https://discord.example/api/v10/",
      fetcher,
    });
    const body = {
      content: "hello",
      allowed_mentions: {parse: []},
    };

    await expect(client.createMessage(privateToken, "channel-1", body)).resolves.toEqual({id: "message-1"});

    expect(fetcher).toHaveBeenCalledWith("https://discord.example/api/v10/channels/channel-1/messages", {
      method: "POST",
      headers: expect.objectContaining({
        Accept: "application/json",
        Authorization: `Bot ${privateToken}`,
        "Content-Type": "application/json",
      }),
      body: JSON.stringify(body),
    });
  });

  it("sends upload files as multipart form data without setting Content-Type manually", async () => {
    const bytes = Buffer.from("fake-pdf");
    const payload = {
      content: "report attached",
      allowed_mentions: {parse: []},
      message_reference: {
        message_id: "reply-1",
        channel_id: "channel-1",
        fail_if_not_exists: false,
      },
    };
    const fetcher = vi.fn(async (_url: string, init: DiscordApiFetchInit) => {
      expect(init.headers).toMatchObject({
        Accept: "application/json",
        Authorization: `Bot ${privateToken}`,
      });
      expect(init.headers).not.toHaveProperty("Content-Type");
      expect(init.body).toBeInstanceOf(FormData);
      if (!(init.body instanceof FormData)) {
        throw new Error("Expected Discord multipart FormData body.");
      }

      expect(init.body.get("payload_json")).toBe(JSON.stringify(payload));
      const file = init.body.get("files[0]");
      expect(file).toBeInstanceOf(File);
      if (!(file instanceof File)) {
        throw new Error("Expected Discord multipart file.");
      }
      expect(file.name).toBe("report.pdf");
      expect(file.type).toBe("application/pdf");
      expect(Buffer.from(await file.arrayBuffer())).toEqual(bytes);

      return okMessageResponse("message-2");
    });
    const client = createDiscordRestClient({
      apiBaseUrl: "https://discord.example/api/v10",
      fetcher,
    });

    await expect(client.createMessage(privateToken, "channel-1", payload, [{
      filename: "report.pdf",
      bytes,
      mimeType: "application/pdf",
    }])).resolves.toEqual({id: "message-2"});

    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://discord.example/api/v10/channels/channel-1/messages");
    expect(fetcher.mock.calls[0]?.[1].method).toBe("POST");
  });
});

describe("Discord REST guild stickers", () => {
  it("lists and normalizes bot-visible guild stickers", async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [{
        id: "sticker-1",
        name: "party",
        description: "Party panda",
        tags: "party,panda",
        format_type: 2,
        available: true,
        guild_id: "guild-1",
      }],
    }));
    const client = createDiscordRestClient({apiBaseUrl: "https://discord.example/api/v10", fetcher});

    await expect(client.listGuildStickers(privateToken, "guild-1")).resolves.toEqual([{
      id: "sticker-1",
      name: "party",
      description: "Party panda",
      tags: "party,panda",
      formatType: 2,
      available: true,
      guildId: "guild-1",
    }]);
    expect(fetcher).toHaveBeenCalledWith(
      "https://discord.example/api/v10/guilds/guild-1/stickers",
      expect.objectContaining({method: "GET"}),
    );
  });

  it("surfaces safe Discord status and error codes", async () => {
    const fetcher = vi.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({code: 50013, message: "Missing Permissions"}),
    }));
    const client = createDiscordRestClient({apiBaseUrl: "https://discord.example/api/v10", fetcher});

    await expect(client.listGuildStickers(privateToken, "guild-1")).rejects.toThrow(
      "Discord guild sticker lookup failed: Discord API returned 403 (code 50013: Missing Permissions).",
    );
  });
});
