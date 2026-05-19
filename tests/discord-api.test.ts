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
