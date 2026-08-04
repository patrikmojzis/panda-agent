import {EventEmitter} from "node:events";
import {PassThrough} from "node:stream";

import {AudioPlayerStatus, createAudioPlayer} from "@discordjs/voice";
import {describe, expect, it, vi} from "vitest";

import {DiscordVoiceControlWorker, DiscordVoiceSessionManager, DiscordVoiceSpeakerArbiter} from "../src/integrations/channels/discord/voice-manager.js";
import type {RealtimeVoiceBridge, RealtimeVoiceBridgeOptions} from "../src/integrations/providers/openai-live/bridge.js";

function fakePlayer() {
  return Object.assign(new EventEmitter(), {state: {status: "playing"}, play: vi.fn(), stop: vi.fn()});
}

describe("DiscordVoiceSessionManager fake end-to-end", () => {
  it("arbitrates the first speaker, ignores self, drops overlaps, and enforces the minute limit", () => {
    const arbiter = new DiscordVoiceSpeakerArbiter();
    expect(arbiter.start("bot-1", "bot-1", 1)).toBe("self");
    expect(arbiter.start("user-1", "bot-1", 1)).toBe("accepted");
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
    const connection = {
      receiver: {speaking: new EventEmitter(), subscribe: vi.fn()},
      subscribe: vi.fn(),
      destroy: vi.fn(),
    };
    const encoder = {encode: vi.fn(() => new Uint8Array([1, 2, 3])), free: vi.fn()};
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
      createTurn: vi.fn(async (input) => ({...input, status: "pending", createdAt: 1, updatedAt: 1})),
      getTurn: vi.fn(async (id: string) => ({id, voiceSessionId: store.createTurn.mock.calls[0]![0].voiceSessionId, delegationId: "delegation-1", connectorKey: "bot-1", guildId: "guild-1", channelId: "12345", sessionId: "session-1", agentKey: "panda", prompt: "check status", status: "running", createdAt: 1, updatedAt: 1})),
      completeTurn: vi.fn(async (id: string, text: string) => ({...await store.getTurn(id), status: "completed", resultText: text})),
    };
    const enqueueRequest = vi.fn(async () => ({id: "request-1"}));
    const manager = new DiscordVoiceSessionManager({
      connectorKey: "bot-1", botToken: "discord-secret", env: {PANDA_DISCORD_VOICE_VOICE: "cove"},
      gatewayAdapter: vi.fn(() => (() => ({sendPayload: () => true, destroy: () => undefined}))),
      restClient: {getChannelMetadata: vi.fn(async () => ({id: "12345", type: 2, guildId: "guild-1"}))},
      store: store as never, requests: {enqueueRequest} as never, log: vi.fn(),
      openVoiceTransport: vi.fn(async () => ({connection: connection as never, output: new PassThrough(), player: player as never, outputEncoder: encoder as never})),
      createBridge: (options) => { bridgeOptions = options; return bridge; },
    });

    await manager.start();
    const joined = await manager.handle({id: "control-1", connectorKey: "bot-1", operation: "join", sessionId: "session-1", agentKey: "panda", channelId: "12345", status: "running", createdAt: 1, updatedAt: 1});
    expect(joined).toMatchObject({state: "connected", guildId: "guild-1", channelId: "12345", model: "gpt-live-1-codex", guidance: expect.stringContaining("discord voice send")});
    bridgeOptions.onAudio(Buffer.alloc(960));
    expect(encoder.encode).toHaveBeenCalled();

    await bridgeOptions.onDelegation({id: "delegation-1", prompt: "check status"});
    expect(store.createTurn).toHaveBeenCalledWith(expect.objectContaining({sessionId: "session-1", delegationId: "delegation-1", prompt: "check status"}));
    expect(enqueueRequest).toHaveBeenCalledWith({kind: "discord_voice_delegation", payload: {voiceTurnId: expect.any(String)}});

    const voiceTurnId = store.createTurn.mock.calls[0]![0].id;
    await manager.handle({id: "control-progress", connectorKey: "bot-1", operation: "send", sessionId: "session-1", agentKey: "panda", channelId: "12345", text: "I’m checking that now.", mode: "progress", voiceTurnId, status: "running", createdAt: 2, updatedAt: 2});
    expect(appendDelegationContext).toHaveBeenCalledWith("delegation-1", "I’m checking that now.", "commentary");
    expect(store.completeTurn).not.toHaveBeenCalled();

    await expect(manager.handle({id: "control-final", connectorKey: "bot-1", operation: "send", sessionId: "session-1", agentKey: "panda", channelId: "12345", text: "Everything is healthy.", mode: "final", voiceTurnId, status: "running", createdAt: 3, updatedAt: 3}))
      .resolves.toMatchObject({state: "sent", mode: "final", delivery: "delegation", voiceTurnId});
    expect(appendDelegationContext).toHaveBeenLastCalledWith("delegation-1", "Everything is healthy.", "speakable");
    expect(store.completeTurn).toHaveBeenCalledWith(voiceTurnId, "Everything is healthy.");

    await manager.handle({id: "control-proactive", connectorKey: "bot-1", operation: "send", sessionId: "session-1", agentKey: "panda", channelId: "12345", text: "One more thing.", mode: "final", status: "running", createdAt: 4, updatedAt: 4});
    expect(appendSessionContext).toHaveBeenCalledWith("One more thing.", "speakable");

    const left = await manager.handle({id: "control-2", connectorKey: "bot-1", operation: "leave", sessionId: "session-1", agentKey: "panda", channelId: "12345", status: "running", createdAt: 2, updatedAt: 2});
    expect(left).toMatchObject({state: "disconnected", channelId: "12345"});
    expect(connection.destroy).toHaveBeenCalled();
    expect(bridge.close).toHaveBeenCalled();
  });

  it("replaces an ended Discord audio resource before playing the next response", async () => {
    const player = createAudioPlayer();
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

    bridgeOptions.onAudio(Buffer.alloc(960));
    expect(player.state.status).not.toBe(AudioPlayerStatus.Idle);
    player.stop(true);
    expect(output.destroyed).toBe(true);

    bridgeOptions.onAudio(Buffer.alloc(960));
    expect(player.state.status).not.toBe(AudioPlayerStatus.Idle);
    expect(log).not.toHaveBeenCalledWith("voice_playback_failed", expect.anything());
    expect(connection.destroy).not.toHaveBeenCalled();

    await manager.stop();
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
      openVoiceTransport: vi.fn(async () => ({connection: connection as never, output: new PassThrough(), player: player as never, outputEncoder: {encode: vi.fn(), free: vi.fn()} as never})),
    });

    await manager.start();
    await expect(manager.handle({id: "control-1", connectorKey: "bot-1", operation: "join", sessionId: "session-1", agentKey: "panda", channelId: "12345", status: "running", createdAt: 1, updatedAt: 1}))
      .rejects.toThrow('"failureCode":"provider_startup_failed"');
    expect(store.markSessionDisconnected).toHaveBeenCalledWith("bot-1", "guild-1", "error", "provider_startup_failed");
  });

  it("replaces a failed GPT-Live bridge without leaving Discord voice", async () => {
    const player = fakePlayer();
    const connection = {
      receiver: {speaking: new EventEmitter(), subscribe: vi.fn()},
      subscribe: vi.fn(),
      destroy: vi.fn(),
    };
    const encoder = {encode: vi.fn(() => new Uint8Array([1])), free: vi.fn()};
    const bridgeOptions: RealtimeVoiceBridgeOptions[] = [];
    const bridges: RealtimeVoiceBridge[] = [];
    const createBridge = (options: RealtimeVoiceBridgeOptions): RealtimeVoiceBridge => {
      bridgeOptions.push(options);
      const isFirst = bridges.length === 0;
      const bridge: RealtimeVoiceBridge = {
        connect: vi.fn(async () => undefined), sendAudio: vi.fn(), interrupt: vi.fn(), close: vi.fn(),
        appendDelegationContext: vi.fn(() => isFirst), appendSessionContext: vi.fn(() => true),
      };
      bridges.push(bridge);
      return bridge;
    };
    const store = {
      markConnectorSessionsDisconnected: vi.fn(async () => 0), failRunningControls: vi.fn(async () => 0),
      upsertSession: vi.fn(async (input) => ({...input, startedAt: 1, updatedAt: 1})),
      markSessionDisconnected: vi.fn(async () => undefined),
      createTurn: vi.fn(async (input) => ({...input, status: "pending", createdAt: 1, updatedAt: 1})),
      getTurn: vi.fn(async (id: string) => ({id, voiceSessionId: store.createTurn.mock.calls[0]![0].voiceSessionId, delegationId: "delegation-1", connectorKey: "bot-1", guildId: "guild-1", channelId: "12345", sessionId: "session-1", agentKey: "panda", prompt: "check status", status: "running", createdAt: 1, updatedAt: 1})),
      completeTurn: vi.fn(async (id: string, text: string) => ({...await store.getTurn(id), status: "completed", resultText: text})),
    };
    const manager = new DiscordVoiceSessionManager({
      connectorKey: "bot-1", botToken: "discord-secret", gatewayAdapter: vi.fn(() => (() => ({sendPayload: () => true, destroy: () => undefined}))),
      restClient: {getChannelMetadata: vi.fn(async () => ({id: "12345", type: 2, guildId: "guild-1"}))},
      store: store as never, requests: {enqueueRequest: vi.fn()} as never, log: vi.fn(), createBridge,
      openVoiceTransport: vi.fn(async () => ({connection: connection as never, output: new PassThrough(), player: player as never, outputEncoder: encoder as never})),
    });

    await manager.start();
    await manager.handle({id: "control-1", connectorKey: "bot-1", operation: "join", sessionId: "session-1", agentKey: "panda", channelId: "12345", status: "running", createdAt: 1, updatedAt: 1});
    bridgeOptions[0]!.onTranscript?.("user", "Are we healthy?");
    bridgeOptions[0]!.onTranscript?.("assistant", "Let me check.");
    await bridgeOptions[0]!.onDelegation({id: "delegation-1", prompt: "check status"});
    bridgeOptions[0]!.onClose("provider_failed");

    await vi.waitFor(() => expect(bridges).toHaveLength(2));
    expect(bridges[1]!.connect).toHaveBeenCalledOnce();
    expect(connection.destroy).not.toHaveBeenCalled();
    expect(bridgeOptions[1]!.initialItems).toEqual([{role: "user", text: "Are we healthy?"}, {role: "assistant", text: "Let me check."}]);

    encoder.encode.mockClear();
    bridgeOptions[0]!.onAudio(Buffer.alloc(960));
    expect(encoder.encode).not.toHaveBeenCalled();
    bridgeOptions[1]!.onAudio(Buffer.alloc(960));
    expect(encoder.encode).toHaveBeenCalledOnce();

    const turnId = store.createTurn.mock.calls[0]![0].id;
    await manager.handle({id: "control-send", connectorKey: "bot-1", operation: "send", sessionId: "session-1", agentKey: "panda", channelId: "12345", text: "Everything is healthy.", mode: "final", voiceTurnId: turnId, status: "running", createdAt: 2, updatedAt: 2});
    expect(bridges[1]!.appendDelegationContext).toHaveBeenCalledWith("delegation-1", "Everything is healthy.", "speakable");
    expect(bridges[1]!.appendSessionContext).toHaveBeenCalledWith("Everything is healthy.", "speakable");

    bridgeOptions[1]!.onClose("auth_unavailable");
    await vi.waitFor(() => expect(connection.destroy).toHaveBeenCalledOnce());
    expect(store.markSessionDisconnected).toHaveBeenCalledWith("bot-1", "guild-1", "error", "auth_unavailable");
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
});
