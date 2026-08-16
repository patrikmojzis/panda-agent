import {describe, expect, it, vi} from "vitest";

import {LiveVoiceCall} from "../src/integrations/voice/live-call.js";
import type {LiveVoiceProviderCallbacks, LiveVoiceProviderSession} from "../src/integrations/voice/provider.js";

function createHarness(options: {providers?: LiveVoiceProviderSession[]} = {}) {
  const providerCallbacks: LiveVoiceProviderCallbacks[] = [];
  const provider: LiveVoiceProviderSession = {
    connect: vi.fn(async () => undefined), sendAudio: vi.fn(), interrupt: vi.fn(() => providerCallbacks.at(-1)?.onClearAudio()),
    appendDelegationContext: vi.fn(() => true), appendSessionContext: vi.fn(() => true), close: vi.fn(),
  };
  const output = {pushPcm: vi.fn(), interrupt: vi.fn(), reset: vi.fn(), getSnapshot: vi.fn(() => ({state: "idle", responseEpoch: 1, queuedMs: 0, overruns: 0}))};
  const turns = new Map<string, Record<string, unknown>>();
  const voice = {
    createOrGetTurn: vi.fn(async (input: Record<string, unknown>) => { const turn = {...input, status: "pending", createdAt: 1, updatedAt: 1}; turns.set(String(input.id), turn); return {turn, created: true}; }),
    getTurn: vi.fn(async (id: string) => turns.get(id)),
    reserveFinalDelivery: vi.fn(async (id: string, controlId: string, text: string) => ({turn: {...turns.get(id), status: "final_sending", finalControlId: controlId, finalText: text}, reserved: true})),
    releaseFinalDelivery: vi.fn(async (id: string) => turns.get(id)),
    completeReservedFinal: vi.fn(async (id: string) => ({...turns.get(id), status: "completed"})),
    failTurn: vi.fn(async (id: string, error: string) => ({...turns.get(id), status: "failed", error})),
  };
  const requests = {enqueueRequest: vi.fn(async () => ({id: "request-1"}))};
  const onTerminalFailure = vi.fn();
  const call = new LiveVoiceCall({
    liveVoiceSessionId: "22222222-2222-4222-8222-222222222222", sessionId: "session-1", agentKey: "panda",
    voice: voice as never, requests: requests as never,
    createProvider: (created) => {
      providerCallbacks.push(created);
      return options.providers?.[providerCallbacks.length - 1] ?? provider;
    },
    output, log: vi.fn(), onTerminalFailure,
  });
  return {call, provider, providerCallbacks, output, voice, turns, requests, onTerminalFailure, get callbacks() { return providerCallbacks.at(-1)!; }};
}

describe("LiveVoiceCall", () => {
  it("owns first-speaker arbitration, barge-in, and audible input admission", async () => {
    const harness = createHarness();
    await harness.call.start();
    const first = harness.call.beginUtterance("user-1", 1);
    expect(first).toMatchObject({status: "accepted"});
    expect(harness.call.beginUtterance("user-1", 2)).toMatchObject({status: "continued"});
    expect(harness.call.beginUtterance("user-2", 2)).toEqual({status: "overlap"});
    if (first.status !== "accepted") throw new Error("expected accepted utterance");
    expect(harness.call.pushAudio(first.utteranceId, Buffer.alloc(960))).toBe(false);
    expect(harness.call.pushAudio(first.utteranceId, Buffer.alloc(960, 1))).toBe(true);
    expect(harness.provider.interrupt).toHaveBeenCalledOnce();
    expect(harness.output.interrupt).toHaveBeenCalledOnce();
    expect(harness.provider.sendAudio).toHaveBeenCalledOnce();
    harness.call.endUtterance(first.utteranceId);
    expect(harness.call.beginUtterance("user-2", 3)).toMatchObject({status: "accepted"});
    await harness.call.close("test_done");
  });

  it("creates one generic durable turn and delivers progress, final, and proactive speech", async () => {
    const harness = createHarness();
    await harness.call.start();
    const utterance = harness.call.beginUtterance("user-1");
    if (utterance.status !== "accepted") throw new Error("expected accepted utterance");
    harness.call.pushAudio(utterance.utteranceId, Buffer.alloc(960, 1));
    harness.call.endUtterance(utterance.utteranceId);
    harness.callbacks.onTurnDone({role: "user", transcript: "check status"});
    await harness.callbacks.onDelegation({id: "delegation-1", prompt: "check status"});
    expect(harness.requests.enqueueRequest).toHaveBeenCalledWith({kind: "live_voice_delegation", payload: {liveVoiceTurnId: expect.any(String)}}, {idempotencyKey: expect.stringContaining("live_voice_delegation:")});
    const turnId = String(harness.voice.createOrGetTurn.mock.calls[0]![0].id);
    harness.turns.set(turnId, {...harness.turns.get(turnId), status: "running"});
    await expect(harness.call.deliver({controlId: "progress", text: "Working.", mode: "progress", liveVoiceTurnId: turnId})).resolves.toMatchObject({delivery: "delegation"});
    expect(harness.provider.appendDelegationContext).toHaveBeenCalledWith("delegation-1", "Working.", "commentary");
    await expect(harness.call.deliver({controlId: "final", text: "Healthy.", mode: "final", liveVoiceTurnId: turnId})).resolves.toMatchObject({delivery: "delegation"});
    expect(harness.voice.completeReservedFinal).toHaveBeenCalledWith(turnId, "final");
    await expect(harness.call.deliver({controlId: "proactive", text: "One more thing.", mode: "final"})).resolves.toEqual({delivery: "session"});
    expect(harness.provider.appendSessionContext).toHaveBeenCalledWith("One more thing.", "speakable");
  });

  it("routes provider audio through the transport-neutral output contract", async () => {
    const harness = createHarness();
    await harness.call.start();
    harness.callbacks.onAudio(Buffer.alloc(960, 1));
    expect(harness.output.pushPcm).toHaveBeenCalledWith(Buffer.alloc(960, 1));
    harness.callbacks.onClearAudio();
    expect(harness.output.interrupt).toHaveBeenCalled();
  });

  it("enforces the channel-neutral utterance rate limit", async () => {
    const harness = createHarness();
    await harness.call.start();
    for (let index = 0; index < 30; index += 1) {
      const utterance = harness.call.beginUtterance(`user-${index}`, index);
      expect(utterance.status).toBe("accepted");
      if (utterance.status === "accepted") harness.call.endUtterance(utterance.utteranceId);
    }
    expect(harness.call.beginUtterance("user-over", 30)).toEqual({status: "rate_limit"});
    expect(harness.call.beginUtterance("user-next-window", 60_001)).toMatchObject({status: "accepted"});
    await harness.call.close("test_done");
  });

  it("reconnects retryable provider failures and fences stale provider events", async () => {
    const first = {connect: vi.fn(async () => undefined), sendAudio: vi.fn(), interrupt: vi.fn(), appendDelegationContext: vi.fn(() => true), appendSessionContext: vi.fn(() => true), close: vi.fn()};
    const second = {connect: vi.fn(async () => undefined), sendAudio: vi.fn(), interrupt: vi.fn(), appendDelegationContext: vi.fn(() => true), appendSessionContext: vi.fn(() => true), close: vi.fn()};
    const harness = createHarness({providers: [first, second]});
    await harness.call.start();
    harness.providerCallbacks[0]!.onFailure({code: "network_closed", retryable: true, message: "closed"});
    await vi.waitFor(() => expect(second.connect).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(harness.call.getSnapshot().recovering).toBe(false));
    expect(first.close).toHaveBeenCalled();
    expect(harness.call.getSnapshot()).toMatchObject({connected: true, recovering: false, providerGeneration: 2, providerReconnectCount: 1});

    harness.providerCallbacks[0]!.onAudio(Buffer.alloc(960, 1));
    expect(harness.output.pushPcm).not.toHaveBeenCalled();
    harness.providerCallbacks[1]!.onAudio(Buffer.alloc(960, 2));
    expect(harness.output.pushPcm).toHaveBeenCalledWith(Buffer.alloc(960, 2));
    await harness.call.close("test_done");
  });

  it("opens the output circuit after repeated transport failures", async () => {
    const harness = createHarness();
    await harness.call.start();
    for (let index = 0; index < 4; index += 1) harness.call.noteOutputFailure(new Error("speaker failed"));
    expect(harness.onTerminalFailure).toHaveBeenCalledWith("audio_output_failed");
    await harness.call.close("test_done");
  });
});
