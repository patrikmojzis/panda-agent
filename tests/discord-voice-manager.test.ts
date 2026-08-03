import {EventEmitter} from "node:events";
import {PassThrough} from "node:stream";

import {describe, expect, it, vi} from "vitest";

import {DiscordVoiceControlWorker, DiscordVoiceSessionManager, DiscordVoiceSpeakerArbiter} from "../src/integrations/channels/discord/voice-manager.js";
import type {RealtimeVoiceBridge, RealtimeVoiceBridgeOptions} from "../src/integrations/providers/openai-live/bridge.js";

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

  it("joins, carries casual audio, delegates durable work, speaks the result, reports state, and leaves", async () => {
    const player = {state: {status: "playing"}, play: vi.fn(), stop: vi.fn()};
    const connection = {
      receiver: {speaking: new EventEmitter(), subscribe: vi.fn()},
      subscribe: vi.fn(),
      destroy: vi.fn(),
    };
    const encoder = {encode: vi.fn(() => new Uint8Array([1, 2, 3])), free: vi.fn()};
    let bridgeOptions!: RealtimeVoiceBridgeOptions;
    const appendDelegationResult = vi.fn(() => true);
    const bridge: RealtimeVoiceBridge = {
      connect: vi.fn(async () => undefined), sendAudio: vi.fn(), noteAudioPlayed: vi.fn(), interrupt: vi.fn(), close: vi.fn(),
      appendDelegationResult, getActiveDelegationId: vi.fn(() => "delegation-1"),
    };
    let completedTurn = false;
    const store = {
      markConnectorSessionsDisconnected: vi.fn(async () => 0), failRunningControls: vi.fn(async () => 0),
      upsertSession: vi.fn(async (input) => ({...input, startedAt: 1, updatedAt: 1})),
      markSessionDisconnected: vi.fn(async () => undefined),
      createTurn: vi.fn(async (input) => ({...input, status: "pending", createdAt: 1, updatedAt: 1})),
      getTurn: vi.fn(async (id: string) => ({id, voiceSessionId: store.createTurn.mock.calls[0]![0].voiceSessionId, delegationId: "delegation-1", connectorKey: "bot-1", guildId: "guild-1", channelId: "12345", sessionId: "session-1", agentKey: "panda", prompt: "check status", status: completedTurn ? "completed" : "pending", resultText: completedTurn ? "Everything is healthy." : undefined, createdAt: 1, updatedAt: 1})),
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
    expect(joined).toMatchObject({state: "connected", guildId: "guild-1", channelId: "12345", model: "gpt-live-1-codex"});
    bridgeOptions.onAudio(Buffer.alloc(960));
    expect(encoder.encode).toHaveBeenCalled();
    expect(bridge.noteAudioPlayed).toHaveBeenCalledWith(20);

    await bridgeOptions.onDelegation({id: "delegation-1", prompt: "check status"});
    expect(store.createTurn).toHaveBeenCalledWith(expect.objectContaining({sessionId: "session-1", delegationId: "delegation-1", prompt: "check status"}));
    expect(enqueueRequest).toHaveBeenCalledWith({kind: "discord_voice_delegation", payload: {voiceTurnId: expect.any(String)}});

    completedTurn = true;
    await manager.deliverTurnResult(store.createTurn.mock.calls[0]![0].id);
    expect(appendDelegationResult).toHaveBeenCalledWith("delegation-1", "Everything is healthy.");

    const left = await manager.handle({id: "control-2", connectorKey: "bot-1", operation: "leave", sessionId: "session-1", agentKey: "panda", channelId: "12345", status: "running", createdAt: 2, updatedAt: 2});
    expect(left).toMatchObject({state: "disconnected", channelId: "12345"});
    expect(connection.destroy).toHaveBeenCalled();
    expect(bridge.close).toHaveBeenCalled();
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

  it("replaces a failed GPT-Live bridge without leaving Discord voice", async () => {
    const player = {state: {status: "playing"}, play: vi.fn(), stop: vi.fn()};
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
      const bridge: RealtimeVoiceBridge = {
        connect: vi.fn(async () => undefined), sendAudio: vi.fn(), noteAudioPlayed: vi.fn(), interrupt: vi.fn(), close: vi.fn(),
        appendDelegationResult: vi.fn(() => true), getActiveDelegationId: vi.fn(),
      };
      bridges.push(bridge);
      return bridge;
    };
    const store = {
      markConnectorSessionsDisconnected: vi.fn(async () => 0), failRunningControls: vi.fn(async () => 0),
      upsertSession: vi.fn(async (input) => ({...input, startedAt: 1, updatedAt: 1})),
      markSessionDisconnected: vi.fn(async () => undefined),
    };
    const manager = new DiscordVoiceSessionManager({
      connectorKey: "bot-1", botToken: "discord-secret", gatewayAdapter: vi.fn(() => (() => ({sendPayload: () => true, destroy: () => undefined}))),
      restClient: {getChannelMetadata: vi.fn(async () => ({id: "12345", type: 2, guildId: "guild-1"}))},
      store: store as never, requests: {enqueueRequest: vi.fn()} as never, log: vi.fn(), createBridge,
      openVoiceTransport: vi.fn(async () => ({connection: connection as never, output: new PassThrough(), player: player as never, outputEncoder: encoder as never})),
    });

    await manager.start();
    await manager.handle({id: "control-1", connectorKey: "bot-1", operation: "join", sessionId: "session-1", agentKey: "panda", channelId: "12345", status: "running", createdAt: 1, updatedAt: 1});
    bridgeOptions[0]!.onClose("provider_failed");

    await vi.waitFor(() => expect(bridges).toHaveLength(2));
    expect(bridges[1]!.connect).toHaveBeenCalledOnce();
    expect(connection.destroy).not.toHaveBeenCalled();

    bridgeOptions[1]!.onClose("auth_unavailable");
    await vi.waitFor(() => expect(connection.destroy).toHaveBeenCalledOnce());
    expect(store.markSessionDisconnected).toHaveBeenCalledWith("bot-1", "guild-1", "error", "auth_unavailable");
  });

  it("rolls back a join whose control became terminal before completion", async () => {
    const control = {id: "control-1", connectorKey: "bot-1", operation: "join" as const, sessionId: "session-1", agentKey: "panda", channelId: "12345", status: "running" as const, createdAt: 1, updatedAt: 1};
    const result = {ok: true, state: "connected", connectorKey: "bot-1", guildId: "guild-1", channelId: "12345", sessionId: "session-1", voiceSessionId: "voice-1", model: "gpt-live-1-codex"};
    const manager = {start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined), handle: vi.fn(async () => result), rollbackSupersededControl: vi.fn(async () => undefined), deliverTurnResult: vi.fn(async () => undefined)};
    const store = {
      listen: vi.fn(async () => async () => undefined),
      claimNextControl: vi.fn().mockResolvedValueOnce(control).mockResolvedValueOnce(null),
      completeControl: vi.fn(async () => ({...control, status: "failed", error: "timeout"})),
      failControl: vi.fn(),
    };
    const worker = new DiscordVoiceControlWorker({connectorKey: "bot-1", store: store as never, manager: manager as never, log: vi.fn()});
    await worker.start();
    expect(manager.rollbackSupersededControl).toHaveBeenCalledWith(control, result);
    await worker.stop();
  });
});
