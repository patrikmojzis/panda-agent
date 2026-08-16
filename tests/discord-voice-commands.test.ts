import {describe, expect, it, vi} from "vitest";

import {CommandStructuredError} from "../src/domain/commands/errors.js";
import {
  createDiscordVoiceJoinCommand,
  createDiscordVoiceLeaveCommand,
  createDiscordVoiceSendCommand,
  createDiscordVoiceStatusCommand,
  type DiscordVoiceCommandServices,
} from "../src/integrations/channels/discord/voice-commands.js";

function services(options: {enabled?: boolean; connectors?: string[]; sessions?: unknown[]; turns?: unknown[]} = {}): DiscordVoiceCommandServices {
  const connectors = options.connectors ?? ["bot-1"];
  return {
    env: {PANDA_DISCORD_VOICE_EXPERIMENTAL: options.enabled === false ? "false" : "true"},
    connectorAccounts: {listAccounts: vi.fn(async () => connectors.map((connectorKey, index) => ({id: `a-${index}`, source: "discord", accountKey: `account-${index}`, connectorKey, ownerKind: "system" as const, ownerIdentityId: null, ownerAgentKey: null, status: "enabled" as const, config: {}, createdAt: 1, updatedAt: 1})))},
    conversations: {listConversationBindings: vi.fn(async ({connectorKey}) => [{source: "discord", connectorKey, externalConversationId: "text-1", sessionId: "session-1", createdAt: 1, updatedAt: 1}])},
    voice: {
      controls: {
        enqueueControl: vi.fn(async (input) => ({...input, id: "control-1", status: "pending" as const, createdAt: 1, updatedAt: 1})),
        waitForControl: vi.fn(async () => ({id: "control-1", connectorKey: "bot-1", operation: "join" as const, sessionId: "session-1", agentKey: "panda", channelId: "12345", status: "completed" as const, result: {ok: true, state: "connected", connectorKey: "bot-1", guildId: "guild-1", channelId: "12345", sessionId: "session-1", model: "gpt-live-1-codex"}, createdAt: 1, updatedAt: 2})),
      },
      live: {
        listSessions: vi.fn(async () => options.sessions ?? [] as never),
        getTurn: vi.fn(async (id: string) => (options.turns ?? []).find((turn) => (turn as {id?: string}).id === id) as never),
        listRunningTurns: vi.fn(async () => options.turns ?? [] as never),
      },
    },
  };
}

const scope = {agentKey: "panda", sessionId: "session-1"};
const defaultLiveSessionId = "22222222-2222-4222-8222-222222222222";

function liveSession(id = defaultLiveSessionId, diagnostics?: Record<string, unknown>) {
  return {id, source: "discord", connectorKey: "bot-1", scopeKey: "guild-1", roomKey: "12345", sessionId: "session-1", agentKey: "panda", provider: "openai-live", state: "connected", model: "gpt-live-1-codex", healthReasons: [], ...(diagnostics ? {diagnostics} : {}), startedAt: 1, updatedAt: 1};
}

function liveTurn(session: ReturnType<typeof liveSession>, prompt: string) {
  return {id: "11111111-1111-4111-8111-111111111111", liveVoiceSessionId: session.id, providerDelegationId: "delegation-1", sourceUtteranceId: "33333333-3333-4333-8333-333333333333", sessionId: "session-1", agentKey: "panda", prompt, status: "running", runId: "run-1", createdAt: 1, updatedAt: 1};
}

describe("Discord voice commands", () => {
  it("infers the only bound connector and binds join to the durable session", async () => {
    const deps = services();
    const result = await createDiscordVoiceJoinCommand(deps).execute({command: "discord.voice.join", input: {channelId: "12345"}, scope});
    expect(deps.voice.controls.enqueueControl).toHaveBeenCalledWith({connectorKey: "bot-1", operation: "join", sessionId: "session-1", agentKey: "panda", channelId: "12345"});
    expect(result.output).toMatchObject({state: "connected", model: "gpt-live-1-codex"});
  });

  it("derives a stable control idempotency key from the parent tool call", async () => {
    const deps = services();
    const request = {command: "discord.voice.join" as const, input: {channelId: "12345"}, scope: {...scope, parentToolCallId: "tool-call-1"}};

    await createDiscordVoiceJoinCommand(deps).execute(request);
    await createDiscordVoiceJoinCommand(deps).execute(request);

    const first = vi.mocked(deps.voice.controls.enqueueControl).mock.calls[0]![0];
    const second = vi.mocked(deps.voice.controls.enqueueControl).mock.calls[1]![0];
    expect(first.idempotencyKey).toMatch(/^discord_voice:session-1:tool-call-1:/);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
  });

  it("requires connector selection when more than one bound Discord connector matches", async () => {
    const command = createDiscordVoiceJoinCommand(services({connectors: ["bot-1", "bot-2"]}));
    await expect(command.execute({command: "discord.voice.join", input: {channelId: "12345"}, scope})).rejects.toMatchObject({pandaCommandErrorCode: "conflict", pandaCommandErrorDetails: {failureCode: "connector_ambiguous"}});
  });

  it("returns a stable disabled failure", async () => {
    await expect(createDiscordVoiceJoinCommand(services({enabled: false})).execute({command: "discord.voice.join", input: {channelId: "12345"}, scope})).rejects.toEqual(expect.objectContaining<Partial<CommandStructuredError>>({pandaCommandErrorCode: "command_failed", pandaCommandErrorDetails: {failureCode: "voice_disabled", retryable: false}}));
  });

  it("leaves durable control state authoritative when the local waiter times out", async () => {
    const deps = services();
    vi.mocked(deps.voice.controls.waitForControl).mockRejectedValueOnce(new Error("timeout"));
    await expect(createDiscordVoiceJoinCommand(deps).execute({command: "discord.voice.join", input: {channelId: "12345"}, scope}))
      .rejects.toMatchObject({pandaCommandErrorDetails: {failureCode: "timeout", retryable: true}});
  });

  it("rejects channel-less leave when there is not exactly one owned session", async () => {
    await expect(createDiscordVoiceLeaveCommand(services()).execute({command: "discord.voice.leave", input: {}, scope})).rejects.toMatchObject({pandaCommandErrorCode: "conflict", pandaCommandErrorDetails: {failureCode: "leave_ambiguous"}});
  });

  it("preserves invalid-channel semantics for an explicit leave target", async () => {
    const session = liveSession();
    await expect(createDiscordVoiceLeaveCommand(services({sessions: [session]})).execute({command: "discord.voice.leave", input: {channelId: "99999"}, scope}))
      .rejects.toMatchObject({pandaCommandErrorCode: "command_failed", pandaCommandErrorDetails: {failureCode: "invalid_channel", retryable: false}});
  });

  it("completes the current delegated turn by leaving its voice session", async () => {
    const session = liveSession();
    const turn = liveTurn(session, "leave voice");
    const deps = services({sessions: [session], turns: [turn]});

    await createDiscordVoiceLeaveCommand(deps).execute({command: "discord.voice.leave", input: {}, scope: {...scope, runId: "run-1"}});

    expect(deps.voice.controls.enqueueControl).toHaveBeenCalledWith({connectorKey: "bot-1", operation: "leave", sessionId: "session-1", agentKey: "panda", channelId: "12345", voiceTurnId: turn.id});
  });

  it("reports only sessions owned by the invoking durable session", async () => {
    const session = liveSession("11111111-1111-1111-1111-111111111111", {version: 1, playback: {phase: "listening"}});
    const result = await createDiscordVoiceStatusCommand(services({sessions: [session]})).execute({command: "discord.voice.status", input: {}, scope});
    expect(result.output).toMatchObject({enabled: true, count: 1, sessions: [{guildId: "guild-1", channelId: "12345", diagnostics: {playback: {phase: "listening"}}}]});
  });

  it("sends delegated progress through the active voice session and infers the turn from the run", async () => {
    const session = liveSession();
    const turn = liveTurn(session, "check");
    const deps = services({sessions: [session], turns: [turn]});

    await createDiscordVoiceSendCommand(deps).execute({command: "discord.voice.send", input: {text: "Still checking.", mode: "progress"}, scope: {...scope, runId: "run-1"}});

    expect(deps.voice.controls.enqueueControl).toHaveBeenCalledWith({connectorKey: "bot-1", operation: "send", sessionId: "session-1", agentKey: "panda", channelId: "12345", text: "Still checking.", mode: "progress", voiceTurnId: turn.id});
  });

  it("allows proactive session speech when the current run has no voice delegation", async () => {
    const session = liveSession();
    const deps = services({sessions: [session]});

    await createDiscordVoiceSendCommand(deps).execute({command: "discord.voice.send", input: {text: "Quick update."}, scope: {...scope, runId: "run-2"}});

    expect(deps.voice.controls.enqueueControl).toHaveBeenCalledWith({connectorKey: "bot-1", operation: "send", sessionId: "session-1", agentKey: "panda", channelId: "12345", text: "Quick update.", mode: "final"});
  });

  it("returns stable failures for a missing voice session and an unknown explicit turn", async () => {
    await expect(createDiscordVoiceSendCommand(services()).execute({command: "discord.voice.send", input: {text: "Update."}, scope}))
      .rejects.toMatchObject({pandaCommandErrorCode: "command_failed", pandaCommandErrorDetails: {failureCode: "voice_session_unavailable", retryable: false}});

    const session = liveSession();
    await expect(createDiscordVoiceSendCommand(services({sessions: [session]})).execute({command: "discord.voice.send", input: {text: "Update.", voiceTurnId: "11111111-1111-4111-8111-111111111111"}, scope}))
      .rejects.toMatchObject({pandaCommandErrorCode: "conflict", pandaCommandErrorDetails: {failureCode: "voice_turn_conflict", retryable: false}});
  });
});
