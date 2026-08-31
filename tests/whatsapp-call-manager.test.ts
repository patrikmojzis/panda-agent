import {describe, expect, it, vi} from "vitest";

import {WhatsAppCallManager} from "../src/integrations/channels/whatsapp/calls/manager.js";
import type {LiveVoiceProviderCallbacks} from "../src/integrations/voice/provider.js";

describe("WhatsAppCallManager", () => {
  it("authorizes and binds before pre-accept, then waits for media and GPT-Live before accept", async () => {
    const order: string[] = [];
    const meta = {
      preAccept: vi.fn(async () => { order.push("pre_accept"); }),
      accept: vi.fn(async () => { order.push("accept"); }),
      reject: vi.fn(async () => undefined),
      terminate: vi.fn(async () => undefined),
    };
    let providerCallbacks!: LiveVoiceProviderCallbacks;
    let inboundAudio!: (pcm: Buffer) => void;
    const providerSession = {connect: vi.fn(async () => { order.push("provider"); }), sendAudio: vi.fn(), appendDelegationContext: vi.fn(async () => true), appendSessionContext: vi.fn(async () => true), close: vi.fn()};
    const peer = {
      answer: vi.fn(async () => { order.push("answer"); return "answer-sdp"; }),
      waitUntilConnected: vi.fn(async () => { order.push("media"); }),
      startOutput: vi.fn(() => { order.push("output"); }),
      pushPcm: vi.fn(), clearOutput: vi.fn(), close: vi.fn(),
      snapshot: vi.fn(() => ({state: "connected", receivedPackets: 1, sentPackets: 1, lossMarkers: 0, decodeFailures: 0, queuedMs: 0, droppedOutputMs: 0, lastInboundAt: null, lastOutboundAt: null})),
    };
    const sessions: Record<string, unknown>[] = [];
    const voice = {
      markConnectorSessionsDisconnected: vi.fn(async () => 0),
      failConnectorActiveTurns: vi.fn(async () => 0),
      upsertSession: vi.fn(async (input: Record<string, unknown>) => { sessions.push(input); return input; }),
      updateSessionHealth: vi.fn(async () => undefined), markSessionDisconnected: vi.fn(async () => undefined),
      createOrGetTurnAndEnqueueDelegation: vi.fn(async (input: Record<string, unknown>) => ({...input, status: "pending", createdAt: 1, updatedAt: 1})), getTurn: vi.fn(), reserveFinalDelivery: vi.fn(), releaseFinalDelivery: vi.fn(), completeReservedFinal: vi.fn(), failTurn: vi.fn(), completeTurn: vi.fn(),
    };
    const manager = new WhatsAppCallManager({
      connectorKey: "connector-1", accountAgentKey: "panda", phoneNumberId: "123", env: {PANDA_LIVE_VOICE_ENABLED: "true"},
      meta: meta as never, controls: {failRunningControls: vi.fn(async () => 0)} as never, voice: voice as never,
      agents: {getAgent: vi.fn(async () => ({agentKey: "panda", displayName: "Panda", status: "active" as const, liveVoice: "cove", createdAt: 1, updatedAt: 1}))},
      sessions: {getSession: vi.fn(async () => ({id: "session-1", agentKey: "panda", kind: "main" as const, currentThreadId: "thread-1", createdAt: 1, updatedAt: 1}))},
      conversations: {getConversationBinding: vi.fn(async () => ({source: "whatsapp", connectorKey: "connector-1", externalConversationId: "421900000000@s.whatsapp.net", sessionId: "session-1", metadata: {channelAuthorization: {identityId: "identity-1", agentKey: "panda", actorBindingId: "binding-1"}}, createdAt: 1, updatedAt: 1}))},
      authorizer: {authorizeActor: vi.fn(async () => ({authorized: true as const, identityId: "identity-1", identityHandle: "patrik", agentKey: "panda", actorBindingId: "binding-1", authorizationVersion: "v1"})), reauthorizeCall: vi.fn(async () => true)},
      createPeer: vi.fn(async (input) => { inboundAudio = input.onAudio; return peer; }),
      createProvider: () => ({id: "openai-live", model: "gpt-live-1-codex", validateVoice: (voiceName) => voiceName, createSession: (_config, callbacks) => { providerCallbacks = callbacks; return providerSession; }}),
      log: vi.fn(),
    });
    await manager.start();
    manager.onEvent({callId: "wacid.test", phoneNumberId: "123", event: "connect", from: "+421900000000", timestamp: String(Math.floor(Date.now() / 1_000)), offerSdp: "offer-sdp"});
    await vi.waitFor(() => expect(manager.status()).toHaveLength(1));
    expect(order).toEqual(["answer", "pre_accept", "media", "provider", "accept", "output"]);
    expect(sessions).toEqual([expect.objectContaining({source: "whatsapp", scopeKey: "wacid.test", roomKey: "wacid.test", state: "connecting", voice: "cove"}), expect.objectContaining({state: "connected"})]);
    expect(providerCallbacks.initialItems).toEqual([]);
    const audible = Buffer.alloc(960);
    for (let offset = 0; offset < audible.length; offset += 2) audible.writeInt16LE(2_000, offset);
    inboundAudio(audible);
    await providerCallbacks.onDelegation({id: "delegation-1", prompt: "What do you know about me?"});
    expect(voice.createOrGetTurnAndEnqueueDelegation).toHaveBeenCalledWith(expect.objectContaining({
      identityId: "identity-1",
      transportAuthorization: {identityId: "identity-1", agentKey: "panda", actorBindingId: "binding-1", authorizationVersion: "v1"},
    }));
    expect(voice.createOrGetTurnAndEnqueueDelegation.mock.calls[0]?.[0]).not.toHaveProperty("externalActorId");
    expect(JSON.stringify(voice.createOrGetTurnAndEnqueueDelegation.mock.calls)).not.toContain("421900000000");

    manager.onEvent({callId: "wacid.test", phoneNumberId: "123", event: "terminate", timestamp: String(Math.floor(Date.now() / 1_000))});
    await vi.waitFor(() => expect(manager.status()).toHaveLength(0));
    expect(meta.terminate).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(voice.markSessionDisconnected).toHaveBeenCalledWith(expect.any(String), "disconnected", "remote_terminated"));
    await manager.stop();
  });

  it("rejects unpaired callers before opening WebRTC", async () => {
    const reject = vi.fn(async () => undefined);
    const createPeer = vi.fn();
    const manager = new WhatsAppCallManager({
      connectorKey: "connector-1", accountAgentKey: "panda", phoneNumberId: "123", env: {PANDA_LIVE_VOICE_ENABLED: "true"},
      meta: {preAccept: vi.fn(), accept: vi.fn(), reject, terminate: vi.fn()} as never, controls: {failRunningControls: vi.fn(async () => 0)} as never,
      voice: {markConnectorSessionsDisconnected: vi.fn(async () => 0), failConnectorActiveTurns: vi.fn(async () => 0)} as never,
      agents: {} as never, sessions: {} as never, conversations: {} as never,
      authorizer: {authorizeActor: vi.fn(async () => ({authorized: false as const, reason: "actor_not_authorized" as const})), reauthorizeCall: vi.fn(async () => false)},
      createPeer, log: vi.fn(),
    });
    await manager.start();
    manager.onEvent({callId: "wacid.denied", phoneNumberId: "123", event: "connect", from: "+421900000000", timestamp: String(Math.floor(Date.now() / 1_000)), offerSdp: "offer-sdp"});
    await vi.waitFor(() => expect(reject).toHaveBeenCalledWith("wacid.denied", expect.any(AbortSignal)));
    manager.onEvent({callId: "wacid.denied", phoneNumberId: "123", event: "connect", from: "+421900000000", timestamp: String(Math.floor(Date.now() / 1_000)), offerSdp: "offer-sdp"});
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reject).toHaveBeenCalledTimes(1);
    expect(createPeer).not.toHaveBeenCalled();
    await manager.stop();
  });

  it("rejects stale conversation authority before opening WebRTC", async () => {
    const reject = vi.fn(async () => undefined);
    const createPeer = vi.fn();
    const manager = new WhatsAppCallManager({
      connectorKey: "connector-1", accountAgentKey: "panda", phoneNumberId: "123", env: {PANDA_LIVE_VOICE_ENABLED: "true"},
      meta: {preAccept: vi.fn(), accept: vi.fn(), reject, terminate: vi.fn()} as never,
      controls: {failRunningControls: vi.fn(async () => 0)} as never,
      voice: {markConnectorSessionsDisconnected: vi.fn(async () => 0), failConnectorActiveTurns: vi.fn(async () => 0)} as never,
      agents: {} as never, sessions: {} as never,
      conversations: {getConversationBinding: vi.fn(async () => ({source: "whatsapp", connectorKey: "connector-1", externalConversationId: "421900000000@s.whatsapp.net", sessionId: "session-old", metadata: {channelAuthorization: {identityId: "identity-old", agentKey: "panda", actorBindingId: "binding-old"}}, createdAt: 1, updatedAt: 1}))},
      authorizer: {authorizeActor: vi.fn(async () => ({authorized: true as const, identityId: "identity-1", identityHandle: "patrik", agentKey: "panda", actorBindingId: "binding-1", authorizationVersion: "v1"})), reauthorizeCall: vi.fn(async () => true)},
      createPeer, log: vi.fn(),
    });
    await manager.start();
    manager.onEvent({callId: "wacid.stale", phoneNumberId: "123", event: "connect", from: "+421900000000", timestamp: String(Math.floor(Date.now() / 1_000)), offerSdp: "offer-sdp"});
    await vi.waitFor(() => expect(reject).toHaveBeenCalledWith("wacid.stale", expect.any(AbortSignal)));
    expect(createPeer).not.toHaveBeenCalled();
    await manager.stop();
  });

  it("does not accept or play media when authorization changes during startup", async () => {
    let authorized = true;
    const accept = vi.fn(async () => undefined);
    const terminate = vi.fn(async () => undefined);
    const startOutput = vi.fn();
    const peer = {answer: vi.fn(async () => "answer-sdp"), waitUntilConnected: vi.fn(async () => undefined), startOutput, pushPcm: vi.fn(), clearOutput: vi.fn(), close: vi.fn(), snapshot: vi.fn()};
    const voice = {
      markConnectorSessionsDisconnected: vi.fn(async () => 0), failConnectorActiveTurns: vi.fn(async () => 0),
      upsertSession: vi.fn(async (input: Record<string, unknown>) => input), markSessionDisconnected: vi.fn(async () => undefined),
      failTurn: vi.fn(async () => undefined),
    };
    const manager = new WhatsAppCallManager({
      connectorKey: "connector-1", accountAgentKey: "panda", phoneNumberId: "123", env: {PANDA_LIVE_VOICE_ENABLED: "true"},
      meta: {preAccept: vi.fn(async () => undefined), accept, reject: vi.fn(), terminate} as never,
      controls: {failRunningControls: vi.fn(async () => 0)} as never, voice: voice as never,
      agents: {getAgent: vi.fn(async () => ({agentKey: "panda", displayName: "Panda", status: "active" as const, liveVoice: "cove", createdAt: 1, updatedAt: 1}))},
      sessions: {getSession: vi.fn(async () => ({id: "session-1", agentKey: "panda", kind: "main" as const, currentThreadId: "thread-1", createdAt: 1, updatedAt: 1}))},
      conversations: {getConversationBinding: vi.fn(async () => ({source: "whatsapp", connectorKey: "connector-1", externalConversationId: "421900000000@s.whatsapp.net", sessionId: "session-1", metadata: {channelAuthorization: {identityId: "identity-1", agentKey: "panda", actorBindingId: "binding-1"}}, createdAt: 1, updatedAt: 1}))},
      authorizer: {authorizeActor: vi.fn(async () => authorized
        ? {authorized: true as const, identityId: "identity-1", identityHandle: "patrik", agentKey: "panda", actorBindingId: "binding-1", authorizationVersion: "v1"}
        : {authorized: false as const, reason: "actor_not_authorized" as const}), reauthorizeCall: vi.fn(async () => authorized)},
      createPeer: vi.fn(async () => peer),
      createProvider: () => ({id: "openai-live", model: "gpt-live-1-codex", validateVoice: (voiceName) => voiceName, createSession: () => ({connect: vi.fn(async () => { authorized = false; }), sendAudio: vi.fn(), appendDelegationContext: vi.fn(async () => true), appendSessionContext: vi.fn(async () => true), close: vi.fn()})}),
      log: vi.fn(),
    });
    await manager.start();
    manager.onEvent({callId: "wacid.revoked", phoneNumberId: "123", event: "connect", from: "+421900000000", timestamp: String(Math.floor(Date.now() / 1_000)), offerSdp: "offer-sdp"});
    await vi.waitFor(() => expect(terminate).toHaveBeenCalledWith("wacid.revoked"));
    expect(accept).not.toHaveBeenCalled();
    expect(startOutput).not.toHaveBeenCalled();
    expect(manager.status()).toEqual([]);
    await manager.stop();
  });

  it("aborts a stuck SDP answer and releases its process slot on shutdown", async () => {
    const peer = {
      answer: vi.fn(() => new Promise<string>(() => undefined)), waitUntilConnected: vi.fn(), startOutput: vi.fn(),
      pushPcm: vi.fn(), clearOutput: vi.fn(), close: vi.fn(), snapshot: vi.fn(),
    };
    const authorization = {authorized: true as const, identityId: "identity-1", identityHandle: "patrik", agentKey: "panda", actorBindingId: "binding-1", authorizationVersion: "v1"};
    const manager = new WhatsAppCallManager({
      connectorKey: "connector-stuck", accountAgentKey: "panda", phoneNumberId: "123", env: {PANDA_LIVE_VOICE_ENABLED: "true"},
      meta: {preAccept: vi.fn(), accept: vi.fn(), reject: vi.fn(async () => undefined), terminate: vi.fn()} as never,
      controls: {failRunningControls: vi.fn(async () => 0)} as never,
      voice: {markConnectorSessionsDisconnected: vi.fn(async () => 0), failConnectorActiveTurns: vi.fn(async () => 0)} as never,
      agents: {getAgent: vi.fn(async () => ({agentKey: "panda", displayName: "Panda", status: "active" as const, liveVoice: "cove", createdAt: 1, updatedAt: 1}))},
      sessions: {getSession: vi.fn(async () => ({id: "session-1", agentKey: "panda", kind: "main" as const, currentThreadId: "thread-1", createdAt: 1, updatedAt: 1}))},
      conversations: {getConversationBinding: vi.fn(async () => ({source: "whatsapp", connectorKey: "connector-stuck", externalConversationId: "421900000000@s.whatsapp.net", sessionId: "session-1", metadata: {channelAuthorization: {identityId: "identity-1", agentKey: "panda", actorBindingId: "binding-1"}}, createdAt: 1, updatedAt: 1}))},
      authorizer: {authorizeActor: vi.fn(async () => authorization), reauthorizeCall: vi.fn(async () => true)},
      createPeer: vi.fn(async () => peer), log: vi.fn(),
    });
    await manager.start();
    manager.onEvent({callId: "wacid.stuck", phoneNumberId: "123", event: "connect", from: "+421900000000", timestamp: String(Math.floor(Date.now() / 1_000)), offerSdp: "offer-sdp"});
    await vi.waitFor(() => expect(peer.answer).toHaveBeenCalledOnce());
    await expect(Promise.race([
      manager.stop().then(() => "stopped"),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 250)),
    ])).resolves.toBe("stopped");
    expect(peer.close).toHaveBeenCalled();
  });

  it("hard-bounds signed connect-event and overflow reject fanout", async () => {
    const reject = vi.fn(async () => undefined);
    const log = vi.fn();
    const manager = new WhatsAppCallManager({
      connectorKey: "connector-flood", accountAgentKey: "panda", phoneNumberId: "123", env: {PANDA_LIVE_VOICE_ENABLED: "false"},
      meta: {preAccept: vi.fn(), accept: vi.fn(), reject, terminate: vi.fn()} as never,
      controls: {failRunningControls: vi.fn(async () => 0)} as never,
      voice: {markConnectorSessionsDisconnected: vi.fn(async () => 0), failConnectorActiveTurns: vi.fn(async () => 0)} as never,
      agents: {} as never, sessions: {} as never, conversations: {} as never,
      authorizer: {authorizeActor: vi.fn(), reauthorizeCall: vi.fn()}, log,
    });
    await manager.start();
    for (let index = 0; index < 121; index += 1) {
      manager.onEvent({
        callId: `wacid.flood.${String(index)}`,
        phoneNumberId: "123",
        event: "connect",
        from: `+421900${String(index).padStart(6, "0")}`,
        timestamp: String(Math.floor(Date.now() / 1_000)),
        offerSdp: "offer-sdp",
      });
    }
    expect(reject).toHaveBeenCalledTimes(24);
    expect(log).toHaveBeenCalledWith("whatsapp_call_event_rate_limited", expect.objectContaining({callId: "wacid.flood.120"}));
    await manager.stop();
  });

  it("does not let one actor consume the connector-wide admission budget", async () => {
    const reject = vi.fn(async () => undefined);
    const log = vi.fn();
    const manager = new WhatsAppCallManager({
      connectorKey: "connector-fair", accountAgentKey: "panda", phoneNumberId: "123", env: {PANDA_LIVE_VOICE_ENABLED: "false"},
      meta: {preAccept: vi.fn(), accept: vi.fn(), reject, terminate: vi.fn()} as never,
      controls: {failRunningControls: vi.fn(async () => 0)} as never,
      voice: {markConnectorSessionsDisconnected: vi.fn(async () => 0), failConnectorActiveTurns: vi.fn(async () => 0)} as never,
      agents: {} as never, sessions: {} as never, conversations: {} as never,
      authorizer: {authorizeActor: vi.fn(), reauthorizeCall: vi.fn()}, log,
    });
    await manager.start();
    const timestamp = String(Math.floor(Date.now() / 1_000));
    for (let index = 0; index < 121; index += 1) {
      manager.onEvent({callId: `wacid.greedy.${String(index)}`, phoneNumberId: "123", event: "connect", from: "+421900000000", timestamp, offerSdp: "offer-sdp"});
    }
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith("whatsapp_call_event_rate_limited", expect.objectContaining({callId: "wacid.greedy.120"})));
    manager.onEvent({callId: "wacid.legitimate", phoneNumberId: "123", event: "connect", from: "+421911111111", timestamp, offerSdp: "offer-sdp"});
    await vi.waitFor(() => expect(reject.mock.calls.some(([callId]) => callId === "wacid.legitimate")).toBe(true));
    expect(log).not.toHaveBeenCalledWith("whatsapp_call_event_rate_limited", expect.objectContaining({callId: "wacid.legitimate"}));
    await manager.stop();
  });
});
