import {EventEmitter} from "node:events";

import {describe, expect, it, vi} from "vitest";
import {WebSocketShardEvents} from "@discordjs/ws";

import {DiscordGatewayClient} from "../src/integrations/channels/discord/gateway.js";

class FakeGatewayManager extends EventEmitter {
  readonly destroy = vi.fn(async () => undefined);
  readonly getShardCount = vi.fn(async () => 1);
  readonly send = vi.fn(async () => undefined);
  private resolveConnect?: () => void;
  readonly connect = vi.fn(() => new Promise<void>((resolve) => { this.resolveConnect = resolve; }));

  ready(shardId = 0): void {
    this.emit(WebSocketShardEvents.Ready, {session_id: "session-1", resume_gateway_url: "wss://resume.discord"}, shardId);
    this.resolveConnect?.();
  }
}

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function gatewayInfo() {
  return {url: "wss://gateway.discord.gg", shards: 1, session_start_limit: {total: 1_000, remaining: 999, reset_after: 1_000, max_concurrency: 1}};
}

function createGatewayFixture() {
  const manager = new FakeGatewayManager();
  const log = vi.fn();
  const onFatal = vi.fn();
  const onMessageCreate = vi.fn();
  const client = new DiscordGatewayClient({
    accountKey: "ops",
    botToken: "discord-token",
    connectorKey: "123456789012345678",
    fetchGatewayInformation: async () => gatewayInfo(),
    log,
    onFatal,
    onMessageCreate,
    managerFactory: () => manager as never,
  });
  return {client, log, manager, onFatal, onMessageCreate};
}

describe("DiscordGatewayClient", () => {
  it("does not report ready until the managed shard receives READY", async () => {
    const fixture = createGatewayFixture();
    let started = false;
    const start = fixture.client.start().then(() => { started = true; });
    await flushPromises();
    expect(started).toBe(false);
    expect(fixture.client.getHealthSnapshot()).toMatchObject({state: "opening"});

    fixture.manager.ready();
    await start;
    expect(fixture.client.getHealthSnapshot()).toMatchObject({state: "ready", readyAt: expect.any(Number)});
  });

  it("routes dispatches and voice state payloads through the managed Gateway", async () => {
    const fixture = createGatewayFixture();
    const starting = fixture.client.start();
    await flushPromises();
    fixture.manager.ready();
    await starting;
    const methods = {destroy: vi.fn(), onVoiceServerUpdate: vi.fn(), onVoiceStateUpdate: vi.fn()};
    const adapter = fixture.client.createVoiceAdapterCreator("123456789012345678")(methods);

    expect(adapter.sendPayload({op: 4, d: {guild_id: "123456789012345678", channel_id: "voice-1"}})).toBe(true);
    await flushPromises();
    expect(fixture.manager.send).toHaveBeenCalledWith(0, expect.objectContaining({op: 4}));

    fixture.manager.emit(WebSocketShardEvents.Dispatch, {op: 0, t: "MESSAGE_CREATE", d: {id: "message-1"}}, 0);
    fixture.manager.emit(WebSocketShardEvents.Dispatch, {op: 0, t: "VOICE_SERVER_UPDATE", d: {guild_id: "123456789012345678", token: "voice-token"}}, 0);
    fixture.manager.emit(WebSocketShardEvents.Dispatch, {op: 0, t: "VOICE_STATE_UPDATE", d: {guild_id: "123456789012345678", user_id: "123456789012345678", channel_id: "voice-1"}}, 0);
    await flushPromises();

    expect(fixture.onMessageCreate).toHaveBeenCalledWith(expect.objectContaining({id: "message-1"}));
    expect(methods.onVoiceServerUpdate).toHaveBeenCalledOnce();
    expect(methods.onVoiceStateUpdate).toHaveBeenCalledOnce();
  });

  it("keeps voice adapters across a recoverable close and resumes them", async () => {
    const fixture = createGatewayFixture();
    const starting = fixture.client.start();
    await flushPromises();
    fixture.manager.ready();
    await starting;
    const methods = {destroy: vi.fn(), onVoiceServerUpdate: vi.fn(), onVoiceStateUpdate: vi.fn()};
    const adapter = fixture.client.createVoiceAdapterCreator("123456789012345678")(methods);

    fixture.manager.emit(WebSocketShardEvents.Closed, 1006, 0);
    expect(adapter.sendPayload({op: 4, d: {}})).toBe(false);
    expect(methods.destroy).not.toHaveBeenCalled();
    fixture.manager.emit(WebSocketShardEvents.Resumed, 0);
    expect(adapter.sendPayload({op: 4, d: {}})).toBe(true);
    expect(fixture.client.getHealthSnapshot()).toMatchObject({state: "ready", reconnectCount: 1});
  });

  it("reports terminal Gateway closes once and awaits shutdown", async () => {
    const fixture = createGatewayFixture();
    const starting = fixture.client.start();
    await flushPromises();
    fixture.manager.ready();
    await starting;
    fixture.manager.emit(WebSocketShardEvents.Closed, 4014, 0);
    fixture.manager.emit(WebSocketShardEvents.Closed, 4014, 0);
    await flushPromises();
    expect(fixture.onFatal).toHaveBeenCalledTimes(1);

    await fixture.client.stop();
    expect(fixture.manager.destroy).toHaveBeenCalledWith({code: 1000, reason: "Panda Discord worker stopped."});
  });
});
