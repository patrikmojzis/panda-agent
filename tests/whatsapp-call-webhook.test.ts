import {createHmac} from "node:crypto";
import {createServer} from "node:http";
import {afterEach, describe, expect, it, vi} from "vitest";

import {parseWhatsAppCallEvents, verifyMetaWebhookSignature, WhatsAppCallWebhookServer} from "../src/integrations/channels/whatsapp/calls/webhook.js";

describe("WhatsApp call webhook", () => {
  const servers: WhatsAppCallWebhookServer[] = [];
  afterEach(async () => { await Promise.allSettled(servers.splice(0).map((server) => server.close())); });

  it("verifies the raw body with Meta's SHA-256 signature", () => {
    const body = Buffer.from('{"signed":true}');
    const signature = `sha256=${createHmac("sha256", "app-secret").update(body).digest("hex")}`;
    expect(verifyMetaWebhookSignature(body, signature, "app-secret")).toBe(true);
    expect(verifyMetaWebhookSignature(Buffer.from('{"signed":false}'), signature, "app-secret")).toBe(false);
    expect(verifyMetaWebhookSignature(body, "sha256=bad", "app-secret")).toBe(false);
  });

  it("extracts bounded connect and terminate events without retaining unrelated payload", () => {
    const events = parseWhatsAppCallEvents({entry: [{changes: [{field: "calls", value: {metadata: {phone_number_id: "123"}, calls: [
      {id: "wacid.one", event: "connect", timestamp: "1788200000", from: "+421900000000", session: {sdp_type: "offer", sdp: "v=0"}},
      {id: "wacid.one", event: "terminate", timestamp: "1788200001", from_user_id: "bsuid-1"},
      {id: "ignored", event: "ringing", timestamp: "1788200002"},
    ]}}]}]});
    expect(events).toEqual([
      {callId: "wacid.one", phoneNumberId: "123", event: "connect", timestamp: "1788200000", from: "+421900000000", offerSdp: "v=0"},
      {callId: "wacid.one", phoneNumberId: "123", event: "terminate", timestamp: "1788200001", fromUserId: "bsuid-1"},
    ]);
  });

  it("applies one event budget across the whole webhook", () => {
    const calls = Array.from({length: 10}, (_, index) => ({id: `wacid.${index}`, event: "terminate", timestamp: "1788200001"}));
    const payload = {entry: [{changes: [
      {field: "calls", value: {metadata: {phone_number_id: "123"}, calls}},
      {field: "calls", value: {metadata: {phone_number_id: "123"}, calls}},
    ]}]};
    expect(parseWhatsAppCallEvents(payload)).toHaveLength(16);
  });

  it("verifies challenges and acknowledges signed events before processing them", async () => {
    let release!: () => void;
    const processing = new Promise<void>((resolve) => { release = resolve; });
    const onEvent = vi.fn(async () => processing);
    const server = new WhatsAppCallWebhookServer({host: "127.0.0.1", port: 0, log: vi.fn()});
    servers.push(server);
    server.register({phoneNumberId: "123", appSecret: "app-secret", verifyToken: "verify-me", onEvent});
    await server.start();
    const port = server.address()!.port;
    const origin = `http://127.0.0.1:${String(port)}`;

    const challenge = await fetch(`${origin}/webhooks/whatsapp/calls?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=challenge-1`);
    expect(challenge.status).toBe(200);
    expect(await challenge.text()).toBe("challenge-1");

    const body = Buffer.from(JSON.stringify({entry: [{changes: [{field: "calls", value: {metadata: {phone_number_id: "123"}, calls: [{id: "wacid.one", event: "connect", timestamp: "1788200000", from: "+421900000000", session: {sdp_type: "offer", sdp: "v=0"}}]}}]}]}));
    const signature = `sha256=${createHmac("sha256", "app-secret").update(body).digest("hex")}`;
    const response = await fetch(`${origin}/webhooks/whatsapp/calls`, {method: "POST", headers: {"content-type": "application/json", "x-hub-signature-256": signature}, body});
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("EVENT_RECEIVED");
    expect(onEvent).toHaveBeenCalledTimes(1);
    release();
  });

  it("rejects oversized webhook bodies before parsing", async () => {
    const server = new WhatsAppCallWebhookServer({host: "127.0.0.1", port: 0, log: vi.fn()});
    servers.push(server); await server.start();
    const response = await fetch(`http://127.0.0.1:${String(server.address()!.port)}/webhooks/whatsapp/calls`, {method: "POST", headers: {"content-type": "application/json"}, body: Buffer.alloc(1024 * 1024 + 1, 1)});
    expect(response.status).toBe(413);
  });

  it("can retry after a bind failure", async () => {
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    const address = occupied.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP address.");
    const server = new WhatsAppCallWebhookServer({host: "127.0.0.1", port: address.port, log: vi.fn()});
    servers.push(server);
    await expect(server.start()).rejects.toMatchObject({code: "EADDRINUSE"});
    await new Promise<void>((resolve, reject) => occupied.close((error) => error ? reject(error) : resolve()));
    await server.start();
    expect(server.address()).not.toBeNull();
  });

  it("shares one in-flight listener startup across connector workers", async () => {
    const server = new WhatsAppCallWebhookServer({host: "127.0.0.1", port: 0, log: vi.fn()});
    servers.push(server);
    await Promise.all([server.start(), server.start()]);
    expect(server.address()).not.toBeNull();
  });
});
