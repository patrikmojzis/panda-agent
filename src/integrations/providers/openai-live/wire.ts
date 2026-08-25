import {randomUUID} from "node:crypto";

import {isRecord} from "../../../lib/records.js";
import type {LiveVoiceHistoryItem} from "../../voice/live-voice-session.js";
import type {OpenAILiveAuth} from "./auth.js";
import {OPENAI_LIVE_MODEL} from "./types.js";

const CALL_URL = "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas";
const PANDA_LIVE_VERSION = "0.1.0";
const MAX_SDP_BYTES = 256 * 1024;
const MAX_ERROR_BYTES = 16 * 1024;
const MAX_DELEGATION_PROMPT_CHARS = 8_000;
const APPEND_BYTES = 500;
const RESULT_CHARS = 1_800;
const MAX_INITIAL_ITEMS = 32;
const MAX_INITIAL_CHARS = 8_192;
const VOICES = new Set(["juniper", "maple", "spruce", "ember", "vale", "breeze", "arbor", "sol", "cove"]);

export interface OpenAILiveRequestIds {realtimeSessionId: string; sessionId: string; threadId: string}
export type OpenAILiveContextChannel = "commentary" | "speakable";
export interface OpenAILiveSession {
  model: typeof OPENAI_LIVE_MODEL;
  instructions: string;
  audio: {output: {voice: string}};
  delegation: {type: "client"; ack_filler?: boolean};
  initial_items?: Array<{type: "message"; role: "user" | "assistant"; content: Array<{type: "input_text" | "output_text"; text: string}>}>;
}

export type OpenAILiveEvent =
  | {kind: "session_started"; expiresAt?: number}
  | {kind: "delegation"; id: string; prompt: string}
  | {kind: "audio_cleared"}
  | {kind: "turn_done"; role: "user" | "assistant" | "unknown"; transcript?: string; transcriptChars: number; transcriptBytes: number; truncated: boolean}
  | {kind: "transcript_metadata"; type: string; role: "user" | "assistant" | "unknown"; transcriptChars: number; transcriptBytes: number; truncated: boolean}
  | {kind: "error"; message: string; fatalAuth: boolean}
  | {kind: "malformed"; reason: "invalid_json" | "invalid_shape" | "oversized"}
  | {kind: "known_ignored"; type: "output_audio.delta"}
  | {kind: "ignored"; type: string};

export function createRequestIds(): OpenAILiveRequestIds {
  return {realtimeSessionId: randomUUID(), sessionId: randomUUID(), threadId: randomUUID()};
}

export function buildHeaders(auth: OpenAILiveAuth, ids: OpenAILiveRequestIds): Record<string, string> {
  return {
    Authorization: `Bearer ${auth.token}`,
    "OpenAI-Alpha": "quicksilver=v2",
    "chatgpt-account-id": auth.accountId,
    "session-id": ids.sessionId,
    "thread-id": ids.threadId,
    "x-session-id": ids.realtimeSessionId,
    originator: "panda-agent",
    version: PANDA_LIVE_VERSION,
    "User-Agent": `panda-agent/${PANDA_LIVE_VERSION}`,
  };
}

export function buildSession(voice = "cove", options: {initialItems?: readonly LiveVoiceHistoryItem[]; delegationAckFiller?: boolean} = {}): OpenAILiveSession {
  if (!VOICES.has(voice)) throw new Error("Unsupported GPT-Live V3 voice.");
  const initialItems = boundedInitialItems(options.initialItems ?? []);
  return {
    model: OPENAI_LIVE_MODEL,
    instructions: [
      "You are Panda's low-latency voice front end in a Discord voice channel.",
      "Wait silently until a participant speaks; do not greet merely because the session connected.",
      "Respond naturally to casual conversation. Delegate substantive requests, memory questions, and every action requiring tools to the client.",
      "If a participant asks you to leave or disconnect from voice, delegate that request to the client; you cannot leave the channel yourself.",
      "Never claim an action succeeded unless the client result says so. Keep spoken replies concise.",
    ].join(" "),
    audio: {output: {voice}},
    delegation: {type: "client", ...(options.delegationAckFiller === undefined ? {} : {ack_filler: options.delegationAckFiller})},
    ...(initialItems.length === 0 ? {} : {initial_items: initialItems}),
  };
}

function boundedInitialItems(items: readonly LiveVoiceHistoryItem[]): NonNullable<OpenAILiveSession["initial_items"]> {
  const selected = items.slice(-MAX_INITIAL_ITEMS);
  const output: NonNullable<OpenAILiveSession["initial_items"]> = [];
  let remaining = MAX_INITIAL_CHARS;
  for (const item of [...selected].reverse()) {
    const text = item.text.trim().slice(0, remaining);
    if (!text) continue;
    output.unshift({
      type: "message",
      role: item.role,
      content: [{type: item.role === "assistant" ? "output_text" : "input_text", text}],
    });
    remaining -= text.length;
    if (remaining === 0) break;
  }
  return output;
}

async function boundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("GPT-Live response exceeded the configured limit.");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

export async function createOpenAILiveCall(input: {auth: OpenAILiveAuth; ids: OpenAILiveRequestIds; offerSdp: string; voice: string; initialItems?: readonly LiveVoiceHistoryItem[]; delegationAckFiller?: boolean; signal: AbortSignal; fetchImpl?: typeof fetch}): Promise<{answerSdp: string; sidebandUrl: string}> {
  if (Buffer.byteLength(input.offerSdp) > MAX_SDP_BYTES) throw new Error("GPT-Live SDP offer exceeded the configured limit.");
  const body = JSON.stringify({sdp: input.offerSdp, session: buildSession(input.voice, {initialItems: input.initialItems, delegationAckFiller: input.delegationAckFiller})});
  const response = await (input.fetchImpl ?? fetch)(CALL_URL, {method: "POST", headers: {...buildHeaders(input.auth, input.ids), "Content-Type": "application/json"}, body, signal: input.signal});
  if (!response.ok) {
    await boundedText(response, MAX_ERROR_BYTES).catch(() => "");
    const error = new Error(response.status === 401 ? "Codex OAuth was rejected by GPT-Live." : `GPT-Live startup failed (${response.status}).`);
    Object.assign(error, {status: response.status});
    throw error;
  }
  const answerSdp = await boundedText(response, MAX_SDP_BYTES);
  if (!answerSdp.trim()) throw new Error("GPT-Live returned an empty SDP answer.");
  const location = response.headers.get("location");
  const sessionId = response.headers.get("openai-session-id");
  const isCallId = (value: string) => /^rtc_[\w-]+$/.test(value) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  const candidate = location ? new URL(location, CALL_URL).pathname.split("/").filter(Boolean).find(isCallId) : undefined;
  const callId = candidate ?? (sessionId && isCallId(sessionId) ? sessionId : undefined);
  if (!callId) throw new Error("GPT-Live response did not contain a valid call id.");
  return {answerSdp, sidebandUrl: `wss://api.openai.com/v1/live/${callId}`};
}

function metadataRole(value: unknown): "user" | "assistant" | "unknown" {
  return value === "user" || value === "assistant" ? value : "unknown";
}

function transcriptMetadata(record: Record<string, unknown>): {transcript?: string; transcriptChars: number; transcriptBytes: number; truncated: boolean} {
  const candidate = typeof record.transcript === "string"
    ? record.transcript
    : typeof record.text === "string"
      ? record.text
      : "";
  const transcriptChars = Math.min(candidate.length, MAX_DELEGATION_PROMPT_CHARS);
  const bounded = candidate.slice(0, transcriptChars);
  return {...(bounded ? {transcript: bounded} : {}), transcriptChars, transcriptBytes: Buffer.byteLength(bounded), truncated: candidate.length > transcriptChars};
}

export function parseOpenAILiveEvent(text: string): OpenAILiveEvent {
  if (Buffer.byteLength(text) > 1024 * 1024) return {kind: "malformed", reason: "oversized"};
  let payload: unknown;
  try { payload = JSON.parse(text) as unknown; } catch { return {kind: "malformed", reason: "invalid_json"}; }
  if (!isRecord(payload) || typeof payload.type !== "string") return {kind: "malformed", reason: "invalid_shape"};
  if (payload.type === "session.started" || payload.type === "session.updated") {
    const session = isRecord(payload.session) ? payload.session : undefined;
    return {kind: "session_started", ...(typeof session?.expires_at === "number" ? {expiresAt: session.expires_at} : {})};
  }
  if (payload.type === "output_audio.delta") return {kind: "known_ignored", type: payload.type};
  if (payload.type === "output_audio_buffer.cleared") return {kind: "audio_cleared"};
  if (payload.type === "turn.done") {
    const turn = isRecord(payload.turn) ? payload.turn : undefined;
    if (!turn || (turn.role !== "user" && turn.role !== "assistant") || typeof turn.transcript !== "string") return {kind: "ignored", type: payload.type};
    return {kind: "turn_done", role: turn.role, ...transcriptMetadata(turn)};
  }
  if (payload.type.toLowerCase().includes("transcript")) {
    const item = isRecord(payload.item) ? payload.item : isRecord(payload.delta) ? payload.delta : payload;
    const {transcript: _transcript, ...metadata} = transcriptMetadata(item);
    return {kind: "transcript_metadata", type: payload.type.slice(0, 120), role: metadataRole(item.role ?? payload.role), ...metadata};
  }
  if (payload.type === "delegation.created") {
    const item = isRecord(payload.item) ? payload.item : undefined;
    if (item?.type !== "delegation" || item.target !== "client" || typeof item.id !== "string" || !Array.isArray(item.content)) return {kind: "ignored", type: payload.type};
    const prompt = item.content.filter(isRecord).filter((part) => part.type === "input_text").map((part) => typeof part.text === "string" ? part.text : "").join("").trim().slice(0, MAX_DELEGATION_PROMPT_CHARS);
    return prompt ? {kind: "delegation", id: item.id, prompt} : {kind: "ignored", type: payload.type};
  }
  if (payload.type === "error") {
    const detail = isRecord(payload.error) ? payload.error : payload;
    const status = detail.status;
    const code = typeof detail.code === "string" ? detail.code.toLowerCase() : "";
    const message = typeof detail.message === "string" ? detail.message.trim().slice(0, 500) : "GPT-Live sideband error";
    return {kind: "error", message, fatalAuth: status === 401 || status === "401" || ["invalid_token", "token_expired", "authentication_error"].includes(code)};
  }
  return {kind: "ignored", type: payload.type.slice(0, 120)};
}

export function delegationContextMessages(delegationId: string, text: string, channel: OpenAILiveContextChannel): string[] {
  return contextAppendMessages(text, channel, delegationId);
}

export function sessionContextMessages(text: string, channel: OpenAILiveContextChannel): string[] {
  return contextAppendMessages(text, channel);
}

function contextAppendMessages(text: string, channel: OpenAILiveContextChannel, delegationId?: string): string[] {
  let prefix = text.slice(0, RESULT_CHARS - 16);
  if (/\p{Surrogate}$/u.test(prefix)) prefix = prefix.slice(0, -1);
  const bounded = text.length > RESULT_CHARS ? `${prefix.trimEnd()} [truncated]` : text;
  const chunks: string[] = [];
  let current = "";
  for (const character of bounded) {
    if (current && Buffer.byteLength(current + character) > APPEND_BYTES) { chunks.push(current); current = ""; }
    current += character;
  }
  if (current) chunks.push(current);
  return chunks.map((chunk) => JSON.stringify({
    type: delegationId ? "delegation.context.append" : "session.context.append",
    ...(delegationId ? {delegation_item_id: delegationId} : {}),
    channel,
    content: [{type: "input_text", text: chunk}],
  }));
}
