import {CommandStructuredError, commandScopeDenied} from "../../../domain/commands/errors.js";
import type {CommandDescriptor, CommandRequest, RegisteredCommand} from "../../../domain/commands/types.js";
import type {ConnectorAccountListFilter, ConnectorAccountRecord} from "../../../domain/connectors/types.js";
import type {ConversationBinding, ConversationBindingListFilter} from "../../../domain/sessions/conversations/types.js";
import {isJsonObject, type JsonObject} from "../../../lib/json.js";
import {isRecord} from "../../../lib/records.js";
import {DISCORD_SOURCE} from "./config.js";
import type {DiscordVoiceStore} from "./voice-postgres.js";
import {DISCORD_VOICE_MODEL, type DiscordVoiceControlInput, type DiscordVoiceControlRecord, type DiscordVoiceSendMode, type DiscordVoiceSessionRecord, type DiscordVoiceTurnRecord} from "./voice-types.js";

export const DISCORD_VOICE_JOIN_COMMAND_NAME = "discord.voice.join";
export const DISCORD_VOICE_LEAVE_COMMAND_NAME = "discord.voice.leave";
export const DISCORD_VOICE_SEND_COMMAND_NAME = "discord.voice.send";
export const DISCORD_VOICE_STATUS_COMMAND_NAME = "discord.voice.status";
const MAX_VOICE_CONTEXT_CHARS = 1_800;

export interface DiscordVoiceCommandServices {
  env: NodeJS.ProcessEnv;
  connectorAccounts: {listAccounts(filter?: ConnectorAccountListFilter): Promise<readonly ConnectorAccountRecord[]>};
  conversations: {listConversationBindings(filter: ConversationBindingListFilter): Promise<readonly ConversationBinding[]>};
  voice: Pick<DiscordVoiceStore, "enqueueControl" | "waitForControl" | "failControl" | "listSessions" | "getTurn" | "listRunningTurns">;
}

interface VoiceCommandInput {connectorKey?: string; channelId?: string}
interface VoiceLeaveCommandInput extends VoiceCommandInput {voiceTurnId?: string}
interface VoiceSendCommandInput extends VoiceCommandInput {text: string; mode: DiscordVoiceSendMode; voiceTurnId?: string}

function normalizeSnowflake(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{1,20}$/.test(value.trim()) || !/[1-9]/.test(value)) {
    throw new Error(`${label} must be a Discord snowflake id.`);
  }
  return value.trim();
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must not be empty.`);
  return value.trim();
}

function optionalVoiceTurnId(value: unknown): string | undefined {
  const voiceTurnId = optionalString(value, "voiceTurnId");
  if (voiceTurnId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(voiceTurnId)) throw new Error("voiceTurnId must be a UUID.");
  return voiceTurnId;
}

function parseInput(input: unknown, options: {channel: "required" | "optional" | "forbidden"}): VoiceCommandInput {
  if (!isRecord(input)) throw new Error("Discord voice command input must be a JSON object.");
  const allowed = new Set(options.channel === "forbidden" ? ["connectorKey"] : ["connectorKey", "channelId"]);
  const unexpected = Object.keys(input).find((key) => !allowed.has(key));
  if (unexpected) throw new Error(`Discord voice command input contains unsupported field ${unexpected}.`);
  const connectorKey = optionalString(input.connectorKey, "connectorKey");
  const channelId = input.channelId === undefined ? undefined : normalizeSnowflake(input.channelId, "channel");
  if (options.channel === "required" && !channelId) throw new Error("discord.voice.join requires --channel <voice-channel-id>.");
  return {...(connectorKey ? {connectorKey} : {}), ...(channelId ? {channelId} : {})};
}

function parseSendInput(input: unknown): VoiceSendCommandInput {
  if (!isRecord(input)) throw new Error("Discord voice command input must be a JSON object.");
  const allowed = new Set(["connectorKey", "channelId", "text", "mode", "voiceTurnId"]);
  const unexpected = Object.keys(input).find((key) => !allowed.has(key));
  if (unexpected) throw new Error(`Discord voice command input contains unsupported field ${unexpected}.`);
  const connectorKey = optionalString(input.connectorKey, "connectorKey");
  const channelId = input.channelId === undefined ? undefined : normalizeSnowflake(input.channelId, "channel");
  const text = optionalString(input.text, "text");
  if (!text) throw new Error("discord.voice.send requires --text <message>.");
  if (text.length > MAX_VOICE_CONTEXT_CHARS) throw new Error(`discord.voice.send text must not exceed ${String(MAX_VOICE_CONTEXT_CHARS)} characters.`);
  const mode = input.mode === undefined ? "final" : input.mode;
  if (mode !== "progress" && mode !== "final") throw new Error("discord.voice.send mode must be progress or final.");
  const voiceTurnId = optionalVoiceTurnId(input.voiceTurnId);
  return {text, mode, ...(connectorKey ? {connectorKey} : {}), ...(channelId ? {channelId} : {}), ...(voiceTurnId ? {voiceTurnId} : {})};
}

function parseLeaveInput(input: unknown): VoiceLeaveCommandInput {
  if (!isRecord(input)) throw new Error("Discord voice command input must be a JSON object.");
  const allowed = new Set(["connectorKey", "channelId", "voiceTurnId"]);
  const unexpected = Object.keys(input).find((key) => !allowed.has(key));
  if (unexpected) throw new Error(`Discord voice command input contains unsupported field ${unexpected}.`);
  const connectorKey = optionalString(input.connectorKey, "connectorKey");
  const channelId = input.channelId === undefined ? undefined : normalizeSnowflake(input.channelId, "channel");
  const voiceTurnId = optionalVoiceTurnId(input.voiceTurnId);
  return {...(connectorKey ? {connectorKey} : {}), ...(channelId ? {channelId} : {}), ...(voiceTurnId ? {voiceTurnId} : {})};
}

function enabled(env: NodeJS.ProcessEnv): boolean {
  return env.PANDA_DISCORD_VOICE_EXPERIMENTAL?.trim().toLowerCase() === "true";
}

async function resolveBoundConnector(
  input: VoiceCommandInput,
  request: CommandRequest,
  services: DiscordVoiceCommandServices,
): Promise<string> {
  const accounts = await services.connectorAccounts.listAccounts({source: DISCORD_SOURCE, status: "enabled"});
  const keys: string[] = [];
  for (const account of accounts) {
    if (input.connectorKey && account.connectorKey !== input.connectorKey) continue;
    const bindings = await services.conversations.listConversationBindings({source: DISCORD_SOURCE, connectorKey: account.connectorKey});
    if (bindings.some((binding) => binding.sessionId === request.scope.sessionId)) keys.push(account.connectorKey);
  }
  if (keys.length === 0) {
    throw commandScopeDenied(
      "Discord voice requires an existing Discord conversation binding for this session.",
      "resource_scope_denied",
      "Bind the invoking session to the Discord connector before joining voice.",
    );
  }
  if (keys.length > 1) throw new CommandStructuredError("conflict", "Multiple Discord connectors are bound; pass --connector <key>.", {failureCode: "connector_ambiguous", retryable: false, connectors: keys});
  return keys[0]!;
}

function serializeSession(session: DiscordVoiceSessionRecord): JsonObject {
  return {
    connectorKey: session.connectorKey,
    guildId: session.guildId,
    channelId: session.channelId,
    sessionId: session.sessionId,
    voiceSessionId: session.voiceSessionId,
    state: session.state,
    model: session.model,
    ...(session.lastError ? {lastError: session.lastError} : {}),
  };
}

function failedControl(control: DiscordVoiceControlRecord): never {
  let failureCode = "worker_failed";
  let message = control.error ?? "Discord voice worker failed the request.";
  try {
    const parsed = JSON.parse(control.error ?? "") as unknown;
    if (isJsonObject(parsed)) {
      if (typeof parsed.failureCode === "string") failureCode = parsed.failureCode;
      if (typeof parsed.message === "string") message = parsed.message;
    }
  } catch { /* stable fallback above */ }
  const conflict = failureCode === "session_conflict" || failureCode.endsWith("_conflict") || failureCode.endsWith("_ambiguous");
  const retryable = failureCode === "timeout" || failureCode === "worker_unavailable" || failureCode === "provider_unavailable";
  throw new CommandStructuredError(conflict ? "conflict" : "command_failed", message, {failureCode, retryable});
}

async function runJoin(input: VoiceCommandInput, request: CommandRequest, services: DiscordVoiceCommandServices): Promise<JsonObject> {
  if (!enabled(services.env)) throw new CommandStructuredError("command_failed", "Discord voice is disabled.", {failureCode: "voice_disabled", retryable: false});
  const connectorKey = await resolveBoundConnector(input, request, services);
  return enqueueAndWait({connectorKey, operation: "join", sessionId: request.scope.sessionId, agentKey: request.scope.agentKey, channelId: input.channelId}, services);
}

async function enqueueAndWait(input: DiscordVoiceControlInput, services: DiscordVoiceCommandServices): Promise<JsonObject> {
  const control = await services.voice.enqueueControl(input);
  let terminal: DiscordVoiceControlRecord;
  try {
    terminal = await services.voice.waitForControl(control.id, 60_000);
  } catch {
    terminal = await services.voice.failControl(control.id, JSON.stringify({failureCode: "timeout", message: "Timed out waiting for the Discord voice worker."}));
  }
  if (terminal.status === "failed") failedControl(terminal);
  return terminal.result ?? {ok: true, connectorKey: input.connectorKey, channelId: input.channelId ?? null, sessionId: input.sessionId, model: DISCORD_VOICE_MODEL};
}

function activeTurn(turn: DiscordVoiceTurnRecord): boolean {
  return turn.status === "pending" || turn.status === "queued" || turn.status === "running";
}

async function resolveActiveTurn(input: {voiceTurnId?: string}, request: CommandRequest, services: DiscordVoiceCommandServices, session: DiscordVoiceSessionRecord): Promise<DiscordVoiceTurnRecord | undefined> {
  if (input.voiceTurnId) {
    const turn = await services.voice.getTurn(input.voiceTurnId).catch(() => undefined);
    if (!turn || !activeTurn(turn) || turn.sessionId !== request.scope.sessionId || turn.agentKey !== request.scope.agentKey || turn.voiceSessionId !== session.voiceSessionId) {
      throw new CommandStructuredError("conflict", "The requested Discord voice turn is not active in this voice session.", {failureCode: "voice_turn_conflict", retryable: false});
    }
    return turn;
  }
  if (!request.scope.runId) return undefined;
  const turns = (await services.voice.listRunningTurns(request.scope.runId))
    .filter((candidate) => candidate.sessionId === request.scope.sessionId && candidate.voiceSessionId === session.voiceSessionId);
  if (turns.length > 1) {
    throw new CommandStructuredError("conflict", "Multiple Discord voice turns belong to this run; pass --turn <voice-turn-id>.", {
      failureCode: "voice_turn_ambiguous", retryable: false, voiceTurnIds: turns.map((candidate) => candidate.id),
    });
  }
  return turns[0];
}

async function runLeave(input: VoiceLeaveCommandInput, request: CommandRequest, services: DiscordVoiceCommandServices): Promise<JsonObject> {
  if (!enabled(services.env)) throw new CommandStructuredError("command_failed", "Discord voice is disabled.", {failureCode: "voice_disabled", retryable: false});
  const connectorKey = await resolveBoundConnector(input, request, services);
  const owned = await services.voice.listSessions({sessionId: request.scope.sessionId, connectorKey, activeOnly: true});
  const matching = input.channelId ? owned.filter((session) => session.channelId === input.channelId) : owned;
  if (input.channelId && matching.length === 0) {
    throw new CommandStructuredError("command_failed", "No owned active Discord voice session matched that channel.", {failureCode: "invalid_channel", retryable: false});
  }
  if (matching.length !== 1) {
    throw new CommandStructuredError("conflict", "Discord voice leave is ambiguous; pass --channel or inspect status.", {
      failureCode: "leave_ambiguous", retryable: false, sessions: matching.map(serializeSession),
    });
  }
  const session = matching[0]!;
  const turn = await resolveActiveTurn(input, request, services, session);
  return enqueueAndWait({connectorKey, operation: "leave", sessionId: request.scope.sessionId, agentKey: request.scope.agentKey, channelId: session.channelId, ...(turn ? {voiceTurnId: turn.id} : {})}, services);
}

async function runSend(input: VoiceSendCommandInput, request: CommandRequest, services: DiscordVoiceCommandServices): Promise<JsonObject> {
  if (!enabled(services.env)) throw new CommandStructuredError("command_failed", "Discord voice is disabled.", {failureCode: "voice_disabled", retryable: false});
  const connectorKey = await resolveBoundConnector(input, request, services);
  const sessions = (await services.voice.listSessions({sessionId: request.scope.sessionId, connectorKey, activeOnly: true}))
    .filter((session) => !input.channelId || session.channelId === input.channelId);
  if (sessions.length === 0) {
    throw new CommandStructuredError("command_failed", "No matching Discord voice session is active; join voice first.", {
      failureCode: "voice_session_unavailable", retryable: false,
    });
  }
  if (sessions.length > 1) {
    throw new CommandStructuredError("conflict", "Discord voice send requires exactly one matching active voice session; pass --channel or inspect status.", {
      failureCode: "voice_session_ambiguous", retryable: false, sessions: sessions.map(serializeSession),
    });
  }
  const session = sessions[0]!;
  const turn = await resolveActiveTurn(input, request, services, session);
  return enqueueAndWait({
    connectorKey, operation: "send", sessionId: request.scope.sessionId, agentKey: request.scope.agentKey,
    channelId: session.channelId, text: input.text, mode: input.mode, ...(turn ? {voiceTurnId: turn.id} : {}),
  }, services);
}

export const discordVoiceJoinCommandDescriptor: CommandDescriptor = {
  name: DISCORD_VOICE_JOIN_COMMAND_NAME,
  summary: "Join a Discord voice channel.",
  description: "Starts an experimental transient GPT-Live voice session owned by the current durable Panda session.",
  usage: "panda discord voice join --channel <voice-channel-id> [--connector <key>]",
  inputModes: ["flags", "json", "stdin", "file"], outputModes: ["json", "text"],
  arguments: [
    {name: "channel", description: "Discord voice channel id.", required: true, valueType: "string", valueName: "voice-channel-id"},
    {name: "connector", description: "Discord connector key; inferred when unambiguous.", valueType: "string", valueName: "key"},
    {name: "json", description: "Structured input containing channelId and optional connectorKey.", valueType: "json"},
  ],
  examples: [{description: "Join voice", command: "panda discord voice join --channel 12345"}],
  requiredCapabilities: [DISCORD_VOICE_JOIN_COMMAND_NAME], resultShape: {ok: "boolean", state: "connected", connectorKey: "string", guildId: "string", channelId: "string", sessionId: "string", model: DISCORD_VOICE_MODEL},
};

export const discordVoiceLeaveCommandDescriptor: CommandDescriptor = {
  name: DISCORD_VOICE_LEAVE_COMMAND_NAME,
  summary: "Leave a Discord voice channel.",
  description: "Stops a transient Discord GPT-Live voice session owned by the current Panda session.",
  usage: "panda discord voice leave [--turn <voice-turn-id>] [--channel <voice-channel-id>] [--connector <key>]",
  inputModes: ["flags", "json", "stdin", "file"], outputModes: ["json", "text"],
  arguments: [
    {name: "channel", description: "Optional voice channel id.", valueType: "string", valueName: "voice-channel-id"},
    {name: "connector", description: "Discord connector key; inferred when unambiguous.", valueType: "string", valueName: "key"},
    {name: "turn", description: "Delegated voice turn completed by leaving; inferred from the current run when unambiguous.", valueType: "string", valueName: "voice-turn-id"},
    {name: "json", description: "Structured input containing optional channelId, connectorKey, and voiceTurnId.", valueType: "json"},
  ],
  examples: [{description: "Leave the only owned voice session", command: "panda discord voice leave"}],
  requiredCapabilities: [DISCORD_VOICE_LEAVE_COMMAND_NAME], resultShape: {ok: "boolean", state: "disconnected", connectorKey: "string", guildId: "string", channelId: "string", sessionId: "string", model: DISCORD_VOICE_MODEL},
};

export const discordVoiceSendCommandDescriptor: CommandDescriptor = {
  name: DISCORD_VOICE_SEND_COMMAND_NAME,
  summary: "Send context to the active Discord voice session.",
  description: "Sends explicit Panda progress or a final answer to GPT-Live. Outside a delegation, the active voice session can speak it proactively.",
  usage: "panda discord voice send --text <message> [--mode progress|final] [--turn <voice-turn-id>] [--channel <voice-channel-id>] [--connector <key>]",
  inputModes: ["flags", "json", "stdin", "file"], outputModes: ["json", "text"],
  arguments: [
    {name: "text", description: "Context for GPT-Live, up to 1800 characters.", required: true, valueType: "string", valueName: "message"},
    {name: "mode", description: "Progress keeps a delegation open; final completes it and is spoken.", valueType: "string", valueName: "progress|final"},
    {name: "turn", description: "Voice turn id; inferred from the current run when unambiguous.", valueType: "string", valueName: "voice-turn-id"},
    {name: "channel", description: "Voice channel id when the session owns more than one.", valueType: "string", valueName: "voice-channel-id"},
    {name: "connector", description: "Discord connector key; inferred when unambiguous.", valueType: "string", valueName: "key"},
    {name: "json", description: "Structured input containing text and optional mode, voiceTurnId, channelId, and connectorKey.", valueType: "json"},
  ],
  examples: [
    {description: "Send progress", command: "panda discord voice send --mode progress --text \"I’m still checking that.\""},
    {description: "Send the final answer", command: "panda discord voice send --mode final --text \"The deployment is healthy.\""},
  ],
  requiredCapabilities: [DISCORD_VOICE_SEND_COMMAND_NAME], resultShape: {ok: "boolean", state: "sent", connectorKey: "string", guildId: "string", channelId: "string", sessionId: "string", model: DISCORD_VOICE_MODEL, mode: "progress|final", delivery: "delegation|session"},
};

export const discordVoiceStatusCommandDescriptor: CommandDescriptor = {
  name: DISCORD_VOICE_STATUS_COMMAND_NAME,
  summary: "Show Discord voice sessions owned by the current session.",
  description: "Returns observable transient Discord voice state without exposing OAuth credentials.",
  usage: "panda discord voice status [--connector <key>]",
  inputModes: ["flags", "json", "stdin", "file"], outputModes: ["json", "text"],
  arguments: [{name: "connector", description: "Optional Discord connector key.", valueType: "string", valueName: "key"}, {name: "json", description: "Structured input containing optional connectorKey.", valueType: "json"}],
  examples: [{description: "Show voice status", command: "panda discord voice status"}],
  requiredCapabilities: [DISCORD_VOICE_STATUS_COMMAND_NAME], resultShape: {ok: "boolean", enabled: "boolean", count: "number", sessions: ["object"]},
};

export function createDiscordVoiceJoinCommand(services: DiscordVoiceCommandServices): RegisteredCommand {
  return {descriptor: discordVoiceJoinCommandDescriptor, async execute(request) { return {ok: true, command: DISCORD_VOICE_JOIN_COMMAND_NAME, output: await runJoin(parseInput(request.input, {channel: "required"}), request, services)}; }};
}

export function createDiscordVoiceLeaveCommand(services: DiscordVoiceCommandServices): RegisteredCommand {
  return {descriptor: discordVoiceLeaveCommandDescriptor, async execute(request) { return {ok: true, command: DISCORD_VOICE_LEAVE_COMMAND_NAME, output: await runLeave(parseLeaveInput(request.input), request, services)}; }};
}

export function createDiscordVoiceSendCommand(services: DiscordVoiceCommandServices): RegisteredCommand {
  return {descriptor: discordVoiceSendCommandDescriptor, async execute(request) { return {ok: true, command: DISCORD_VOICE_SEND_COMMAND_NAME, output: await runSend(parseSendInput(request.input), request, services)}; }};
}

export function createDiscordVoiceStatusCommand(services: DiscordVoiceCommandServices): RegisteredCommand {
  return {descriptor: discordVoiceStatusCommandDescriptor, async execute(request) {
    const input = parseInput(request.input, {channel: "forbidden"});
    const connectorKey = await resolveBoundConnector(input, request, services);
    const sessions = await services.voice.listSessions({sessionId: request.scope.sessionId, connectorKey, activeOnly: true});
    return {ok: true, command: DISCORD_VOICE_STATUS_COMMAND_NAME, output: {ok: true, enabled: enabled(services.env), count: sessions.length, sessions: sessions.map(serializeSession)}};
  }};
}
