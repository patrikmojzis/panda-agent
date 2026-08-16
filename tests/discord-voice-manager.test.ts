import {EventEmitter} from "node:events";
import {PassThrough} from "node:stream";

import {describe, expect, it, vi} from "vitest";

import {DiscordVoiceControlWorker, DiscordVoiceSessionManager} from "../src/integrations/channels/discord/voice-manager.js";
import type {LiveVoiceProviderCallbacks} from "../src/integrations/voice/provider.js";

function fakePlayer() {
  return Object.assign(new EventEmitter(), {state: {status: "idle"}, play: vi.fn(), stop: vi.fn()});
}

function createHarness(options: {connectError?: Error} = {}) {
  const streams: PassThrough[] = [];
  const player = fakePlayer();
  const connection = Object.assign(new EventEmitter(), {
    receiver: {speaking: new EventEmitter(), subscribe: vi.fn(() => { const stream = new PassThrough(); streams.push(stream); return stream; })},
    subscribe: vi.fn(),
    destroy: vi.fn(),
  });
  let bridgeOptions!: LiveVoiceProviderCallbacks;
  const bridge = {
    connect: vi.fn(async () => { if (options.connectError) throw options.connectError; }),
    sendAudio: vi.fn(),
    interrupt: vi.fn(() => bridgeOptions.onClearAudio()),
    appendDelegationContext: vi.fn(() => true),
    appendSessionContext: vi.fn(() => true),
    getHealthSnapshot: vi.fn(() => ({state: "connected" as const, sidebandState: "open" as const, sidebandOpenedAt: 1, sidebandAgeMs: 0, lastPingAt: null, lastPongAt: null, pongAgeMs: null, lastCloseCode: null, lastCloseOpenForMs: null, malformedEvents: 0, unknownEvents: 0})),
    close: vi.fn(),
  };
  const turns = new Map<string, Record<string, unknown>>();
  const controls = {failRunningControls: vi.fn(async () => 0)};
  const voice = {
    markConnectorSessionsDisconnected: vi.fn(async () => 0),
    failConnectorActiveTurns: vi.fn(async () => 0),
    upsertSession: vi.fn(async (input) => ({...input, healthReasons: [], startedAt: 1, updatedAt: 1})),
    updateSessionHealth: vi.fn(async () => undefined),
    markSessionDisconnected: vi.fn(async () => undefined),
    createOrGetTurn: vi.fn(async (input: Record<string, unknown>) => {
      const turn = {...input, status: "pending", createdAt: 1, updatedAt: 1};
      turns.set(String(input.id), turn);
      return {turn, created: true};
    }),
    getTurn: vi.fn(async (id: string) => turns.get(id)),
    completeTurn: vi.fn(async (id: string, text: string) => ({...turns.get(id), status: "completed", resultText: text})),
    failTurn: vi.fn(async (id: string, error: string) => ({...turns.get(id), status: "failed", error})),
    reserveFinalDelivery: vi.fn(async (id: string, controlId: string, text: string) => ({turn: {...turns.get(id), status: "final_sending", finalControlId: controlId, finalText: text}, reserved: true})),
    releaseFinalDelivery: vi.fn(async (id: string) => turns.get(id)),
    completeReservedFinal: vi.fn(async (id: string) => ({...turns.get(id), status: "completed"})),
  };
  const requests = {enqueueRequest: vi.fn(async () => ({id: "request-1"}))};
  const encoder = {encode: vi.fn(() => new Uint8Array([1, 2, 3])), free: vi.fn()};
  const manager = new DiscordVoiceSessionManager({
    connectorKey: "bot-1", botToken: "secret",
    gatewayAdapter: vi.fn(() => (() => ({sendPayload: () => true, destroy: () => undefined}))),
    restClient: {getChannelMetadata: vi.fn(async () => ({id: "12345", type: 2, guildId: "guild-1"}))},
    controls: controls as never, voice: voice as never, requests: requests as never, log: vi.fn(),
    openVoiceTransport: vi.fn(async () => ({connection: connection as never, player: player as never, outputEncoder: encoder as never})),
    createInputDecoder: vi.fn(async () => ({decode: vi.fn(() => new Int16Array(1_920).fill(100)), free: vi.fn()})) as never,
    provider: {id: "openai-live", model: "gpt-live-1-codex", createSession: (created) => { bridgeOptions = created; return bridge; }},
  });
  return {manager, connection, streams, bridge, get bridgeOptions() { return bridgeOptions; }, voice, turns, requests};
}

describe("DiscordVoiceSessionManager", () => {
  it("adapts Discord transport to a generic call and durable live-voice turn", async () => {
    const harness = createHarness();
    await harness.manager.start();
    const joined = await harness.manager.handle({id: "join", connectorKey: "bot-1", operation: "join", sessionId: "session-1", agentKey: "panda", channelId: "12345", status: "running", createdAt: 1, updatedAt: 1});
    expect(joined).toMatchObject({state: "connected", guildId: "guild-1", channelId: "12345"});
    expect(harness.voice.upsertSession).toHaveBeenCalledWith(expect.objectContaining({source: "discord", scopeKey: "guild-1", roomKey: "12345", provider: "openai-live"}));

    harness.connection.receiver.speaking.emit("start", "user-1");
    await vi.waitFor(() => expect(harness.streams).toHaveLength(1));
    harness.streams[0]!.write(Buffer.from([1, 2, 3]));
    await vi.waitFor(() => expect(harness.bridge.sendAudio).toHaveBeenCalledOnce());
    harness.bridgeOptions.onTurnDone?.({role: "user"});
    await harness.bridgeOptions.onDelegation({id: "delegation-1", prompt: "check status"});
    expect(harness.voice.createOrGetTurn).toHaveBeenCalledWith(expect.objectContaining({liveVoiceSessionId: expect.any(String), providerDelegationId: "delegation-1", externalActorId: "user-1"}));
    expect(harness.requests.enqueueRequest).toHaveBeenCalledWith({kind: "live_voice_delegation", payload: {liveVoiceTurnId: expect.any(String)}}, {idempotencyKey: expect.stringContaining("live_voice_delegation:")});

    const liveVoiceTurnId = String(harness.voice.createOrGetTurn.mock.calls[0]![0].id);
    harness.turns.set(liveVoiceTurnId, {...harness.turns.get(liveVoiceTurnId), status: "running"});
    await harness.manager.handle({id: "progress", connectorKey: "bot-1", operation: "send", sessionId: "session-1", agentKey: "panda", channelId: "12345", text: "Checking.", mode: "progress", voiceTurnId: liveVoiceTurnId, status: "running", createdAt: 2, updatedAt: 2});
    expect(harness.bridge.appendDelegationContext).toHaveBeenCalledWith("delegation-1", "Checking.", "commentary");

    harness.streams[0]!.destroy();
    const left = await harness.manager.handle({id: "leave", connectorKey: "bot-1", operation: "leave", sessionId: "session-1", agentKey: "panda", channelId: "12345", status: "running", createdAt: 3, updatedAt: 3});
    expect(left).toMatchObject({state: "disconnected"});
    expect(harness.connection.destroy).toHaveBeenCalled();
    expect(harness.bridge.close).toHaveBeenCalled();
  });

  it("keeps provider startup failures distinct from Discord permission failures", async () => {
    const harness = createHarness({connectError: Object.assign(new Error("Voice session access denied"), {status: 403})});
    await harness.manager.start();
    await expect(harness.manager.handle({id: "join", connectorKey: "bot-1", operation: "join", sessionId: "session-1", agentKey: "panda", channelId: "12345", status: "running", createdAt: 1, updatedAt: 1}))
      .rejects.toThrow('"failureCode":"provider_startup_failed"');
    expect(harness.voice.markSessionDisconnected).toHaveBeenCalledWith(expect.any(String), "error", "provider_startup_failed");
  });

  it("ignores connector self-audio before opening a receiver stream", async () => {
    const harness = createHarness();
    await harness.manager.start();
    await harness.manager.handle({id: "join", connectorKey: "bot-1", operation: "join", sessionId: "session-1", agentKey: "panda", channelId: "12345", status: "running", createdAt: 1, updatedAt: 1});
    harness.connection.receiver.speaking.emit("start", "bot-1");
    expect(harness.connection.receiver.subscribe).not.toHaveBeenCalled();
    await harness.manager.stop();
  });
});

describe("DiscordVoiceControlWorker", () => {
  it("claims and completes controls through the Discord-only queue", async () => {
    const control = {id: "one", connectorKey: "bot-1", operation: "leave", sessionId: "session-1", agentKey: "panda", status: "pending", createdAt: 1, updatedAt: 1};
    const controls = {claimNextControl: vi.fn().mockResolvedValueOnce(control).mockResolvedValueOnce(null), completeControl: vi.fn(async () => ({...control, status: "completed"})), failControl: vi.fn()};
    const manager = {start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined), handle: vi.fn(async () => ({ok: true})), rollbackSupersededControl: vi.fn()};
    const worker = new DiscordVoiceControlWorker({connectorKey: "bot-1", controls: controls as never, manager: manager as never});
    await worker.start();
    await vi.waitFor(() => expect(controls.completeControl).toHaveBeenCalledWith("one", {ok: true}));
    await worker.stop();
  });
});
