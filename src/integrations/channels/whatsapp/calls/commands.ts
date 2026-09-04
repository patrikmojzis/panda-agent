import {createHash} from "node:crypto";

import {CommandStructuredError, commandScopeDenied} from "../../../../domain/commands/errors.js";
import type {CommandDescriptor, CommandRequest, RegisteredCommand} from "../../../../domain/commands/types.js";
import type {ConnectorAccountRecord} from "../../../../domain/connectors/types.js";
import type {LiveVoiceRepo} from "../../../../domain/live-voice/repo.js";
import {isActiveLiveVoiceTurn, LiveVoiceTurnNotFoundError, type LiveVoiceSessionRecord} from "../../../../domain/live-voice/types.js";
import type {ConversationBinding} from "../../../../domain/sessions/conversations/types.js";
import {isJsonObject, type JsonObject} from "../../../../lib/json.js";
import {isRecord} from "../../../../lib/records.js";
import {isLiveVoiceEnabled} from "../../../voice/config.js";
import {VoiceControlWaitTimeoutError, voiceStateUnavailable} from "../../../voice/control-errors.js";
import {WHATSAPP_SOURCE} from "../config.js";
import {parseWhatsAppMetaCallingConfig} from "./config.js";
import type {WhatsAppCallControlRepo} from "./postgres.js";
import type {WhatsAppCallControlInput, WhatsAppCallControlRecord, WhatsAppCallSendMode} from "./types.js";

export const WHATSAPP_CALL_STATUS_COMMAND_NAME = "whatsapp.call.status";
export const WHATSAPP_CALL_SEND_COMMAND_NAME = "whatsapp.call.send";
export const WHATSAPP_CALL_HANGUP_COMMAND_NAME = "whatsapp.call.hangup";
const MAX_TEXT_CHARS = 1_800;

export interface WhatsAppCallCommandServices {
  env: NodeJS.ProcessEnv;
  connectorAccounts: {listAccounts(filter?: {source?: string; status?: string}): Promise<readonly ConnectorAccountRecord[]>};
  conversations: {listConversationBindings(filter: {source: string; connectorKey: string}): Promise<readonly ConversationBinding[]>};
  calls: {
    controls: Pick<WhatsAppCallControlRepo, "enqueueControl" | "waitForControl">;
    live: Pick<LiveVoiceRepo, "listSessions" | "getTurn" | "listRunningTurns">;
  };
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must not be empty.`);
  return value.trim();
}

function parseInput(value: unknown, operation: "status" | "send" | "hangup"): {connectorKey?: string; callId?: string; text?: string; mode?: WhatsAppCallSendMode; voiceTurnId?: string} {
  if (!isRecord(value)) throw new Error("WhatsApp call command input must be a JSON object.");
  const allowed = new Set(operation === "status" ? ["connectorKey"] : operation === "send" ? ["connectorKey", "callId", "text", "mode", "voiceTurnId"] : ["connectorKey", "callId", "voiceTurnId"]);
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected) throw new Error(`WhatsApp call command input contains unsupported field ${unexpected}.`);
  const connectorKey = optionalString(value.connectorKey, "connectorKey");
  const callId = optionalString(value.callId, "callId");
  if (callId && !/^[A-Za-z0-9._:-]{1,256}$/.test(callId)) throw new Error("callId is invalid.");
  const voiceTurnId = optionalString(value.voiceTurnId, "voiceTurnId");
  if (voiceTurnId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(voiceTurnId)) throw new Error("voiceTurnId must be a UUID.");
  const text = optionalString(value.text, "text");
  if (operation === "send" && !text) throw new Error("whatsapp.call.send requires --text <message>.");
  if (text && text.length > MAX_TEXT_CHARS) throw new Error(`WhatsApp call text must not exceed ${MAX_TEXT_CHARS} characters.`);
  const mode = value.mode === undefined ? "final" : value.mode;
  if (operation === "send" && mode !== "progress" && mode !== "final") throw new Error("WhatsApp call mode must be progress or final.");
  return {...(connectorKey ? {connectorKey} : {}), ...(callId ? {callId} : {}), ...(text ? {text} : {}), ...(operation === "send" ? {mode: mode as WhatsAppCallSendMode} : {}), ...(voiceTurnId ? {voiceTurnId} : {})};
}

async function connector(input: {connectorKey?: string}, request: CommandRequest, services: WhatsAppCallCommandServices): Promise<string> {
  const accounts = await services.connectorAccounts.listAccounts({source: WHATSAPP_SOURCE, status: "enabled"});
  const keys: string[] = [];
  for (const account of accounts) {
    if (account.ownerKind !== "agent" || account.ownerAgentKey !== request.scope.agentKey) continue;
    if (!parseWhatsAppMetaCallingConfig(account)) continue;
    if (input.connectorKey && input.connectorKey !== account.connectorKey) continue;
    const bindings = await services.conversations.listConversationBindings({source: WHATSAPP_SOURCE, connectorKey: account.connectorKey});
    if (bindings.some((binding) => binding.sessionId === request.scope.sessionId)) keys.push(account.connectorKey);
  }
  if (keys.length === 0) throw commandScopeDenied("WhatsApp calls require an existing WhatsApp conversation binding for this session.", "resource_scope_denied", "Bind the invoking session to the WhatsApp Cloud Calling connector first.");
  if (keys.length > 1) throw new CommandStructuredError("conflict", "Multiple WhatsApp connectors are bound; pass --connector <key>.", {failureCode: "connector_ambiguous", retryable: false, connectors: keys});
  return keys[0]!;
}

function serialize(session: LiveVoiceSessionRecord): JsonObject {
  return {connectorKey: session.connectorKey, callId: session.scopeKey, sessionId: session.sessionId, voiceSessionId: session.id, state: session.state, model: session.model, voice: session.voice ?? null, health: session.health ?? "connecting", healthReasons: [...session.healthReasons], diagnostics: session.diagnostics ?? null, ...(session.lastError ? {lastError: session.lastError} : {})};
}

function idempotent(input: WhatsAppCallControlInput, request: CommandRequest): WhatsAppCallControlInput {
  if (!request.scope.parentToolCallId) return input;
  const digest = createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 24);
  return {...input, idempotencyKey: `whatsapp_call:${request.scope.sessionId}:${request.scope.parentToolCallId}:${digest}`};
}

function failed(control: WhatsAppCallControlRecord): never {
  let failureCode = "worker_failed"; let message = control.error ?? "WhatsApp call worker failed the request.";
  try { const parsed = JSON.parse(control.error ?? "") as unknown; if (isJsonObject(parsed)) { if (typeof parsed.failureCode === "string") failureCode = parsed.failureCode; if (typeof parsed.message === "string") message = parsed.message; } } catch { /* stable fallback */ }
  throw new CommandStructuredError(failureCode.includes("conflict") ? "conflict" : "command_failed", message, {failureCode, retryable: failureCode === "provider_unavailable" || failureCode === "worker_unavailable"});
}

async function enqueue(input: WhatsAppCallControlInput, request: CommandRequest, services: WhatsAppCallCommandServices): Promise<JsonObject> {
  const control = await services.calls.controls.enqueueControl(idempotent(input, request));
  let result: WhatsAppCallControlRecord;
  try { result = await services.calls.controls.waitForControl(control.id, {timeoutMs: 60_000, signal: request.signal}); }
  catch (error) {
    const aborted = request.signal?.aborted === true && error === request.signal.reason;
    if (!aborted && !(error instanceof VoiceControlWaitTimeoutError)) throw voiceStateUnavailable(error, control.id);
    throw new CommandStructuredError("command_failed", aborted ? "WhatsApp call command was cancelled." : "Timed out waiting for the WhatsApp call worker.", {failureCode: aborted ? "worker_unavailable" : "timeout", retryable: true, controlId: control.id});
  }
  if (result.status === "failed") failed(result);
  return result.result ?? {ok: true};
}

async function active(input: {callId?: string}, request: CommandRequest, services: WhatsAppCallCommandServices, connectorKey: string): Promise<LiveVoiceSessionRecord> {
  const sessions = (await services.calls.live.listSessions({sessionId: request.scope.sessionId, source: WHATSAPP_SOURCE, connectorKey, activeOnly: true})).filter((session) => !input.callId || session.scopeKey === input.callId);
  if (sessions.length === 0) throw new CommandStructuredError("command_failed", "No matching WhatsApp call is active.", {failureCode: "call_unavailable", retryable: false});
  if (sessions.length > 1) throw new CommandStructuredError("conflict", "Multiple WhatsApp calls are active; pass --call <id>.", {failureCode: "call_ambiguous", retryable: false, calls: sessions.map(serialize)});
  return sessions[0]!;
}

async function turn(input: {voiceTurnId?: string}, request: CommandRequest, services: WhatsAppCallCommandServices, session: LiveVoiceSessionRecord): Promise<string | undefined> {
  if (input.voiceTurnId) {
    const value = await services.calls.live.getTurn(input.voiceTurnId).catch((error: unknown) => {
      if (error instanceof LiveVoiceTurnNotFoundError) return undefined;
      throw voiceStateUnavailable(error);
    });
    if (!value || !isActiveLiveVoiceTurn(value) || value.liveVoiceSessionId !== session.id || value.sessionId !== request.scope.sessionId) throw new CommandStructuredError("conflict", "The WhatsApp voice turn is not active in this call.", {failureCode: "voice_turn_conflict", retryable: false});
    return value.id;
  }
  if (!request.scope.runId) return undefined;
  const values = (await services.calls.live.listRunningTurns(request.scope.runId)).filter((value) => value.liveVoiceSessionId === session.id);
  if (values.length > 1) throw new CommandStructuredError("conflict", "Multiple WhatsApp voice turns belong to this run; pass --turn <id>.", {failureCode: "voice_turn_ambiguous", retryable: false});
  return values[0]?.id;
}

function ensureEnabled(services: WhatsAppCallCommandServices): void {
  if (!isLiveVoiceEnabled(services.env)) throw new CommandStructuredError("command_failed", "Live voice is disabled.", {failureCode: "voice_disabled", retryable: false});
}

export const whatsappCallStatusCommandDescriptor: CommandDescriptor = {name: WHATSAPP_CALL_STATUS_COMMAND_NAME, summary: "Inspect active WhatsApp calls.", description: "Shows transient live calls owned by the current Panda session.", usage: "panda whatsapp call status [--connector <key>]", inputModes: ["flags", "json", "stdin", "file"], outputModes: ["json", "text"], arguments: [{name: "connector", description: "WhatsApp connector key.", valueType: "string"}], examples: [{description: "Show active calls", command: "panda whatsapp call status"}], requiredCapabilities: [WHATSAPP_CALL_STATUS_COMMAND_NAME], resultShape: {ok: "boolean", sessions: "array"}};
export const whatsappCallSendCommandDescriptor: CommandDescriptor = {name: WHATSAPP_CALL_SEND_COMMAND_NAME, summary: "Speak into an active WhatsApp call.", description: "Appends progress or a final answer to GPT-Live.", usage: "panda whatsapp call send --text <message> [--mode progress|final] [--call <id>] [--turn <id>] [--connector <key>]", inputModes: ["flags", "json", "stdin", "file"], outputModes: ["json", "text"], arguments: [{name: "text", description: "Text to speak.", required: true, valueType: "string"}, {name: "mode", description: "progress or final.", valueType: "string"}, {name: "call", description: "WhatsApp call id.", valueType: "string"}, {name: "turn", description: "Live voice turn id.", valueType: "string"}, {name: "connector", description: "WhatsApp connector key.", valueType: "string"}], examples: [{description: "Speak final answer", command: "panda whatsapp call send --mode final --text 'Done.'"}], requiredCapabilities: [WHATSAPP_CALL_SEND_COMMAND_NAME], resultShape: {ok: "boolean", state: "sent", callId: "string"}};
export const whatsappCallHangupCommandDescriptor: CommandDescriptor = {name: WHATSAPP_CALL_HANGUP_COMMAND_NAME, summary: "End an active WhatsApp call.", description: "Terminates a WhatsApp live call owned by the current Panda session.", usage: "panda whatsapp call hangup [--call <id>] [--turn <id>] [--connector <key>]", inputModes: ["flags", "json", "stdin", "file"], outputModes: ["json", "text"], arguments: [{name: "call", description: "WhatsApp call id.", valueType: "string"}, {name: "turn", description: "Live voice turn id.", valueType: "string"}, {name: "connector", description: "WhatsApp connector key.", valueType: "string"}], examples: [{description: "End the call", command: "panda whatsapp call hangup"}], requiredCapabilities: [WHATSAPP_CALL_HANGUP_COMMAND_NAME], resultShape: {ok: "boolean", state: "disconnected", callId: "string"}};

export function createWhatsAppCallStatusCommand(services: WhatsAppCallCommandServices): RegisteredCommand { return {descriptor: whatsappCallStatusCommandDescriptor, async execute(request) { const input = parseInput(request.input, "status"); const key = await connector(input, request, services); const sessions = await services.calls.live.listSessions({sessionId: request.scope.sessionId, source: WHATSAPP_SOURCE, connectorKey: key, activeOnly: true}); return {ok: true, command: WHATSAPP_CALL_STATUS_COMMAND_NAME, output: {ok: true, enabled: isLiveVoiceEnabled(services.env), sessions: sessions.map(serialize)}}; }}; }
export function createWhatsAppCallSendCommand(services: WhatsAppCallCommandServices): RegisteredCommand { return {descriptor: whatsappCallSendCommandDescriptor, async execute(request) { ensureEnabled(services); const input = parseInput(request.input, "send"); const key = await connector(input, request, services); const session = await active(input, request, services, key); const voiceTurnId = await turn(input, request, services, session); const output = await enqueue({connectorKey: key, operation: "send", sessionId: request.scope.sessionId, agentKey: request.scope.agentKey, callId: session.scopeKey, text: input.text!, mode: input.mode!, ...(voiceTurnId ? {voiceTurnId} : {})}, request, services); return {ok: true, command: WHATSAPP_CALL_SEND_COMMAND_NAME, output}; }}; }
export function createWhatsAppCallHangupCommand(services: WhatsAppCallCommandServices): RegisteredCommand { return {descriptor: whatsappCallHangupCommandDescriptor, async execute(request) { ensureEnabled(services); const input = parseInput(request.input, "hangup"); const key = await connector(input, request, services); const session = await active(input, request, services, key); const voiceTurnId = await turn(input, request, services, session); const output = await enqueue({connectorKey: key, operation: "hangup", sessionId: request.scope.sessionId, agentKey: request.scope.agentKey, callId: session.scopeKey, ...(voiceTurnId ? {voiceTurnId} : {})}, request, services); return {ok: true, command: WHATSAPP_CALL_HANGUP_COMMAND_NAME, output}; }}; }
