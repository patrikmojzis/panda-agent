import {CommandStructuredError, commandScopeDenied} from "../../../domain/commands/errors.js";
import type {CommandDescriptor, CommandRequest, RegisteredCommand} from "../../../domain/commands/types.js";
import type {ConnectorAccountListFilter, ConnectorAccountRecord} from "../../../domain/connectors/types.js";
import type {ConversationBinding, ConversationBindingListFilter} from "../../../domain/sessions/conversations/types.js";
import {isJsonObject, type JsonObject} from "../../../lib/json.js";
import {isRecord} from "../../../lib/records.js";
import {DISCORD_SOURCE} from "./config.js";
import type {DiscordVoiceStore} from "./voice-postgres.js";
import {DISCORD_VOICE_MODEL, type DiscordVoiceControlRecord, type DiscordVoiceSessionRecord} from "./voice-types.js";

export const DISCORD_VOICE_JOIN_COMMAND_NAME = "discord.voice.join";
export const DISCORD_VOICE_LEAVE_COMMAND_NAME = "discord.voice.leave";
export const DISCORD_VOICE_STATUS_COMMAND_NAME = "discord.voice.status";

export interface DiscordVoiceCommandServices {
  env: NodeJS.ProcessEnv;
  connectorAccounts: {listAccounts(filter?: ConnectorAccountListFilter): Promise<readonly ConnectorAccountRecord[]>};
  conversations: {listConversationBindings(filter: ConversationBindingListFilter): Promise<readonly ConversationBinding[]>};
  voice: Pick<DiscordVoiceStore, "enqueueControl" | "waitForControl" | "failControl" | "listSessions">;
}

interface VoiceCommandInput {connectorKey?: string; channelId?: string}

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
  throw new CommandStructuredError(failureCode === "session_conflict" ? "conflict" : "command_failed", message, {failureCode, retryable: failureCode === "timeout" || failureCode === "worker_unavailable"});
}

async function runControl(operation: "join" | "leave", input: VoiceCommandInput, request: CommandRequest, services: DiscordVoiceCommandServices): Promise<JsonObject> {
  if (!enabled(services.env)) throw new CommandStructuredError("command_failed", "Discord voice is disabled.", {failureCode: "voice_disabled", retryable: false});
  const connectorKey = await resolveBoundConnector(input, request, services);
  if (operation === "leave" && !input.channelId) {
    const owned = await services.voice.listSessions({sessionId: request.scope.sessionId, connectorKey, activeOnly: true});
    if (owned.length !== 1) {
      throw new CommandStructuredError("conflict", "Discord voice leave is ambiguous; pass --channel or inspect status.", {
        failureCode: "leave_ambiguous", retryable: false, sessions: owned.map(serializeSession),
      });
    }
    input = {...input, channelId: owned[0]!.channelId};
  }
  const control = await services.voice.enqueueControl({connectorKey, operation, sessionId: request.scope.sessionId, agentKey: request.scope.agentKey, channelId: input.channelId});
  let terminal: DiscordVoiceControlRecord;
  try {
    terminal = await services.voice.waitForControl(control.id, 60_000);
  } catch {
    terminal = await services.voice.failControl(control.id, JSON.stringify({failureCode: "timeout", message: "Timed out waiting for the Discord voice worker."}));
  }
  if (terminal.status === "failed") failedControl(terminal);
  return terminal.result ?? {ok: true, connectorKey, channelId: input.channelId ?? null, sessionId: request.scope.sessionId, model: DISCORD_VOICE_MODEL};
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
  usage: "panda discord voice leave [--channel <voice-channel-id>] [--connector <key>]",
  inputModes: ["flags", "json", "stdin", "file"], outputModes: ["json", "text"],
  arguments: [
    {name: "channel", description: "Optional voice channel id.", valueType: "string", valueName: "voice-channel-id"},
    {name: "connector", description: "Discord connector key; inferred when unambiguous.", valueType: "string", valueName: "key"},
    {name: "json", description: "Structured input containing optional channelId and connectorKey.", valueType: "json"},
  ],
  examples: [{description: "Leave the only owned voice session", command: "panda discord voice leave"}],
  requiredCapabilities: [DISCORD_VOICE_LEAVE_COMMAND_NAME], resultShape: {ok: "boolean", state: "disconnected", connectorKey: "string", guildId: "string", channelId: "string", sessionId: "string", model: DISCORD_VOICE_MODEL},
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
  return {descriptor: discordVoiceJoinCommandDescriptor, async execute(request) { return {ok: true, command: DISCORD_VOICE_JOIN_COMMAND_NAME, output: await runControl("join", parseInput(request.input, {channel: "required"}), request, services)}; }};
}

export function createDiscordVoiceLeaveCommand(services: DiscordVoiceCommandServices): RegisteredCommand {
  return {descriptor: discordVoiceLeaveCommandDescriptor, async execute(request) { return {ok: true, command: DISCORD_VOICE_LEAVE_COMMAND_NAME, output: await runControl("leave", parseInput(request.input, {channel: "optional"}), request, services)}; }};
}

export function createDiscordVoiceStatusCommand(services: DiscordVoiceCommandServices): RegisteredCommand {
  return {descriptor: discordVoiceStatusCommandDescriptor, async execute(request) {
    const input = parseInput(request.input, {channel: "forbidden"});
    const connectorKey = await resolveBoundConnector(input, request, services);
    const sessions = await services.voice.listSessions({sessionId: request.scope.sessionId, connectorKey, activeOnly: true});
    return {ok: true, command: DISCORD_VOICE_STATUS_COMMAND_NAME, output: {ok: true, enabled: enabled(services.env), count: sessions.length, sessions: sessions.map(serializeSession)}};
  }};
}
