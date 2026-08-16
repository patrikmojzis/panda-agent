import {describe, expect, it, vi} from "vitest";

import {createLiveVoiceRuntimeEventHandler, handleLiveVoiceDelegationRequest} from "../src/integrations/voice/request-handler.js";

function turn() {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    liveVoiceSessionId: "22222222-2222-4222-8222-222222222222",
    providerDelegationId: "delegation-1",
    sourceUtteranceId: "33333333-3333-4333-8333-333333333333",
    sessionId: "session-1",
    agentKey: "panda",
    externalActorId: "user-1",
    prompt: "check the deployment",
    status: "pending" as const,
    createdAt: 1,
    updatedAt: 1,
  };
}

function liveSession() {
  return {id: turn().liveVoiceSessionId, source: "discord", connectorKey: "bot-1", scopeKey: "guild-1", roomKey: "voice-1", sessionId: "session-1", agentKey: "panda", provider: "openai-live", model: "gpt-live-1-codex", state: "connected" as const, healthReasons: [], startedAt: 1, updatedAt: 1};
}

describe("live voice durable handoff", () => {
  it("resolves the current thread and keeps source rendering outside the generic handler", async () => {
    const submitInput = vi.fn(async () => undefined);
    const renderDelegation = vi.fn(() => "source-specific voice instructions");
    const voice = {
      getTurn: vi.fn(async () => turn()),
      getSession: vi.fn(async () => liveSession()),
      markTurnQueued: vi.fn(async () => ({...turn(), status: "queued" as const, threadId: "thread-after-reset"})),
      failTurn: vi.fn(),
    };
    const result = await handleLiveVoiceDelegationRequest({liveVoiceTurnId: turn().id}, {
      voice: voice as never,
      sessions: {getSession: vi.fn(async () => ({id: "session-1", agentKey: "panda", currentThreadId: "thread-after-reset"}))},
      coordinator: {submitInput},
      identityStore: {resolveIdentityBinding: vi.fn(async () => ({identityId: "identity-1"}))},
      renderDelegation,
    });

    expect(result).toMatchObject({threadId: "thread-after-reset", liveVoiceTurnId: turn().id});
    expect(renderDelegation).toHaveBeenCalledWith({liveSession: expect.objectContaining({source: "discord"}), turn: expect.objectContaining({id: turn().id})});
    expect(submitInput).toHaveBeenCalledWith("thread-after-reset", expect.objectContaining({
      source: "discord",
      channelId: "voice-1",
      externalMessageId: turn().id,
      metadata: {liveVoice: expect.objectContaining({liveVoiceTurnId: turn().id, liveVoiceSessionId: liveSession().id, identityId: "identity-1"})},
    }));
    expect((submitInput.mock.calls[0]![1] as {metadata?: unknown}).metadata).not.toHaveProperty("route");
  });

  it("correlates generic metadata with the Panda run and awaits explicit final delivery", async () => {
    const voice = {
      assignTurnsToRun: vi.fn(async () => undefined),
      listRunningTurns: vi.fn(async () => [{...turn(), status: "running", runId: "run-1"}]),
      markTurnsAwaitingFinal: vi.fn(async () => undefined),
      failTurn: vi.fn(async () => undefined),
    };
    const handler = createLiveVoiceRuntimeEventHandler({getVoiceRepo: () => voice as never});
    await handler({type: "inputs_applied", threadId: "thread-1", runId: "run-1", messages: [{id: "input-1", threadId: "thread-1", sequence: 0, origin: "input", source: "discord", createdAt: 1, message: {role: "user", content: [{type: "text", text: "check"}], timestamp: 1}, metadata: {liveVoice: {liveVoiceTurnId: turn().id}}}]});
    await handler({type: "run_finished", threadId: "thread-1", run: {id: "run-1", threadId: "thread-1", status: "completed", startedAt: 1, finishedAt: 2}});
    expect(voice.assignTurnsToRun).toHaveBeenCalledWith([turn().id], "run-1");
    expect(voice.markTurnsAwaitingFinal).toHaveBeenCalledWith("run-1");
    expect(voice.failTurn).not.toHaveBeenCalled();
  });

  it("fails turns when their Panda run fails", async () => {
    const voice = {assignTurnsToRun: vi.fn(), listRunningTurns: vi.fn(async () => [{...turn(), status: "running", runId: "run-1"}]), failTurn: vi.fn(async () => undefined)};
    const handler = createLiveVoiceRuntimeEventHandler({getVoiceRepo: () => voice as never});
    await handler({type: "run_finished", threadId: "thread-1", run: {id: "run-1", threadId: "thread-1", status: "failed", error: "provider failed", startedAt: 1, finishedAt: 2}});
    expect(voice.failTurn).toHaveBeenCalledWith(turn().id, "provider failed");
  });
});
