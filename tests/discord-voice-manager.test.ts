import {EventEmitter} from "node:events";
import {PassThrough} from "node:stream";

import {afterEach, describe, expect, it, vi} from "vitest";

import {DiscordVoiceControlWorker, DiscordVoiceSessionManager, DiscordVoiceSpeakerArbiter} from "../src/integrations/channels/discord/voice-manager.js";
import type {RealtimeVoiceBridge, RealtimeVoiceBridgeOptions} from "../src/integrations/providers/openai-live/bridge.js";

function fakePlayer() {
  return Object.assign(new EventEmitter(), {state: {status: "playing"}, play: vi.fn(), stop: vi.fn()});
}

function deferredValue<T>(): {promise: Promise<T>; resolve(value: T): void} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return {promise, resolve};
}

afterEach(() => vi.useRealTimers());

describe("DiscordVoiceSessionManager fake end-to-end", () => {
  it("arbitrates the first speaker, ignores self, drops overlaps, and enforces the minute limit", () => {
    const arbiter = new DiscordVoiceSpeakerArbiter();
    expect(arbiter.start("bot-1", "bot-1", 1)).toBe("self");
    expect(arbiter.start("user-1", "bot-1", 1)).toBe("accepted");
    expect(arbiter.start("user-1", "bot-1", 2)).toBe("continued");
    expect(arbiter.start("user-2", "bot-1", 2)).toBe("overlap");
    arbiter.finish("user-1");
    for (let index = 1; index < 30; index += 1) {
      expect(arbiter.start(`user-${String(index + 1)}`, "bot-1", 10 + index)).toBe("accepted");
      arbiter.finish(`user-${String(index + 1)}`);
    }
    expect(arbiter.start("user-31", "bot-1", 50)).toBe("rate_limit");
    expect(arbiter.start("user-31", "bot-1", 60_100)).toBe("accepted");
  });

  it("joins, delegates durable work, accepts explicit progress and final delivery, speaks proactively, and leaves", async () => {
    const player = fakePlayer();
    const inputStreams: PassThrough[] = [];
    const connection = {
      receiver: {speaking: new EventEmitter(), subscribe: vi.fn(() => { const stream = new PassThrough(); inputStreams.push(stream); return stream; })},
      subscribe: vi.fn(),
      destroy: vi.fn(),
    };
    const encoder = {encode: vi.fn(() => new Uint8Array([1, 2, 3])), free: vi.fn()};
    const createInputDecoder = vi.fn(async () => ({decode: vi.fn(() => new Int16Array(1_920)), free: vi.fn()}));
    let bridgeOptions!: RealtimeVoiceBridgeOptions;
    const appendDelegationContext = vi.fn(() => true);
    const appendSessionContext = vi.fn(() => true);
    const bridge: RealtimeVoiceBridge = {
      connect: vi.fn(async () => undefined), sendAudio: vi.fn(), interrupt: vi.fn(), close: vi.fn(),
      appendDelegationContext, appendSessionContext,
    };
    const store = {
      markConnectorSessionsDisconnected: vi.fn(async () => 0), failRunningControls: vi.fn(async () => 0),
      upsertSession: vi.fn(async (input) => ({...input, startedAt: 1, updatedAt: 1})),
      markSessionDisconnected: vi.fn(async () => undefined),
      createOrGetTurn: vi.fn(async (input) => ({turn: {...input, status: "pending", createdAt: 1, updatedAt: 1}, created: true})),
      getTurn: vi.fn(async (id: string) => ({id, voiceSessionId: store.createOrGetTurn.mock.calls[0]![0].voiceSessionId, delegationId: "delegation-1", connectorKey: "bot-1", guildId: "guild-1", channelId: "12345", sessionId: "session-1", agentKey: "panda", sourceUtteranceId: store.createOrGetTurn.mock.calls[0]![0].sourceUtteranceId, prompt: "check status", status: "running", createdAt: 1, updatedAt: 1})),
      completeTurn: vi.fn(async (id: string, text: string) => ({...await store.getTurn(id), status: "completed", resultText: text})),
      failTurn: vi.fn(async (id: string, error: string) => ({...await store.getTurn(id), status: "failed", error})),
      reserveFinalDelivery: vi.fn(async (id: string, controlId: string, text: string) => ({turn: {...await store.getTurn(id), status: "final_sending", finalControlId: controlId, finalText: text}, reserved: true})),
      releaseFinalDelivery: vi.fn(async (id: string) => store.getTurn(id)),
      completeReservedFinal: vi.fn(async (id: string) => ({...await store.getTurn(id), status: "completed"})),
    };
    const enqueueRequest = vi.fn(async () => ({id: "request-1"}));
    const manager = new DiscordVoiceSessionManager({
      connectorKey: "bot-1", botToken: "discord-secret", env: {PANDA_DISCORD_VOICE_VOICE: "cove"},
      gatewayAdapter: vi.fn(() => (() => ({sendPayload: () => true, destroy: () => undefined}))),
      restClient: {getChannelMetadata: vi.fn(async () => ({id: "12345", type: 2, guildId: "guild-1"}))},
      store: store as never, requests: {enqueueRequest} as never, log: vi.fn(),
      openVoiceTransport: vi.fn(async () => ({connection: connection as never, output: new PassThrough(), player: player as never, outputEncoder: encoder as never})),
      createInputDecoder: createInputDecoder as never,
      createBridge: (options) => { bridgeOptions = options; return bridge; },
    });

    await manager.start();
    const joined = await manager.handle({id: "control-1", connectorKey: "bot-1", operation: "join", sessionId: "session-1", agentKey: "panda", channelId: "12345", status: "running", createdAt: 1, updatedAt: 1});
    expect(joined).toMatchObject({state: "connected", guildId: "guild-1", channelId: "12345", model: "gpt-live-1-codex", guidance: expect.stringContaining("discord voice send")});
    bridgeOptions.onAudio(Buffer.alloc(960));
    expect(encoder.encode).toHaveBeenCalled();

    connection.receiver.speaking.emit("start", "zero-audio-user");
    await vi.waitFor(() => expect(inputStreams).toHaveLength(1));
    inputStreams[0]!.destroy();
    await new Promise<void>((resolve) => setImmediate(resolve));
    connection.receiver.speaking.emit("start", "user-1");
    await vi.waitFor(() => expect(inputStreams).toHaveLength(2));
    inputStreams[1]!.write(Buffer.from([1, 2, 3]));
    await vi.waitFor(() => expect(bridge.sendAudio).toHaveBeenCalledOnce());
    bridgeOptions.onTurnDone?.({role: "user"});
    inputStreams[1]!.destroy();
    await new Promise<void>((resolve) => setImmediate(resolve));
    connection.receiver.speaking.emit("start", "user-2");
    await bridgeOptions.onDelegation({id: "delegation-1", prompt: "check status"});
    expect(store.createOrGetTurn).toHaveBeenCalledWith(expect.objectContaining({sessionId: "session-1", delegationId: "delegation-1", prompt: "check status", externalActorId: "user-1", sourceUtteranceId: expect.any(String)}));
    expect(enqueueRequest).toHaveBeenCalledWith({kind: "discord_voice_delegation", payload: {voiceTurnId: expect.any(String)}}, {idempotencyKey: expect.stringContaining("discord_voice_delegation:")});

    const voiceTurnId = store.createOrGetTurn.mock.calls[0]![0].id;
    await manager.handle({id: "control-progress", connectorKey: "bot-1", operation: "send", sessionId: "session-1", agentKey: "panda", channelId: "12345", text: "I’m checking that now.", mode: "progress", voiceTurnId, status: "running", createdAt: 2, updatedAt: 2});
    expect(appendDelegationContext).toHaveBeenCalledWith("delegation-1", "I’m checking that now.", "commentary");
    expect(store.completeTurn).not.toHaveBeenCalled();

    appendDelegationContext.mockReturnValueOnce(false);
    await expect(manager.handle({id: "control-final-retry", connectorKey: "bot-1", operation: "send", sessionId: "session-1", agentKey: "panda", channelId: "12345", text: "Everything is healthy.", mode: "final", voiceTurnId, status: "running", createdAt: 3, updatedAt: 3}))
      .rejects.toThrow('"failureCode":"provider_unavailable"');
    expect(store.releaseFinalDelivery).toHaveBeenCalledWith(voiceTurnId, "control-final-retry");
    expect(store.completeReservedFinal).not.toHaveBeenCalled();

    await expect(manager.handle({id: "control-final", connectorKey: "bot-1", operation: "send", sessionId: "session-1", agentKey: "panda", channelId: "12345", text: "Everything is healthy.", mode: "final", voiceTurnId, status: "running", createdAt: 4, updatedAt: 4}))
      .resolves.toMatchObject({state: "sent", mode: "final", delivery: "delegation", voiceTurnId});
    expect(appendDelegationContext).toHaveBeenLastCalledWith("delegation-1", "Everything is healthy.", "speakable");
    expect(store.completeReservedFinal).toHaveBeenCalledWith(voiceTurnId, "control-final");

    await manager.handle({id: "control-proactive", connectorKey: "bot-1", operation: "send", sessionId: "session-1", agentKey: "panda", channelId: "12345", text: "One more thing.", mode: "final", status: "running", createdAt: 5, updatedAt: 5});
    expect(appendSessionContext).toHaveBeenCalledWith("One more thing.", "speakable");

    inputStreams[2]!.destroy();
    await new Promise<void>((resolve) => setImmediate(resolve));
    connection.receiver.speaking.emit("start", "user-1");
    await vi.waitFor(() => expect(inputStreams).toHaveLength(4));
    inputStreams[3]!.write(Buffer.from([1, 2, 3]));
    await vi.waitFor(() => expect(bridge.sendAudio).toHaveBeenCalledTimes(2));
    bridgeOptions.onTurnDone?.({role: "user"});
    await bridgeOptions.onDelegation({id: "delegation-leave", prompt: "leave voice"});
    const leaveTurnId = store.createOrGetTurn.mock.calls[1]![0].id;
    const left = await manager.handle({id: "control-2", connectorKey: "bot-1", operation: "leave", sessionId: "session-1", agentKey: "panda", channelId: "12345", voiceTurnId: leaveTurnId, status: "running", createdAt: 2, updatedAt: 2});
    expect(left).toMatchObject({state: "disconnected", channelId: "12345", voiceTurnId: leaveTurnId});
    expect(store.completeTurn).toHaveBeenLastCalledWith(leaveTurnId, "Left the Discord voice channel.");
    expect(connection.destroy).toHaveBeenCalled();
    expect(bridge.close).toHaveBeenCalled();
  });

  it("routes GPT-Live output through packet-aware Discord playback", async () => {
    const player = fakePlayer();
    const output = new PassThrough();
    const connection = {
      receiver: {speaking: new EventEmitter(), subscribe: vi.fn()},
      subscribe: vi.fn(),
      destroy: vi.fn(),
    };
    const store = {
      markConnectorSessionsDisconnected: vi.fn(async () => 0), failRunningControls: vi.fn(async () => 0),
      upsertSession: vi.fn(async (input) => ({...input, startedAt: 1, updatedAt: 1})),
      markSessionDisconnected: vi.fn(async () => undefined),
    };
    const bridge: RealtimeVoiceBridge = {
      connect: vi.fn(async () => undefined), sendAudio: vi.fn(), interrupt: vi.fn(), close: vi.fn(),
      appendDelegationContext: vi.fn(() => true), appendSessionContext: vi.fn(() => true),
    };
    let bridgeOptions!: RealtimeVoiceBridgeOptions;
    const log = vi.fn();
    const manager = new DiscordVoiceSessionManager({
      connectorKey: "bot-1", botToken: "discord-secret", gatewayAdapter: vi.fn(() => (() => ({sendPayload: () => true, destroy: () => undefined}))),
      restClient: {getChannelMetadata: vi.fn(async () => ({id: "12345", type: 2, guildId: "guild-1"}))},
      store: store as never, requests: {enqueueRequest: vi.fn()} as never, log,
      createBridge: (options) => { bridgeOptions = options; return bridge; },
      openVoiceTransport: vi.fn(async () => ({
        connection: connection as never, output, player,
        outputEncoder: {encode: vi.fn(() => new Uint8Array([1, 2, 3])), free: vi.fn()} as never,
      })),
    });

    await manager.start();
    await manager.handle({id: "control-1", connectorKey: "bot-1", operation: "join", sessionId: "session-1", agentKey: "panda", channelId: "12345", status: "running", createdAt: 1, updatedAt: 1});

    bridgeOptions.onAudio(Buffer.alloc(960 * 4));
    expect(player.play).toHaveBeenCalledOnce();
    const source = player.play.mock.calls[0]![0].playStream;
    expect(source.readableObjectMode).toBe(true);
    bridgeOptions.onTurnDone?.({role: "assistant"});
    expect(log).not.toHaveBeenCalledWith("voice_playback_failed", expect.anything());
    expect(connection.destroy).not.toHaveBeenCalled();

    await manager.stop();
  });

  it("encodes complete GPT-Live PCM frames without byte-stream backpressure loss", async () => {
    const player = fakePlayer();
    const output = new PassThrough({highWaterMark: 1});
    const encoder = {encode: vi.fn(() => new Uint8Array([1, 2, 3])), free: vi.fn()};
    const connection = {receiver: {speaking: new EventEmitter(), subscribe: vi.fn()}, subscribe: vi.fn(), destroy: vi.fn()};
    let bridgeOptions!: RealtimeVoiceBridgeOptions;
    const bridge: RealtimeVoiceBridge = {
      connect: vi.fn(async () => undefined), sendAudio: vi.fn(), interrupt: vi.fn(), close: vi.fn(),
      appendDelegationContext: vi.fn(() => true), appendSessionContext: vi.fn(() => true),
    };
    const store = {
      markConnectorSessionsDisconnected: vi.fn(async () => 0), failRunningControls: vi.fn(async () => 0),
      upsertSession: vi.fn(async (input) => ({...input, startedAt: 1, updatedAt: 1})), markSessionDisconnected: vi.fn(async () => undefined),
    };
    const manager = new DiscordVoiceSessionManager({
      connectorKey: "bot-1", botToken: "discord-secret", gatewayAdapter: vi.fn(() => (() => ({sendPayload: () => true, destroy: () => undefined}))),
      restClient: {getChannelMetadata: vi.fn(async () => ({id: "12345", type: 2, guildId: "guild-1"}))},
      store: store as never, requests: {enqueueRequest: vi.fn()} as never, log: vi.fn(),
      createBridge: (options) => { bridgeOptions = options; return bridge; },
      openVoiceTransport: vi.fn(async () => ({connection: connection as never, output, player: player as never, outputEncoder: encoder as never})),
    });

    await manager.start();
    await manager.handle({id: "control-1", connectorKey: "bot-1", operation: "join", sessionId: "session-1", agentKey: "panda", channelId: "12345", status: "running", createdAt: 1, updatedAt: 1});
    bridgeOptions.onAudio(Buffer.alloc(960 * 4));
    expect(encoder.encode).toHaveBeenCalledTimes(4);
    await manager.stop();
  });

  it("cancels an in-flight join atomically and disposes a late Discord transport", async () => {
    const transport = deferredValue<{
      connection: never;
      output: PassThrough;
      player: never;
      outputEncoder: never;
    }>();
    const player = fakePlayer();
    const connection = {receiver: {speaking: new EventEmitter(), subscribe: vi.fn()}, subscribe: vi.fn(), destroy: vi.fn()};
    const encoder = {encode: vi.fn(), free: vi.fn()};
    const openVoiceTransport = vi.fn(() => transport.promise);
    const store = {
      markConnectorSessionsDisconnected: vi.fn(async () => 0), failRunningControls: vi.fn(async () => 0),
      upsertSession: vi.fn(async (input) => ({...input, startedAt: 1, updatedAt: 1})),
      markSessionDisconnected: vi.fn(async () => undefined),
    };
    const createBridge = vi.fn();
    const manager = new DiscordVoiceSessionManager({
      connectorKey: "bot-1", botToken: "discord-secret", gatewayAdapter: vi.fn(() => (() => ({sendPayload: () => true, destroy: () => undefined}))),
      restClient: {getChannelMetadata: vi.fn(async () => ({id: "12345", type: 2, guildId: "guild-1"}))},
      store: store as never, requests: {enqueueRequest: vi.fn()} as never, log: vi.fn(), createBridge,
      openVoiceTransport: openVoiceTransport as never,
    });

    await manager.start();
    const joining = manager.handle({id: "control-1", connectorKey: "bot-1", operation: "join", sessionId: "session-1", agentKey: "panda", channelId: "12345", status: "running", createdAt: 1, updatedAt: 1});
    await vi.waitFor(() => expect(openVoiceTransport).toHaveBeenCalledOnce());
    const stopping = manager.stop();
    await expect(joining).rejects.toThrow();
    await stopping;
    expect(createBridge).not.toHaveBeenCalled();
    expect(store.upsertSession).not.toHaveBeenCalledWith(expect.objectContaining({state: "connected"}));

    transport.resolve({connection: connection as never, output: new PassThrough(), player: player as never, outputEncoder: encoder as never});
    await vi.waitFor(() => expect(connection.destroy).toHaveBeenCalledOnce());
    expect(encoder.free).toHaveBeenCalledOnce();
  });

  it("preserves Discord permission failures from channel lookup", async () => {
    const store = {markConnectorSessionsDisconnected: vi.fn(async () => 0), failRunningControls: vi.fn(async () => 0)};
    const manager = new DiscordVoiceSessionManager({
      connectorKey: "bot-1", botToken: "discord-secret", gatewayAdapter: vi.fn(),
      restClient: {getChannelMetadata: vi.fn(async () => { throw new Error("Discord API returned 403 (Missing Access)"); })},
      store: store as never, requests: {enqueueRequest: vi.fn()} as never, log: vi.fn(),
    });
    await manager.start();
    await expect(manager.handle({id: "control-1", connectorKey: "bot-1", operation: "join", sessionId: "session-1", agentKey: "panda", channelId: "12345", status: "running", createdAt: 1, updatedAt: 1}))
      .rejects.toThrow('"failureCode":"permission_denied"');
  });

  it("does not misreport a provider 403 as a Discord permission failure", async () => {
    const player = fakePlayer();
    const connection = {receiver: {speaking: new EventEmitter(), subscribe: vi.fn()}, subscribe: vi.fn(), destroy: vi.fn()};
    const encoder = {encode: vi.fn(), free: vi.fn()};
    const store = {
      markConnectorSessionsDisconnected: vi.fn(async () => 0), failRunningControls: vi.fn(async () => 0),
      upsertSession: vi.fn(async (input) => ({...input, startedAt: 1, updatedAt: 1})), markSessionDisconnected: vi.fn(async () => undefined),
    };
    const provider403 = Object.assign(new Error("GPT-Live startup failed (403)."), {status: 403});
    const bridge: RealtimeVoiceBridge = {
      connect: vi.fn(async () => { throw provider403; }), sendAudio: vi.fn(), interrupt: vi.fn(), close: vi.fn(),
      appendDelegationContext: vi.fn(() => false), appendSessionContext: vi.fn(() => false),
    };
    const manager = new DiscordVoiceSessionManager({
      connectorKey: "bot-1", botToken: "discord-secret", gatewayAdapter: vi.fn(() => (() => ({sendPayload: () => true, destroy: () => undefined}))),
      restClient: {getChannelMetadata: vi.fn(async () => ({id: "12345", type: 2, guildId: "guild-1"}))},
      store: store as never, requests: {enqueueRequest: vi.fn()} as never, log: vi.fn(), createBridge: () => bridge,
      openVoiceTransport: vi.fn(async () => ({connection: connection as never, output: new PassThrough(), player: player as never, outputEncoder: encoder as never})),
    });

    await manager.start();
    await expect(manager.handle({id: "control-1", connectorKey: "bot-1", operation: "join", sessionId: "session-1", agentKey: "panda", channelId: "12345", status: "running", createdAt: 1, updatedAt: 1}))
      .rejects.toThrow('"failureCode":"provider_startup_failed"');
    expect(bridge.close).toHaveBeenCalledOnce();
    expect(connection.destroy).toHaveBeenCalledOnce();
    expect(player.stop).toHaveBeenCalledWith(true);
    expect(encoder.free).toHaveBeenCalledOnce();
    expect(store.upsertSession).not.toHaveBeenCalledWith(expect.objectContaining({state: "connected"}));
    expect(store.markSessionDisconnected).toHaveBeenCalledWith("bot-1", "guild-1", "error", "provider_startup_failed");
  });

  it("isolates provider generations and supports both delegation event orders", async () => {
    const player = fakePlayer();
    const inputStreams: PassThrough[] = [];
    const connection = {
      receiver: {speaking: new EventEmitter(), subscribe: vi.fn(() => { const stream = new PassThrough(); inputStreams.push(stream); return stream; })},
      subscribe: vi.fn(),
      destroy: vi.fn(),
    };
    const encoder = {encode: vi.fn(() => new Uint8Array([1])), free: vi.fn()};
    const createInputDecoder = vi.fn(async () => ({decode: vi.fn(() => new Int16Array(1_920)), free: vi.fn()}));
    const bridgeOptions: RealtimeVoiceBridgeOptions[] = [];
    const bridges: RealtimeVoiceBridge[] = [];
    const createBridge = (options: RealtimeVoiceBridgeOptions): RealtimeVoiceBridge => {
      bridgeOptions.push(options);
      const bridge: RealtimeVoiceBridge = {
        connect: vi.fn(async () => undefined), sendAudio: vi.fn(), interrupt: vi.fn(), close: vi.fn(),
        appendDelegationContext: vi.fn(() => true), appendSessionContext: vi.fn(() => true),
      };
      bridges.push(bridge);
      return bridge;
    };
    const store = {
      markConnectorSessionsDisconnected: vi.fn(async () => 0), failRunningControls: vi.fn(async () => 0),
      upsertSession: vi.fn(async (input) => ({...input, startedAt: 1, updatedAt: 1})),
      markSessionDisconnected: vi.fn(async () => undefined),
      createOrGetTurn: vi.fn(async (input) => ({turn: {...input, status: "pending", createdAt: 1, updatedAt: 1}, created: true})),
      getTurn: vi.fn(async (id: string) => ({id, voiceSessionId: store.createOrGetTurn.mock.calls[0]![0].voiceSessionId, delegationId: "delegation-1", connectorKey: "bot-1", guildId: "guild-1", channelId: "12345", sessionId: "session-1", agentKey: "panda", sourceUtteranceId: store.createOrGetTurn.mock.calls[0]![0].sourceUtteranceId, prompt: "check status", status: "running", createdAt: 1, updatedAt: 1})),
      completeTurn: vi.fn(async (id: string, text: string) => ({...await store.getTurn(id), status: "completed", resultText: text})),
      failTurn: vi.fn(async (id: string, error: string) => ({...await store.getTurn(id), status: "failed", error})),
      reserveFinalDelivery: vi.fn(async (id: string, controlId: string, text: string) => ({turn: {...await store.getTurn(id), status: "final_sending", finalControlId: controlId, finalText: text}, reserved: true})),
      releaseFinalDelivery: vi.fn(async (id: string) => store.getTurn(id)),
      completeReservedFinal: vi.fn(async (id: string) => ({...await store.getTurn(id), status: "completed"})),
    };
    const enqueueRequest = vi.fn();
    const manager = new DiscordVoiceSessionManager({
      connectorKey: "bot-1", botToken: "discord-secret", gatewayAdapter: vi.fn(() => (() => ({sendPayload: () => true, destroy: () => undefined}))),
      restClient: {getChannelMetadata: vi.fn(async () => ({id: "12345", type: 2, guildId: "guild-1"}))},
      store: store as never, requests: {enqueueRequest} as never, log: vi.fn(), createBridge,
      createInputDecoder: createInputDecoder as never,
      openVoiceTransport: vi.fn(async () => ({connection: connection as never, output: new PassThrough(), player: player as never, outputEncoder: encoder as never})),
    });

    await manager.start();
    await manager.handle({id: "control-1", connectorKey: "bot-1", operation: "join", sessionId: "session-1", agentKey: "panda", channelId: "12345", status: "running", createdAt: 1, updatedAt: 1});
    connection.receiver.speaking.emit("start", "user-1");
    await vi.waitFor(() => expect(inputStreams).toHaveLength(1));
    inputStreams[0]!.write(Buffer.from([1, 2, 3]));
    await vi.waitFor(() => expect(bridges[0]!.sendAudio).toHaveBeenCalledOnce());
    bridgeOptions[0]!.onTurnDone?.({role: "user"});
    await bridgeOptions[0]!.onDelegation({id: "delegation-1", prompt: "check status"});
    bridgeOptions[0]!.onFailure({source: "sideband", code: "transport_failed", retryable: true, message: "closed"});

    await vi.waitFor(() => expect(bridges).toHaveLength(2));
    expect(bridges[1]!.connect).toHaveBeenCalledOnce();
    expect(connection.destroy).not.toHaveBeenCalled();
    expect(bridgeOptions[1]).not.toHaveProperty("initialItems");
    expect(player.stop).toHaveBeenCalledWith(true);

    await bridgeOptions[0]!.onDelegation({id: "stale-delegation", prompt: "ignore this"});
    bridgeOptions[0]!.onFailure({source: "sideband", code: "auth_unavailable", retryable: false, message: "stale failure"});
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(store.createOrGetTurn).toHaveBeenCalledOnce();
    expect(connection.destroy).not.toHaveBeenCalled();

    await bridgeOptions[1]!.onDelegation({id: "delegation-2", prompt: "  CHECK   STATUS "});
    expect(store.createOrGetTurn).toHaveBeenCalledOnce();
    expect(enqueueRequest).toHaveBeenCalledOnce();

    encoder.encode.mockClear();
    bridgeOptions[0]!.onAudio(Buffer.alloc(960));
    expect(encoder.encode).not.toHaveBeenCalled();
    bridgeOptions[1]!.onAudio(Buffer.alloc(960));
    expect(encoder.encode).toHaveBeenCalledOnce();

    const turnId = store.createOrGetTurn.mock.calls[0]![0].id;
    await expect(manager.handle({id: "control-stale-send", connectorKey: "bot-1", operation: "send", sessionId: "session-1", agentKey: "panda", channelId: "12345", text: "Stale answer.", mode: "final", voiceTurnId: turnId, status: "running", createdAt: 2, updatedAt: 2}))
      .rejects.toThrow('"failureCode":"provider_unavailable"');

    inputStreams[0]!.destroy();
    await new Promise<void>((resolve) => setImmediate(resolve));
    connection.receiver.speaking.emit("start", "user-1");
    await vi.waitFor(() => expect(inputStreams).toHaveLength(2));
    inputStreams[1]!.write(Buffer.from([1, 2, 3]));
    await vi.waitFor(() => expect(bridges[1]!.sendAudio).toHaveBeenCalledOnce());
    await bridgeOptions[1]!.onDelegation({id: "delegation-3", prompt: "check status"});
    bridgeOptions[1]!.onTurnDone?.({role: "user"});
    expect(store.createOrGetTurn).toHaveBeenCalledTimes(2);
    expect(enqueueRequest).toHaveBeenCalledTimes(2);

    const currentTurnId = store.createOrGetTurn.mock.calls[1]![0].id;
    await manager.handle({id: "control-send", connectorKey: "bot-1", operation: "send", sessionId: "session-1", agentKey: "panda", channelId: "12345", text: "Everything is healthy.", mode: "final", voiceTurnId: currentTurnId, status: "running", createdAt: 3, updatedAt: 3});
    expect(bridges[1]!.appendDelegationContext).toHaveBeenCalledWith("delegation-3", "Everything is healthy.", "speakable");
    expect(bridges[1]!.appendSessionContext).not.toHaveBeenCalled();

    bridgeOptions[1]!.onFailure({source: "sideband", code: "auth_unavailable", retryable: false, message: "expired"});
    await vi.waitFor(() => expect(connection.destroy).toHaveBeenCalledOnce());
    expect(store.markSessionDisconnected).toHaveBeenCalledWith("bot-1", "guild-1", "error", "auth_unavailable");
  });

  it("opens the provider circuit after repeated short-lived reconnects", async () => {
    const player = fakePlayer();
    const connection = {receiver: {speaking: new EventEmitter(), subscribe: vi.fn()}, subscribe: vi.fn(), destroy: vi.fn()};
    const bridgeOptions: RealtimeVoiceBridgeOptions[] = [];
    const createBridge = (options: RealtimeVoiceBridgeOptions): RealtimeVoiceBridge => {
      bridgeOptions.push(options);
      return {
        connect: vi.fn(async () => undefined), sendAudio: vi.fn(), interrupt: vi.fn(), close: vi.fn(),
        appendDelegationContext: vi.fn(() => true), appendSessionContext: vi.fn(() => true),
      };
    };
    const store = {
      markConnectorSessionsDisconnected: vi.fn(async () => 0), failRunningControls: vi.fn(async () => 0),
      upsertSession: vi.fn(async (input) => ({...input, startedAt: 1, updatedAt: 1})), markSessionDisconnected: vi.fn(async () => undefined),
    };
    const manager = new DiscordVoiceSessionManager({
      connectorKey: "bot-1", botToken: "discord-secret", gatewayAdapter: vi.fn(() => (() => ({sendPayload: () => true, destroy: () => undefined}))),
      restClient: {getChannelMetadata: vi.fn(async () => ({id: "12345", type: 2, guildId: "guild-1"}))},
      store: store as never, requests: {enqueueRequest: vi.fn()} as never, log: vi.fn(), createBridge,
      openVoiceTransport: vi.fn(async () => ({connection: connection as never, output: new PassThrough(), player: player as never, outputEncoder: {encode: vi.fn(), free: vi.fn()} as never})),
    });

    await manager.start();
    await manager.handle({id: "control-1", connectorKey: "bot-1", operation: "join", sessionId: "session-1", agentKey: "panda", channelId: "12345", status: "running", createdAt: 1, updatedAt: 1});
    for (let generation = 0; generation < 3; generation += 1) {
      bridgeOptions[generation]!.onFailure({source: "sideband", code: "transport_failed", retryable: true, message: "closed"});
      await vi.waitFor(() => expect(bridgeOptions).toHaveLength(generation + 2));
    }
    bridgeOptions[3]!.onFailure({source: "sideband", code: "transport_failed", retryable: true, message: "closed"});
    await vi.waitFor(() => expect(connection.destroy).toHaveBeenCalledOnce());
    expect(bridgeOptions).toHaveLength(4);
    expect(store.markSessionDisconnected).toHaveBeenCalledWith("bot-1", "guild-1", "error", "provider_unstable");
  });

  it("buffers the first Discord packets until the Opus decoder is ready", async () => {
    const player = fakePlayer();
    const stream = new PassThrough();
    const connection = {
      receiver: {speaking: new EventEmitter(), subscribe: vi.fn(() => stream)},
      subscribe: vi.fn(), destroy: vi.fn(),
    };
    const bridge: RealtimeVoiceBridge = {
      connect: vi.fn(async () => undefined), sendAudio: vi.fn(), interrupt: vi.fn(), close: vi.fn(),
      appendDelegationContext: vi.fn(() => true), appendSessionContext: vi.fn(() => true),
    };
    let resolveDecoder!: (decoder: {decode: ReturnType<typeof vi.fn>; free: ReturnType<typeof vi.fn>}) => void;
    const decoder = {decode: vi.fn(() => new Int16Array(1_920)), free: vi.fn()};
    const createInputDecoder = vi.fn(() => new Promise((resolve) => { resolveDecoder = resolve; }));
    const store = {
      markConnectorSessionsDisconnected: vi.fn(async () => 0), failRunningControls: vi.fn(async () => 0),
      upsertSession: vi.fn(async (input) => ({...input, startedAt: 1, updatedAt: 1})), markSessionDisconnected: vi.fn(async () => undefined),
    };
    const manager = new DiscordVoiceSessionManager({
      connectorKey: "bot-1", botToken: "discord-secret", gatewayAdapter: vi.fn(() => (() => ({sendPayload: () => true, destroy: () => undefined}))),
      restClient: {getChannelMetadata: vi.fn(async () => ({id: "12345", type: 2, guildId: "guild-1"}))},
      store: store as never, requests: {enqueueRequest: vi.fn()} as never, log: vi.fn(), createBridge: () => bridge,
      createInputDecoder: createInputDecoder as never,
      openVoiceTransport: vi.fn(async () => ({connection: connection as never, output: new PassThrough(), player: player as never, outputEncoder: {encode: vi.fn(), free: vi.fn()} as never})),
    });

    await manager.start();
    await manager.handle({id: "control-1", connectorKey: "bot-1", operation: "join", sessionId: "session-1", agentKey: "panda", channelId: "12345", status: "running", createdAt: 1, updatedAt: 1});
    connection.receiver.speaking.emit("start", "user-1");
    await vi.waitFor(() => expect(createInputDecoder).toHaveBeenCalledOnce());
    stream.write(Buffer.from([1, 2, 3]));
    expect(bridge.sendAudio).not.toHaveBeenCalled();
    resolveDecoder(decoder);
    await vi.waitFor(() => expect(bridge.sendAudio).toHaveBeenCalledOnce());
    await manager.stop();
    await vi.waitFor(() => expect(decoder.free).toHaveBeenCalledOnce());
  });

  it("disconnects cleanly on playback failure and at the absolute voice-session TTL", async () => {
    const run = async (failure: "player" | "ttl") => {
      const player = fakePlayer();
      const connection = {receiver: {speaking: new EventEmitter(), subscribe: vi.fn()}, subscribe: vi.fn(), destroy: vi.fn()};
      const store = {
        markConnectorSessionsDisconnected: vi.fn(async () => 0), failRunningControls: vi.fn(async () => 0),
        upsertSession: vi.fn(async (input) => ({...input, startedAt: 1, updatedAt: 1})), markSessionDisconnected: vi.fn(async () => undefined),
      };
      const bridge: RealtimeVoiceBridge = {
        connect: vi.fn(async () => undefined), sendAudio: vi.fn(), interrupt: vi.fn(), close: vi.fn(),
        appendDelegationContext: vi.fn(() => true), appendSessionContext: vi.fn(() => true),
      };
      const manager = new DiscordVoiceSessionManager({
        connectorKey: "bot-1", botToken: "discord-secret", gatewayAdapter: vi.fn(() => (() => ({sendPayload: () => true, destroy: () => undefined}))),
        restClient: {getChannelMetadata: vi.fn(async () => ({id: "12345", type: 2, guildId: "guild-1"}))},
        store: store as never, requests: {enqueueRequest: vi.fn()} as never, log: vi.fn(), createBridge: () => bridge,
        ...(failure === "ttl" ? {sessionTtlMs: 5} : {}),
        openVoiceTransport: vi.fn(async () => ({connection: connection as never, output: new PassThrough(), player: player as never, outputEncoder: {encode: vi.fn(), free: vi.fn()} as never})),
      });
      await manager.start();
      await manager.handle({id: "control-1", connectorKey: "bot-1", operation: "join", sessionId: "session-1", agentKey: "panda", channelId: "12345", status: "running", createdAt: 1, updatedAt: 1});
      if (failure === "player") player.emit("error", new Error("bad Opus frame"));
      await vi.waitFor(() => expect(connection.destroy).toHaveBeenCalledOnce());
      return store;
    };

    const playerStore = await run("player");
    expect(playerStore.markSessionDisconnected).toHaveBeenCalledWith("bot-1", "guild-1", "error", "discord_audio_failed");
    const ttlStore = await run("ttl");
    expect(ttlStore.markSessionDisconnected).toHaveBeenCalledWith("bot-1", "guild-1", "disconnected", "session_expired");
  });

  it("rolls back a join whose control became terminal before completion", async () => {
    const control = {id: "control-1", connectorKey: "bot-1", operation: "join" as const, sessionId: "session-1", agentKey: "panda", channelId: "12345", status: "running" as const, createdAt: 1, updatedAt: 1};
    const result = {ok: true, state: "connected", connectorKey: "bot-1", guildId: "guild-1", channelId: "12345", sessionId: "session-1", voiceSessionId: "voice-1", model: "gpt-live-1-codex"};
    const manager = {start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined), handle: vi.fn(async () => result), rollbackSupersededControl: vi.fn(async () => undefined)};
    const store = {
      listen: vi.fn(async () => async () => undefined),
      claimNextControl: vi.fn().mockResolvedValueOnce(control).mockResolvedValueOnce(null),
      completeControl: vi.fn(async () => ({...control, status: "failed", error: "timeout"})),
      failControl: vi.fn(),
    };
    const worker = new DiscordVoiceControlWorker({connectorKey: "bot-1", store: store as never, manager: manager as never});
    await worker.start();
    expect(manager.rollbackSupersededControl).toHaveBeenCalledWith(control, result);
    await worker.stop();
  });

  it("coalesces a notification received during an active empty drain into a follow-up pass", async () => {
    let releaseFirst!: () => void;
    const firstClaim = new Promise<null>((resolve) => { releaseFirst = () => resolve(null); });
    const control = {id: "control-1", connectorKey: "bot-1", operation: "leave" as const, sessionId: "session-1", agentKey: "panda", status: "running" as const, createdAt: 1, updatedAt: 1};
    const manager = {start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined), handle: vi.fn(async () => ({ok: true})), rollbackSupersededControl: vi.fn()};
    const store = {
      claimNextControl: vi.fn().mockReturnValueOnce(firstClaim).mockResolvedValueOnce(control).mockResolvedValueOnce(null),
      completeControl: vi.fn(async () => ({...control, status: "completed"})),
      failControl: vi.fn(),
    };
    const worker = new DiscordVoiceControlWorker({connectorKey: "bot-1", store: store as never, manager: manager as never});
    const starting = worker.start();
    await vi.waitFor(() => expect(store.claimNextControl).toHaveBeenCalledOnce());
    const notified = worker.triggerDrain();
    releaseFirst();
    await Promise.all([starting, notified]);
    expect(manager.handle).toHaveBeenCalledWith(control);
    expect(store.completeControl).toHaveBeenCalledOnce();
    await worker.stop();
  });

  it("claims a control on the fallback poll when no notification arrives", async () => {
    vi.useFakeTimers();
    const control = {id: "control-1", connectorKey: "bot-1", operation: "leave" as const, sessionId: "session-1", agentKey: "panda", status: "running" as const, createdAt: 1, updatedAt: 1};
    const manager = {start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined), handle: vi.fn(async () => ({ok: true})), rollbackSupersededControl: vi.fn()};
    const store = {
      claimNextControl: vi.fn(async () => null as typeof control | null),
      completeControl: vi.fn(async () => ({...control, status: "completed" as const})),
      failControl: vi.fn(),
    };
    const worker = new DiscordVoiceControlWorker({connectorKey: "bot-1", store: store as never, manager: manager as never});
    await worker.start();
    store.claimNextControl.mockResolvedValueOnce(control).mockResolvedValueOnce(null);

    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(manager.handle).toHaveBeenCalledWith(control));

    expect(store.completeControl).toHaveBeenCalledOnce();
    await worker.stop();
  });
});
