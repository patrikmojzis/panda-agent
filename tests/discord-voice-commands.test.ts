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
      enqueueControl: vi.fn(async (input) => ({...input, id: "control-1", status: "pending" as const, createdAt: 1, updatedAt: 1})),
      waitForControl: vi.fn(async () => ({id: "control-1", connectorKey: "bot-1", operation: "join" as const, sessionId: "session-1", agentKey: "panda", channelId: "12345", status: "completed" as const, result: {ok: true, state: "connected", connectorKey: "bot-1", guildId: "guild-1", channelId: "12345", sessionId: "session-1", model: "gpt-live-1-codex"}, createdAt: 1, updatedAt: 2})),
      failControl: vi.fn(async () => ({id: "control-1", connectorKey: "bot-1", operation: "join" as const, sessionId: "session-1", agentKey: "panda", channelId: "12345", status: "failed" as const, error: JSON.stringify({failureCode: "timeout", message: "Timed out waiting for the Discord voice worker."}), createdAt: 1, updatedAt: 2})),
      listSessions: vi.fn(async () => options.sessions ?? []),
      getTurn: vi.fn(async (id: string) => (options.turns ?? []).find((turn) => (turn as {id?: string}).id === id) as never),
      listRunningTurns: vi.fn(async () => options.turns ?? [] as never),
    },
  };
}

const scope = {agentKey: "panda", sessionId: "session-1"};

describe("Discord voice commands", () => {
  it("infers the only bound connector and binds join to the durable session", async () => {
    const deps = services();
    const result = await createDiscordVoiceJoinCommand(deps).execute({command: "discord.voice.join", input: {channelId: "12345"}, scope});
    expect(deps.voice.enqueueControl).toHaveBeenCalledWith({connectorKey: "bot-1", operation: "join", sessionId: "session-1", agentKey: "panda", channelId: "12345"});
    expect(result.output).toMatchObject({state: "connected", model: "gpt-live-1-codex"});
  });

  it("requires connector selection when more than one bound Discord connector matches", async () => {
    const command = createDiscordVoiceJoinCommand(services({connectors: ["bot-1", "bot-2"]}));
    await expect(command.execute({command: "discord.voice.join", input: {channelId: "12345"}, scope})).rejects.toMatchObject({pandaCommandErrorCode: "conflict", pandaCommandErrorDetails: {failureCode: "connector_ambiguous"}});
  });

  it("returns a stable disabled failure", async () => {
    await expect(createDiscordVoiceJoinCommand(services({enabled: false})).execute({command: "discord.voice.join", input: {channelId: "12345"}, scope})).rejects.toEqual(expect.objectContaining<Partial<CommandStructuredError>>({pandaCommandErrorCode: "command_failed", pandaCommandErrorDetails: {failureCode: "voice_disabled", retryable: false}}));
  });

  it("terminally fails a timed-out control so the worker cannot complete it later", async () => {
    const deps = services();
    vi.mocked(deps.voice.waitForControl).mockRejectedValueOnce(new Error("timeout"));
    await expect(createDiscordVoiceJoinCommand(deps).execute({command: "discord.voice.join", input: {channelId: "12345"}, scope}))
      .rejects.toMatchObject({pandaCommandErrorDetails: {failureCode: "timeout", retryable: true}});
    expect(deps.voice.failControl).toHaveBeenCalledWith("control-1", expect.stringContaining('"failureCode":"timeout"'));
  });

  it("rejects channel-less leave when there is not exactly one owned session", async () => {
    await expect(createDiscordVoiceLeaveCommand(services()).execute({command: "discord.voice.leave", input: {}, scope})).rejects.toMatchObject({pandaCommandErrorCode: "conflict", pandaCommandErrorDetails: {failureCode: "leave_ambiguous"}});
  });

  it("reports only sessions owned by the invoking durable session", async () => {
    const session = {connectorKey: "bot-1", guildId: "guild-1", channelId: "12345", sessionId: "session-1", agentKey: "panda", voiceSessionId: "11111111-1111-1111-1111-111111111111", state: "connected", model: "gpt-live-1-codex", startedAt: 1, updatedAt: 1};
    const result = await createDiscordVoiceStatusCommand(services({sessions: [session]})).execute({command: "discord.voice.status", input: {}, scope});
    expect(result.output).toMatchObject({enabled: true, count: 1, sessions: [{guildId: "guild-1", channelId: "12345"}]});
  });

  it("sends delegated progress through the active voice session and infers the turn from the run", async () => {
    const session = {connectorKey: "bot-1", guildId: "guild-1", channelId: "12345", sessionId: "session-1", agentKey: "panda", voiceSessionId: "22222222-2222-4222-8222-222222222222", state: "connected", model: "gpt-live-1-codex", startedAt: 1, updatedAt: 1};
    const turn = {id: "11111111-1111-4111-8111-111111111111", voiceSessionId: session.voiceSessionId, delegationId: "delegation-1", connectorKey: "bot-1", guildId: "guild-1", channelId: "12345", sessionId: "session-1", agentKey: "panda", prompt: "check", status: "running", runId: "run-1", createdAt: 1, updatedAt: 1};
    const deps = services({sessions: [session], turns: [turn]});

    await createDiscordVoiceSendCommand(deps).execute({command: "discord.voice.send", input: {text: "Still checking.", mode: "progress"}, scope: {...scope, runId: "run-1"}});

    expect(deps.voice.enqueueControl).toHaveBeenCalledWith({connectorKey: "bot-1", operation: "send", sessionId: "session-1", agentKey: "panda", channelId: "12345", text: "Still checking.", mode: "progress", voiceTurnId: turn.id});
  });

  it("allows proactive session speech when the current run has no voice delegation", async () => {
    const session = {connectorKey: "bot-1", guildId: "guild-1", channelId: "12345", sessionId: "session-1", agentKey: "panda", voiceSessionId: "22222222-2222-4222-8222-222222222222", state: "connected", model: "gpt-live-1-codex", startedAt: 1, updatedAt: 1};
    const deps = services({sessions: [session]});

    await createDiscordVoiceSendCommand(deps).execute({command: "discord.voice.send", input: {text: "Quick update."}, scope: {...scope, runId: "run-2"}});

    expect(deps.voice.enqueueControl).toHaveBeenCalledWith({connectorKey: "bot-1", operation: "send", sessionId: "session-1", agentKey: "panda", channelId: "12345", text: "Quick update.", mode: "final"});
  });

  it("returns stable failures for a missing voice session and an unknown explicit turn", async () => {
    await expect(createDiscordVoiceSendCommand(services()).execute({command: "discord.voice.send", input: {text: "Update."}, scope}))
      .rejects.toMatchObject({pandaCommandErrorCode: "command_failed", pandaCommandErrorDetails: {failureCode: "voice_session_unavailable", retryable: false}});

    const session = {connectorKey: "bot-1", guildId: "guild-1", channelId: "12345", sessionId: "session-1", agentKey: "panda", voiceSessionId: "22222222-2222-4222-8222-222222222222", state: "connected", model: "gpt-live-1-codex", startedAt: 1, updatedAt: 1};
    await expect(createDiscordVoiceSendCommand(services({sessions: [session]})).execute({command: "discord.voice.send", input: {text: "Update.", voiceTurnId: "11111111-1111-4111-8111-111111111111"}, scope}))
      .rejects.toMatchObject({pandaCommandErrorCode: "conflict", pandaCommandErrorDetails: {failureCode: "voice_turn_conflict", retryable: false}});
  });
});
