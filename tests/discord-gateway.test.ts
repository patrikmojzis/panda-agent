import {EventEmitter} from "node:events";

import {describe, expect, it, vi} from "vitest";
import WebSocket from "ws";

import {
  DiscordGatewayClient,
  type DiscordGatewaySocket,
} from "../src/integrations/channels/discord/gateway.js";

class FakeDiscordGatewaySocket extends EventEmitter implements DiscordGatewaySocket {
  readyState = WebSocket.OPEN;
  readonly closeCalls: Array<{code?: number; reason?: string}> = [];
  readonly sent: string[] = [];

  close(code?: number, reason?: string): void {
    this.closeCalls.push({code, reason});
    this.readyState = WebSocket.CLOSED;
    this.emit("close", code ?? 1000, Buffer.from(reason ?? ""));
  }

  override on(event: "open", listener: () => void): this;
  override on(event: "message", listener: (data: WebSocket.RawData) => void): this;
  override on(event: "close", listener: (code: number, reason: Buffer) => void): this;
  override on(event: "error", listener: (error: Error) => void): this;
  override on(event: string, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }

  send(data: string, callback?: (error?: Error) => void): void {
    this.sent.push(data);
    callback?.();
  }
}

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function createGatewayFixture() {
  const sockets: FakeDiscordGatewaySocket[] = [];
  const log = vi.fn();
  const onFatal = vi.fn();
  const client = new DiscordGatewayClient({
    accountKey: "ops",
    botToken: "discord-token",
    connectorKey: "connector-1",
    gatewayUrl: "ws://discord-gateway.example",
    log,
    onFatal,
    onMessageCreate: vi.fn(),
    socketFactory: vi.fn(() => {
      const socket = new FakeDiscordGatewaySocket();
      sockets.push(socket);
      return socket;
    }),
  });

  return {client, log, onFatal, sockets};
}

describe("DiscordGatewayClient", () => {
  it("reconnects without reporting fatal when Discord closes the Gateway with 1001 or 1006", async () => {
    const fixture = createGatewayFixture();
    await fixture.client.start();

    fixture.sockets[0]!.close(1006, "abnormal closure");
    await flushPromises();

    expect(fixture.sockets).toHaveLength(2);
    expect(fixture.onFatal).not.toHaveBeenCalled();
    expect(fixture.log).toHaveBeenCalledWith("gateway_closed", expect.objectContaining({
      code: 1006,
      accountKey: "ops",
      connectorKey: "connector-1",
    }));
    expect(fixture.log).toHaveBeenCalledWith("gateway_reconnecting", expect.objectContaining({
      code: 1006,
      accountKey: "ops",
      connectorKey: "connector-1",
    }));
  });

  it("reports fatal and does not reconnect on unexpected Gateway close codes", async () => {
    const fixture = createGatewayFixture();
    await fixture.client.start();

    fixture.sockets[0]!.close(4000, "bad request");
    await flushPromises();

    expect(fixture.sockets).toHaveLength(1);
    expect(fixture.onFatal).toHaveBeenCalledWith(expect.objectContaining({
      message: "Discord Gateway closed with code 4000.",
    }));
  });

  it("does not report fatal when stop intentionally closes the Gateway", async () => {
    const fixture = createGatewayFixture();
    await fixture.client.start();

    await fixture.client.stop();
    await flushPromises();

    expect(fixture.sockets[0]!.closeCalls).toEqual([{code: 1000, reason: "Panda Discord worker stopped."}]);
    expect(fixture.sockets).toHaveLength(1);
    expect(fixture.onFatal).not.toHaveBeenCalled();
  });
});
