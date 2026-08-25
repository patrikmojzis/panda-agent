import {describe, expect, it, vi} from "vitest";

import {LiveVoiceCall} from "../src/integrations/voice/live-call.js";
import type {LiveVoiceProviderCallbacks, LiveVoiceProviderSession} from "../src/integrations/voice/provider.js";

function createHarness(options: {providers?: LiveVoiceProviderSession[]} = {}) {
  const providerCallbacks: LiveVoiceProviderCallbacks[] = [];
  const provider: LiveVoiceProviderSession = {
    connect: vi.fn(async () => undefined), sendAudio: vi.fn(),
    appendDelegationContext: vi.fn(async () => true), appendSessionContext: vi.fn(async () => true), close: vi.fn(),
  };
  const output = {pushPcm: vi.fn(), interrupt: vi.fn(), reset: vi.fn(), getSnapshot: vi.fn(() => ({state: "idle", responseEpoch: 1, queuedMs: 0, overruns: 0}))};
  const turns = new Map<string, Record<string, unknown>>();
  const voice = {
    createOrGetTurnAndEnqueueDelegation: vi.fn(async (input: Record<string, unknown>) => { const turn = {...input, status: "pending", createdAt: 1, updatedAt: 1}; turns.set(String(input.id), turn); return turn; }),
    getTurn: vi.fn(async (id: string) => turns.get(id)),
    reserveFinalDelivery: vi.fn(async (id: string, controlId: string, text: string) => ({turn: {...turns.get(id), status: "final_sending", finalControlId: controlId, finalText: text}, reserved: true})),
    releaseFinalDelivery: vi.fn(async (id: string) => turns.get(id)),
    completeReservedFinal: vi.fn(async (id: string) => ({...turns.get(id), status: "completed"})),
    failTurn: vi.fn(async (id: string, error: string) => {
      const failed = {...turns.get(id), id, status: "failed", error};
      turns.set(id, failed);
      return failed;
    }),
  };
  const onTerminalFailure = vi.fn();
  const call = new LiveVoiceCall({
    liveVoiceSessionId: "22222222-2222-4222-8222-222222222222", sessionId: "session-1", agentKey: "panda",
    voice: voice as never,
    createProvider: (created) => {
      providerCallbacks.push(created);
      return options.providers?.[providerCallbacks.length - 1] ?? provider;
    },
    output, log: vi.fn(), onTerminalFailure,
  });
  return {call, provider, providerCallbacks, output, voice, turns, onTerminalFailure, get callbacks() { return providerCallbacks.at(-1)!; }};
}

describe("LiveVoiceCall", () => {
  it("owns first-speaker arbitration and audible input admission without inferring barge-in", async () => {
    const harness = createHarness();
    await harness.call.start();
    const first = harness.call.beginCapture("user-1", 1);
    expect(first).toMatchObject({status: "accepted"});
    expect(harness.call.beginCapture("user-1", 2)).toMatchObject({status: "continued"});
    expect(harness.call.beginCapture("user-2", 2)).toEqual({status: "overlap"});
    if (first.status !== "accepted") throw new Error("expected accepted utterance");
    expect(harness.call.pushAudio(first.captureId, Buffer.alloc(960))).toBe(false);
    expect(harness.call.pushAudio(first.captureId, Buffer.alloc(960, 1))).toBe(true);
    expect(harness.output.interrupt).not.toHaveBeenCalled();
    expect(harness.provider.sendAudio).toHaveBeenCalledOnce();
    harness.call.endCapture(first.captureId);
    harness.callbacks.onTurnDone({role: "user"});
    expect(harness.call.beginCapture("user-2", 3)).toMatchObject({status: "accepted"});
    await harness.call.close("test_done");
  });

  it("creates one generic durable turn and delivers progress, final, and proactive speech", async () => {
    const harness = createHarness();
    await harness.call.start();
    const utterance = harness.call.beginCapture("user-1");
    if (utterance.status !== "accepted") throw new Error("expected accepted utterance");
    harness.call.pushAudio(utterance.captureId, Buffer.alloc(960, 1));
    harness.call.endCapture(utterance.captureId);
    harness.callbacks.onTurnDone({role: "user", transcript: "check status"});
    await harness.callbacks.onDelegation({id: "delegation-1", prompt: "check status"});
    expect(harness.voice.createOrGetTurnAndEnqueueDelegation).toHaveBeenCalledWith(expect.objectContaining({
      id: expect.any(String),
      sessionId: "session-1",
    }));
    const turnId = String(harness.voice.createOrGetTurnAndEnqueueDelegation.mock.calls[0]![0].id);
    harness.turns.set(turnId, {...harness.turns.get(turnId), status: "running"});
    await expect(harness.call.deliver({controlId: "progress", text: "Working.", mode: "progress", liveVoiceTurnId: turnId})).resolves.toMatchObject({delivery: "delegation"});
    expect(harness.provider.appendDelegationContext).toHaveBeenCalledWith("delegation-1", "Working.", "commentary");
    await expect(harness.call.deliver({controlId: "final", text: "Healthy.", mode: "final", liveVoiceTurnId: turnId})).resolves.toMatchObject({delivery: "delegation"});
    expect(harness.voice.completeReservedFinal).toHaveBeenCalledWith(turnId, "final");
    await expect(harness.call.deliver({controlId: "proactive", text: "One more thing.", mode: "final"})).resolves.toEqual({delivery: "session"});
    expect(harness.provider.appendSessionContext).toHaveBeenCalledWith("One more thing.", "speakable");
  });

  it("retains the delegation binding while atomic persistence retries", async () => {
    const harness = createHarness();
    await harness.call.start();
    const utterance = harness.call.beginCapture("user-1");
    if (utterance.status !== "accepted") throw new Error("expected accepted utterance");
    harness.call.pushAudio(utterance.captureId, Buffer.alloc(960, 1));
    harness.call.endCapture(utterance.captureId);
    harness.callbacks.onTurnDone({role: "user", transcript: "check status"});
    harness.voice.createOrGetTurnAndEnqueueDelegation.mockRejectedValueOnce(Object.assign(
      new Error("connection lost after commit"),
      {code: "08006"},
    ));

    await expect(harness.callbacks.onDelegation({id: "delegation-1", prompt: "check status"}))
      .resolves.toBeUndefined();
    expect(harness.voice.failTurn).not.toHaveBeenCalled();
    expect(harness.voice.createOrGetTurnAndEnqueueDelegation).toHaveBeenCalledTimes(2);
    expect(harness.call.getSnapshot().delegationStatus).toBe("queued");
  });

  it("joins delegation persistence and fails a turn committed during close", async () => {
    const harness = createHarness();
    await harness.call.start();
    const utterance = harness.call.beginCapture("user-1");
    if (utterance.status !== "accepted") throw new Error("expected accepted utterance");
    harness.call.pushAudio(utterance.captureId, Buffer.alloc(960, 1));
    harness.call.endCapture(utterance.captureId);
    harness.callbacks.onTurnDone({role: "user", transcript: "close race"});
    let releasePersistence!: () => void;
    const persistenceBlocked = new Promise<void>((resolve) => { releasePersistence = resolve; });
    harness.voice.createOrGetTurnAndEnqueueDelegation.mockImplementationOnce(async (input: Record<string, unknown>) => {
      await persistenceBlocked;
      const turn = {...input, status: "pending", createdAt: 1, updatedAt: 1};
      harness.turns.set(String(input.id), turn);
      return turn;
    });

    const delegation = harness.callbacks.onDelegation({id: "delegation-close", prompt: "close race"});
    await vi.waitFor(() => expect(harness.voice.createOrGetTurnAndEnqueueDelegation).toHaveBeenCalledOnce());
    let closeFinished = false;
    const closing = harness.call.close("test_close_race").then(() => { closeFinished = true; });
    await Promise.resolve();
    expect(closeFinished).toBe(false);
    releasePersistence();

    await expect(delegation).resolves.toBeUndefined();
    await closing;
    const turnId = String(harness.voice.createOrGetTurnAndEnqueueDelegation.mock.calls[0]![0].id);
    expect(harness.turns.get(turnId)).toMatchObject({status: "failed"});
    expect(harness.call.getSnapshot().delegationStatus).not.toBe("queued");
  });

  it("routes provider audio through the transport-neutral output contract", async () => {
    const harness = createHarness();
    await harness.call.start();
    harness.callbacks.onAudio(Buffer.alloc(960, 1));
    expect(harness.output.pushPcm).toHaveBeenCalledWith(Buffer.alloc(960, 1));
    harness.callbacks.onOutputAudioCleared();
    expect(harness.output.interrupt).toHaveBeenCalled();
    harness.callbacks.onAudio(Buffer.alloc(960, 2));
    expect(harness.output.pushPcm).toHaveBeenLastCalledWith(Buffer.alloc(960, 2));
    expect(harness.call.getSnapshot().providerOutputClears).toBe(1);
  });

  it("keeps same-speaker Discord fragments in one provider turn", async () => {
    const harness = createHarness();
    await harness.call.start();
    const first = harness.call.beginCapture("user-1");
    if (first.status !== "accepted") throw new Error("expected accepted utterance");
    harness.call.pushAudio(first.captureId, Buffer.alloc(960, 1));
    harness.call.endCapture(first.captureId);

    const continuation = harness.call.beginCapture("user-1");
    expect(continuation).toMatchObject({status: "accepted"});
    expect(harness.call.beginCapture("user-2")).toEqual({status: "overlap"});
    if (continuation.status !== "accepted") throw new Error("expected continued utterance");
    harness.call.pushAudio(continuation.captureId, Buffer.alloc(960, 2));
    harness.call.endCapture(continuation.captureId);

    harness.callbacks.onTurnDone({role: "user", transcript: "fragmented request"});
    await harness.callbacks.onDelegation({id: "delegation-fragmented", prompt: "fragmented request"});
    expect(harness.voice.createOrGetTurnAndEnqueueDelegation).toHaveBeenCalledOnce();
    expect(harness.voice.createOrGetTurnAndEnqueueDelegation).toHaveBeenCalledWith(expect.objectContaining({sourceUtteranceId: expect.any(String), externalActorId: "user-1"}));
    expect(harness.call.beginCapture("user-2")).toMatchObject({status: "accepted"});
    await harness.call.close("test_done");
  });

  it("accepts at most one delegation for one logical provider turn", async () => {
    const harness = createHarness();
    await harness.call.start();
    const utterance = harness.call.beginCapture("user-1");
    if (utterance.status !== "accepted") throw new Error("expected accepted utterance");
    harness.call.pushAudio(utterance.captureId, Buffer.alloc(960, 1));
    harness.call.endCapture(utterance.captureId);

    await harness.callbacks.onDelegation({id: "delegation-1", prompt: "check weather"});
    await harness.callbacks.onDelegation({id: "delegation-2", prompt: "check weather"});

    expect(harness.voice.createOrGetTurnAndEnqueueDelegation).toHaveBeenCalledOnce();
    await harness.call.close("test_done");
  });

  it("enforces the channel-neutral utterance rate limit", async () => {
    const harness = createHarness();
    await harness.call.start();
    for (let index = 0; index < 30; index += 1) {
      const utterance = harness.call.beginCapture(`user-${index}`, index);
      expect(utterance.status).toBe("accepted");
      if (utterance.status === "accepted") harness.call.endCapture(utterance.captureId);
    }
    expect(harness.call.beginCapture("user-over", 30)).toEqual({status: "rate_limit"});
    expect(harness.call.beginCapture("user-next-window", 60_001)).toMatchObject({status: "accepted"});
    await harness.call.close("test_done");
  });

  it("reconnects retryable provider failures and fences stale provider events", async () => {
    const first = {connect: vi.fn(async () => undefined), sendAudio: vi.fn(), appendDelegationContext: vi.fn(async () => true), appendSessionContext: vi.fn(async () => true), close: vi.fn()};
    const second = {connect: vi.fn(async () => undefined), sendAudio: vi.fn(), appendDelegationContext: vi.fn(async () => true), appendSessionContext: vi.fn(async () => true), close: vi.fn()};
    const harness = createHarness({providers: [first, second]});
    await harness.call.start();
    harness.providerCallbacks[0]!.onFailure({source: "media", code: "transport_failed", retryable: true, message: "closed"});
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

  it("keeps an active transport capture usable after provider recovery", async () => {
    const first = {connect: vi.fn(async () => undefined), sendAudio: vi.fn(), appendDelegationContext: vi.fn(async () => true), appendSessionContext: vi.fn(async () => true), close: vi.fn()};
    const second = {connect: vi.fn(async () => undefined), sendAudio: vi.fn(), appendDelegationContext: vi.fn(async () => true), appendSessionContext: vi.fn(async () => true), close: vi.fn()};
    const harness = createHarness({providers: [first, second]});
    await harness.call.start();
    const capture = harness.call.beginCapture("user-1");
    if (capture.status !== "accepted") throw new Error("expected accepted capture");
    expect(harness.call.pushAudio(capture.captureId, Buffer.alloc(960, 1))).toBe(true);

    harness.providerCallbacks[0]!.onFailure({source: "media", code: "transport_failed", retryable: true, message: "closed"});
    await vi.waitFor(() => expect(harness.call.getSnapshot().connected).toBe(true));

    expect(harness.call.pushAudio(capture.captureId, Buffer.alloc(960, 2))).toBe(true);
    expect(second.sendAudio).toHaveBeenCalledWith(Buffer.alloc(960, 2));
    harness.call.endCapture(capture.captureId);
    await harness.call.close("test_done");
  });

  it("delivers a pre-recovery durable result through fresh session context", async () => {
    const first = {connect: vi.fn(async () => undefined), sendAudio: vi.fn(), appendDelegationContext: vi.fn(async () => true), appendSessionContext: vi.fn(async () => true), close: vi.fn()};
    const second = {connect: vi.fn(async () => undefined), sendAudio: vi.fn(), appendDelegationContext: vi.fn(async () => true), appendSessionContext: vi.fn(async () => true), close: vi.fn()};
    const harness = createHarness({providers: [first, second]});
    await harness.call.start();
    const capture = harness.call.beginCapture("user-1");
    if (capture.status !== "accepted") throw new Error("expected accepted capture");
    harness.call.pushAudio(capture.captureId, Buffer.alloc(960, 1));
    harness.call.endCapture(capture.captureId);
    harness.providerCallbacks[0]!.onTurnDone({role: "user", transcript: "check weather"});
    await harness.providerCallbacks[0]!.onDelegation({id: "delegation-old", prompt: "check weather"});
    const turnId = String(harness.voice.createOrGetTurnAndEnqueueDelegation.mock.calls[0]![0].id);
    harness.turns.set(turnId, {...harness.turns.get(turnId), status: "running"});

    harness.providerCallbacks[0]!.onFailure({source: "media", code: "transport_failed", retryable: true, message: "closed"});
    await expect(harness.call.deliver({controlId: "final", text: "It is sunny.", mode: "final", liveVoiceTurnId: turnId})).resolves.toMatchObject({delivery: "delegation"});

    expect(harness.call.getSnapshot().connected).toBe(true);
    expect(second.appendDelegationContext).not.toHaveBeenCalled();
    expect(second.appendSessionContext).toHaveBeenCalledWith("It is sunny.", "speakable");
    expect(harness.voice.completeReservedFinal).toHaveBeenCalledWith(turnId, "final");
    await harness.call.close("test_done");
  });

  it("keeps a reserved final across a delivery-triggered provider recovery", async () => {
    const first = {connect: vi.fn(async () => undefined), sendAudio: vi.fn(), appendDelegationContext: vi.fn(async () => true), appendSessionContext: vi.fn(async () => true), close: vi.fn()};
    const second = {connect: vi.fn(async () => undefined), sendAudio: vi.fn(), appendDelegationContext: vi.fn(async () => true), appendSessionContext: vi.fn(async () => true), close: vi.fn()};
    const harness = createHarness({providers: [first, second]});
    await harness.call.start();
    const capture = harness.call.beginCapture("user-1");
    if (capture.status !== "accepted") throw new Error("expected accepted capture");
    harness.call.pushAudio(capture.captureId, Buffer.alloc(960, 1));
    harness.call.endCapture(capture.captureId);
    harness.providerCallbacks[0]!.onTurnDone({role: "user", transcript: "check weather"});
    await harness.providerCallbacks[0]!.onDelegation({id: "delegation-old", prompt: "check weather"});
    const turnId = String(harness.voice.createOrGetTurnAndEnqueueDelegation.mock.calls[0]![0].id);
    harness.turns.set(turnId, {...harness.turns.get(turnId), status: "running"});
    first.appendDelegationContext.mockImplementationOnce(async () => {
      harness.providerCallbacks[0]!.onFailure({source: "sideband", code: "transport_failed", retryable: true, message: "write failed"});
      return false;
    });

    await expect(harness.call.deliver({controlId: "final", text: "It is sunny.", mode: "final", liveVoiceTurnId: turnId})).resolves.toMatchObject({delivery: "delegation"});

    expect(first.appendDelegationContext).toHaveBeenCalledWith("delegation-old", "It is sunny.", "speakable");
    expect(second.appendSessionContext).toHaveBeenCalledWith("It is sunny.", "speakable");
    expect(harness.voice.releaseFinalDelivery).not.toHaveBeenCalled();
    expect(harness.voice.completeReservedFinal).toHaveBeenCalledWith(turnId, "final");
    await harness.call.close("test_done");
  });

  it("recycles a provider that omits turn.done instead of inventing a turn boundary", async () => {
    vi.useFakeTimers();
    const first = {connect: vi.fn(async () => undefined), sendAudio: vi.fn(), appendDelegationContext: vi.fn(async () => true), appendSessionContext: vi.fn(async () => true), close: vi.fn()};
    const second = {connect: vi.fn(async () => undefined), sendAudio: vi.fn(), appendDelegationContext: vi.fn(async () => true), appendSessionContext: vi.fn(async () => true), close: vi.fn()};
    const harness = createHarness({providers: [first, second]});
    await harness.call.start();
    const capture = harness.call.beginCapture("user-1");
    if (capture.status !== "accepted") throw new Error("expected accepted capture");
    harness.call.pushAudio(capture.captureId, Buffer.alloc(960, 1));
    harness.call.endCapture(capture.captureId);

    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.resolve();
    expect(second.connect).toHaveBeenCalledOnce();
    expect(harness.call.getSnapshot()).toMatchObject({connected: true, providerGeneration: 2});
    expect(harness.call.beginCapture("user-2")).toMatchObject({status: "accepted"});
    harness.providerCallbacks[0]!.onTurnDone({role: "user", transcript: "late stale turn"});
    expect(harness.call.getSnapshot().providerGeneration).toBe(2);
    await harness.call.close("test_done");
    vi.useRealTimers();
  });

  it("opens the output circuit after repeated transport failures", async () => {
    const harness = createHarness();
    await harness.call.start();
    for (let index = 0; index < 4; index += 1) harness.call.noteOutputFailure(new Error("speaker failed"));
    expect(harness.onTerminalFailure).toHaveBeenCalledWith("audio_output_failed");
    await harness.call.close("test_done");
  });
});
