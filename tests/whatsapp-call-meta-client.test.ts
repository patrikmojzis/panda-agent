import {describe, expect, it, vi} from "vitest";

import {WhatsAppMetaCallClient} from "../src/integrations/channels/whatsapp/calls/meta-client.js";

describe("WhatsApp Meta call client", () => {
  it("uses the official phone-number calls endpoint and bearer auth", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://graph.facebook.com/v23.0/123/calls");
      expect(init?.headers).toMatchObject({Authorization: "Bearer private-token", "Content-Type": "application/json"});
      expect(JSON.parse(String(init?.body))).toEqual({messaging_product: "whatsapp", call_id: "wacid.test", action: "pre_accept", session: {sdp_type: "answer", sdp: "v=0"}});
      return new Response('{"success":true}', {status: 200});
    });
    await new WhatsAppMetaCallClient({accessToken: "private-token", graphVersion: "v23.0", phoneNumberId: "123", fetchImpl}).preAccept("wacid.test", "v=0");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("returns secret-safe provider failures", async () => {
    const client = new WhatsAppMetaCallClient({accessToken: "private-token", graphVersion: "v23.0", phoneNumberId: "123", fetchImpl: vi.fn(async () => new Response("private-token", {status: 403}))});
    await expect(client.terminate("wacid.test")).rejects.toThrow("Meta WhatsApp call terminate failed (403)");
    await expect(client.terminate("wacid.test")).rejects.not.toThrow("private-token");
  });

  it("rejects oversized success responses instead of treating them as acknowledgements", async () => {
    const client = new WhatsAppMetaCallClient({accessToken: "private-token", graphVersion: "v23.0", phoneNumberId: "123", fetchImpl: vi.fn(async () => new Response("x".repeat(65 * 1024), {status: 200}))});
    await expect(client.accept("wacid.test", "v=0")).rejects.toThrow("response exceeded the configured limit");
  });
});
