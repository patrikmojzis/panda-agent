import {describe, expect, it, vi} from "vitest";

import {handleDiscordVoiceDelegationRequest, createDiscordVoiceRuntimeEventHandler} from "../src/integrations/channels/discord/voice-request-handler.js";

function turn() {
  return {
    id: "11111111-1111-1111-1111-111111111111", voiceSessionId: "22222222-2222-2222-2222-222222222222", delegationId: "delegation-1",
    connectorKey: "bot-1", guildId: "guild-1", channelId: "voice-1", sessionId: "session-1", agentKey: "panda",
    externalActorId: "user-1", prompt: "check the deployment", status: "pending" as const, createdAt: 1, updatedAt: 1,
  };
}

describe("Discord voice durable handoff", () => {
  it("resolves the session's current thread at handoff time and does not mutate text route memory", async () => {
    const submitInput = vi.fn(async () => undefined);
    const voice = {getTurn: vi.fn(async () => turn()), markTurnQueued: vi.fn(async () => ({...turn(), status: "queued" as const, threadId: "thread-after-reset"})), failTurn: vi.fn()};
    const result = await handleDiscordVoiceDelegationRequest({voiceTurnId: turn().id}, {
      voice: voice as never,
      sessions: {getSession: vi.fn(async () => ({id: "session-1", agentKey: "panda", currentThreadId: "thread-after-reset"}))},
      coordinator: {submitInput},
      identityStore: {resolveIdentityBinding: vi.fn(async () => ({identityId: "identity-1"}))},
    });
    expect(result).toMatchObject({threadId: "thread-after-reset"});
    expect(submitInput).toHaveBeenCalledWith("thread-after-reset", expect.objectContaining({
      source: "discord", channelId: "voice-1", externalMessageId: turn().id,
      metadata: {discordVoice: expect.objectContaining({voiceTurnId: turn().id, identityId: "identity-1"})},
    }));
    const submitted = submitInput.mock.calls[0]![1] as {metadata?: Record<string, unknown>};
    expect(submitted.metadata).not.toHaveProperty("route");
    expect(JSON.stringify(submitInput.mock.calls[0]![1])).toContain(`discord voice send --turn ${turn().id} --mode progress`);
    expect(JSON.stringify(submitInput.mock.calls[0]![1])).toContain(`discord voice send --turn ${turn().id} --mode final`);
  });

  it("correlates applied inputs to a run and fails a completed turn that omitted explicit final context", async () => {
    const voice = {
      assignTurnsToRun: vi.fn(async () => undefined),
      listRunningTurns: vi.fn(async () => [{...turn(), status: "running", runId: "run-1"}]),
      failTurn: vi.fn(async () => undefined),
    };
    const handler = createDiscordVoiceRuntimeEventHandler({
      getVoiceStore: () => voice as never,
    });
    await handler({type: "inputs_applied", threadId: "thread-1", runId: "run-1", messages: [{id: "input-1", threadId: "thread-1", sequence: 0, origin: "input", source: "discord", createdAt: 1, message: {role: "user", content: [{type: "text", text: "check"}], timestamp: 1}, metadata: {discordVoice: {voiceTurnId: turn().id}}}]});
    await handler({type: "run_finished", threadId: "thread-1", run: {id: "run-1", threadId: "thread-1", status: "completed", startedAt: 1, finishedAt: 2}});
    expect(voice.assignTurnsToRun).toHaveBeenCalledWith([turn().id], "run-1");
    expect(voice.assignTurnsToRun).toHaveBeenCalledOnce();
    expect(voice.failTurn).toHaveBeenCalledWith(turn().id, "Panda completed without sending final Discord voice context.");
  });

  it("marks delegated work failed when its Panda run fails", async () => {
    const voice = {
      assignTurnsToRun: vi.fn(async () => undefined),
      listRunningTurns: vi.fn(async () => [{...turn(), status: "running", runId: "run-1"}]),
      failTurn: vi.fn(async () => undefined),
    };
    const handler = createDiscordVoiceRuntimeEventHandler({getVoiceStore: () => voice as never});

    await handler({type: "run_finished", threadId: "thread-1", run: {id: "run-1", threadId: "thread-1", status: "failed", error: "provider failed", startedAt: 1, finishedAt: 2}});

    expect(voice.failTurn).toHaveBeenCalledWith(turn().id, "provider failed");
  });
});
