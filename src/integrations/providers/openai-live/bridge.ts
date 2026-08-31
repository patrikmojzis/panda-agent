import WebSocket, {type RawData} from "ws";

import type {LiveVoiceHistoryItem} from "../../voice/live-voice-session.js";
import type {
  LiveVoiceContextChannel,
  LiveVoiceProviderFailure,
  LiveVoiceProviderFailureSource,
  LiveVoiceProviderHealth,
  LiveVoiceProviderSession,
} from "../../voice/provider.js";
import {resolveOpenAILiveAuth, type OpenAILiveAuth} from "./auth.js";
import {WeriftOpenAILiveAudioPeer, type OpenAILiveAudioPeer} from "./peer.js";
import {
  buildHeaders,
  createOpenAILiveCall,
  createRequestIds,
  delegationContextMessages,
  parseOpenAILiveEvent,
  sessionContextMessages,
  type OpenAILiveRequestIds,
} from "./wire.js";
import {DEFAULT_OPENAI_LIVE_VOICE} from "./voices.js";

const CONNECT_TIMEOUT_MS = 30_000;
const SESSION_TTL_MS = 30 * 60_000;
const MAX_SESSIONS = 8;
const MAX_SIDEBAND_PAYLOAD_BYTES = 16 * 1024 * 1024;
const MAX_EARLY_FRAMES = 32;
const MAX_EARLY_FRAME_BYTES = 1024 * 1024;
const MAX_SEEN_DELEGATIONS = 2_048;
const SIDEBAND_RECONNECT_BASE_MS = 200;
const SIDEBAND_RECONNECT_MAX_MS = 5_000;
const SIDEBAND_STABLE_MS = 30_000;
const SIDEBAND_SEND_WAIT_MS = 10_000;
const MAX_SIDEBAND_RECONNECT_ATTEMPTS = 8;
const activeOwners = new Set<object>();
type SidebandTerminal = {kind: "error"; error: Error} | {kind: "close"; code: number; reason: string};

export interface OpenAILiveRealtimeVoiceBridgeOptions {
  env?: NodeJS.ProcessEnv;
  voice?: string;
  initialItems?: readonly LiveVoiceHistoryItem[];
  delegationAckFiller?: boolean;
  connectTimeoutMs?: number;
  onAudio(audio: Buffer): void;
  onDelegation(delegation: {id: string; prompt: string}): Promise<void> | void;
  onOutputAudioCleared(): void;
  onTurnDone?(input: {role: "user" | "assistant" | "unknown"; transcript?: string}): void;
  onFailure(failure: LiveVoiceProviderFailure): void;
  log(event: string, payload: Record<string, unknown>): void;
  fetchImpl?: typeof fetch;
  resolveAuth?: () => OpenAILiveAuth;
  createPeer?: (callbacks: {onAudio(audio: Buffer): void; onError(error: Error): void}, signal: AbortSignal) => Promise<OpenAILiveAudioPeer>;
  createSocket?: (url: string, headers: Record<string, string>) => WebSocket;
  sidebandPingMs?: number;
  now?: () => number;
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data as ArrayBuffer).toString("utf8");
}

function rawByteLength(data: RawData): number {
  return Array.isArray(data) ? data.reduce((total, chunk) => total + chunk.byteLength, 0) : data.byteLength;
}

function safeErrorMessage(error: Error): string {
  return error.message
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/wss:\/\/api\.openai\.com\/v1\/live\/[^\s)]+/gi, "wss://api.openai.com/v1/live/[redacted]")
    .slice(0, 500);
}

function sanitizedError(error: unknown): Error {
  const original = error instanceof Error ? error : new Error(String(error));
  const sanitized = new Error(safeErrorMessage(original));
  if ("status" in original && typeof original.status === "number") Object.assign(sanitized, {status: original.status});
  return sanitized;
}

function optionalBoolean(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error("GPT-Live delegation acknowledgement setting must be true or false.");
}

function classifyRealtimeFailure(error: Error, source: LiveVoiceProviderFailureSource): LiveVoiceProviderFailure {
  const status = "status" in error && typeof error.status === "number" ? error.status : undefined;
  const message = safeErrorMessage(error);
  const normalized = message.toLowerCase();
  if (status === 401 || normalized.includes("oauth") || normalized.includes("token")) {
    return {source, code: "auth_unavailable", retryable: false, message, ...(status === undefined ? {} : {status})};
  }
  if (status === 403) return {source, code: "access_denied", retryable: false, message, status};
  if (status === 404 || status === 410) return {source: "session", code: "session_expired", retryable: false, message, status};
  if (source === "session") return {source, code: "session_expired", retryable: false, message, ...(status === undefined ? {} : {status})};
  if (status === 429) return {source, code: "capacity", retryable: true, message, status};
  return {
    source,
    code: "transport_failed",
    retryable: status === undefined || status >= 500,
    message,
    ...(status === undefined ? {} : {status}),
  };
}

function waitForOpen(socket: WebSocket, signal: AbortSignal): Promise<() => SidebandTerminal | undefined> {
  return new Promise((resolve, reject) => {
    let opened = false;
    let terminal: SidebandTerminal | undefined;
    const detachTerminal = () => {
      socket.off("error", onError); socket.off("close", onClose);
      return terminal;
    };
    const onOpen = () => { opened = true; finish(); };
    const onError = (error: Error) => {
      if (opened) { terminal ??= {kind: "error", error}; return; }
      finish(error);
    };
    const onClose = (code: number, reason: Buffer) => {
      if (opened) { terminal ??= {kind: "close", code, reason: reason?.toString("utf8").slice(0, 200) ?? ""}; return; }
      finish(new Error("GPT-Live sideband closed during startup."));
    };
    const onUnexpectedResponse = (_request: unknown, response: {statusCode?: number}) => {
      const error = new Error(`GPT-Live sideband rejected the connection (${response.statusCode ?? "unknown"}).`);
      if (response.statusCode !== undefined) Object.assign(error, {status: response.statusCode});
      finish(error);
    };
    const onAbort = () => finish(signal.reason instanceof Error ? signal.reason : new Error("GPT-Live startup stopped."));
    const finish = (error?: Error) => {
      socket.off("open", onOpen); socket.off("unexpected-response", onUnexpectedResponse); signal.removeEventListener("abort", onAbort);
      if (error) { detachTerminal(); reject(error); }
      else resolve(detachTerminal);
    };
    if (signal.aborted) {
      finish(signal.reason instanceof Error ? signal.reason : new Error("GPT-Live startup stopped."));
      return;
    }
    socket.once("open", onOpen); socket.once("unexpected-response", onUnexpectedResponse); socket.on("error", onError); socket.on("close", onClose); signal.addEventListener("abort", onAbort, {once: true});
  });
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => finish(signal.reason instanceof Error ? signal.reason : new Error("GPT-Live bridge stopped."));
    const finish = (error?: Error) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(finish, ms);
    timer.unref?.();
    signal.addEventListener("abort", onAbort, {once: true});
    if (signal.aborted) onAbort();
  });
}

function abortAfter(ms: number, message: string): {signal: AbortSignal; dispose(): void} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(message)), ms);
  timer.unref?.();
  return {signal: controller.signal, dispose: () => clearTimeout(timer)};
}

function within<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
    void promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

function sendSidebandFrame(socket: WebSocket, message: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => finish(new Error("GPT-Live sideband send timed out.")), timeoutMs);
    timer.unref?.();
    try { socket.send(message, (error) => finish(error)); }
    catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });
}

function terminalSidebandReconnectFailure(error: Error): boolean {
  const status = "status" in error && typeof error.status === "number" ? error.status : undefined;
  if (status === 401 || status === 403 || status === 404 || status === 410) return true;
  const message = error.message.toLowerCase();
  return message.includes("oauth") || message.includes("token") || message.includes("account");
}

function abortFailure(signal: AbortSignal): {promise: Promise<never>; dispose(): void} {
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<never>((_, reject) => { rejectPromise = reject; });
  const onAbort = () => rejectPromise(signal.reason instanceof Error ? signal.reason : new Error("GPT-Live startup stopped."));
  signal.addEventListener("abort", onAbort, {once: true});
  if (signal.aborted) onAbort();
  return {promise, dispose: () => signal.removeEventListener("abort", onAbort)};
}

export class OpenAILiveRealtimeVoiceBridge implements LiveVoiceProviderSession {
  private readonly abort = new AbortController();
  private peer?: OpenAILiveAudioPeer;
  private socket?: WebSocket;
  private ids?: OpenAILiveRequestIds;
  private sidebandUrl?: string;
  private sidebandAccountId?: string;
  private sidebandRecovery?: Promise<void>;
  private sidebandRapidDisconnects = 0;
  private sidebandDisconnectEpoch = 0;
  private readonly activeDelegationIds = new Set<string>();
  private readonly seenDelegationIds = new Set<string>();
  private expiry?: NodeJS.Timeout;
  private expiryAt?: number;
  private sidebandOpenedAt?: number;
  private sidebandPing?: NodeJS.Timeout;
  private lastPingAt?: number;
  private lastPongAt?: number;
  private lastCloseCode?: number;
  private lastCloseOpenForMs?: number;
  private malformedEvents = 0;
  private unknownEvents = 0;
  private state: LiveVoiceProviderHealth["state"] = "connecting";
  private sidebandState: LiveVoiceProviderHealth["sidebandState"] = "connecting";
  private startup?: {reject(error: Error): void};
  private closed = false;
  private reserved = false;
  private connectPromise?: Promise<void>;
  private failureEmitted = false;

  constructor(private readonly options: OpenAILiveRealtimeVoiceBridgeOptions) {}

  connect(signal?: AbortSignal): Promise<void> {
    this.connectPromise ??= this.connectInternal(signal);
    return this.connectPromise;
  }

  private async connectInternal(externalSignal?: AbortSignal): Promise<void> {
    if (this.closed) throw new Error("GPT-Live bridge is closed.");
    if (activeOwners.size >= MAX_SESSIONS) throw new Error("GPT-Live session limit reached.");
    activeOwners.add(this); this.reserved = true;
    const signal = AbortSignal.any([
      this.abort.signal,
      AbortSignal.timeout(this.options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS),
      ...(externalSignal ? [externalSignal] : []),
    ]);
    const startupFailure = new Promise<never>((_, reject) => { this.startup = {reject}; });
    const aborted = abortFailure(signal);
    const startedAt = Date.now();
    try {
      await Promise.race([
        this.establish(signal),
        startupFailure,
        aborted.promise,
      ]);
      this.startup = undefined;
      this.state = "connected";
      this.scheduleExpiry(SESSION_TTL_MS);
      this.options.log("gpt_live_connected", {connectDurationMs: Date.now() - startedAt});
    } catch (error) {
      this.closed = true;
      this.startup = undefined;
      this.abort.abort(error);
      this.release();
      throw sanitizedError(error);
    } finally {
      aborted.dispose();
    }
  }

  private async establish(signal: AbortSignal): Promise<void> {
    const factory = this.options.createPeer ?? ((callbacks, createSignal) => WeriftOpenAILiveAudioPeer.create(callbacks, createSignal));
    const peerPromise = factory({onAudio: this.options.onAudio, onError: (error) => this.fail(error, "media")}, signal);
    void peerPromise.then((peer) => { if (signal.aborted || this.closed) peer.close(); }, () => undefined);
    const peer = await peerPromise;
    signal.throwIfAborted();
    if (this.closed) {
      peer.close();
      throw new Error("GPT-Live bridge closed during startup.");
    }
    this.peer = peer;
    const offerSdp = await this.peer.createOffer();
    const auth = (this.options.resolveAuth ?? (() => resolveOpenAILiveAuth(this.options.env)))();
    this.ids = createRequestIds();
    const call = await createOpenAILiveCall({
      auth, ids: this.ids, offerSdp, voice: this.options.voice ?? DEFAULT_OPENAI_LIVE_VOICE,
      ...(this.options.initialItems ? {initialItems: this.options.initialItems} : {}),
      delegationAckFiller: this.options.delegationAckFiller
        ?? optionalBoolean(this.options.env?.PANDA_OPENAI_LIVE_DELEGATION_ACK_FILLER),
      signal, fetchImpl: this.options.fetchImpl,
    });
    this.sidebandUrl = call.sidebandUrl;
    this.sidebandAccountId = auth.accountId;
    await this.peer.applyAnswer(call.answerSdp);
    await Promise.all([
      this.peer.waitUntilConnected(signal),
      this.connectSideband(call.sidebandUrl, auth, this.ids, signal),
    ]);
  }

  sendAudio(audio: Buffer): void { this.peer?.sendAudio(audio); }

  getHealthSnapshot(): LiveVoiceProviderHealth {
    const now = this.options.now?.() ?? Date.now();
    return {
      state: this.state,
      sidebandState: this.sidebandState,
      sidebandOpenedAt: this.sidebandOpenedAt ?? null,
      sidebandAgeMs: this.sidebandOpenedAt === undefined ? null : Math.max(0, now - this.sidebandOpenedAt),
      lastPingAt: this.lastPingAt ?? null,
      lastPongAt: this.lastPongAt ?? null,
      pongAgeMs: this.lastPongAt === undefined ? null : Math.max(0, now - this.lastPongAt),
      lastCloseCode: this.lastCloseCode ?? null,
      lastCloseOpenForMs: this.lastCloseOpenForMs ?? null,
      malformedEvents: this.malformedEvents,
      unknownEvents: this.unknownEvents,
      ...(this.peer?.getHealthSnapshot ? {media: this.peer.getHealthSnapshot()} : {}),
    };
  }

  async appendDelegationContext(delegationId: string, text: string, channel: LiveVoiceContextChannel): Promise<boolean> {
    if (!this.activeDelegationIds.has(delegationId)) return false;
    const sent = await this.sendMessages(delegationContextMessages(delegationId, text, channel));
    if (sent && channel === "speakable") this.activeDelegationIds.delete(delegationId);
    return sent;
  }

  async appendSessionContext(text: string, channel: LiveVoiceContextChannel): Promise<boolean> {
    return this.sendMessages(sessionContextMessages(text, channel));
  }

  close(): void { this.teardown(); }

  private async connectSideband(url: string, auth: OpenAILiveAuth, ids: OpenAILiveRequestIds, signal: AbortSignal): Promise<void> {
    const headers = buildHeaders(auth, ids);
    const socket = this.options.createSocket?.(url, headers) ?? new WebSocket(url, {headers, maxPayload: MAX_SIDEBAND_PAYLOAD_BYTES});
    const bufferedFrames: Array<{data: RawData; isBinary: boolean}> = [];
    let bufferedBytes = 0;
    const bufferFrame = (data: RawData, isBinary: boolean) => {
      const bytes = rawByteLength(data);
      if (bufferedFrames.length >= MAX_EARLY_FRAMES || bufferedBytes + bytes > MAX_EARLY_FRAME_BYTES) {
        socket.off("message", bufferFrame);
        socket.close(1009, "sideband startup buffer exceeded");
        return;
      }
      bufferedBytes += bytes;
      bufferedFrames.push({data, isBinary});
    };
    socket.on("message", bufferFrame);
    try {
      const detachTerminal = await waitForOpen(socket, signal);
      this.socket = socket;
      this.sidebandOpenedAt = this.options.now?.() ?? Date.now();
      this.sidebandState = "open";
      this.startSidebandPing(socket);
      socket.on("message", (data, isBinary) => { if (isBinary) return this.fail(new Error("GPT-Live sideband sent binary data."), "sideband"); this.handleEvent(rawText(data)); });
      socket.on("error", (error) => this.handleSidebandLoss(socket, error));
      socket.on("close", (code, reason) => {
        const detail = reason?.length > 0 ? `: ${reason.toString("utf8").slice(0, 200)}` : ".";
        if (!this.closed) {
          const now = this.options.now?.() ?? Date.now();
          this.lastCloseCode = code;
          this.lastCloseOpenForMs = this.sidebandOpenedAt === undefined ? undefined : now - this.sidebandOpenedAt;
          this.options.log("gpt_live_sideband_closed", {code, openForMs: this.lastCloseOpenForMs, hasReason: reason?.length > 0});
          this.handleSidebandLoss(socket, new Error(`GPT-Live sideband closed (${code})${detail}`));
        }
      });
      socket.off("message", bufferFrame);
      const terminal = detachTerminal();
      for (const frame of bufferedFrames) {
        if (frame.isBinary) throw new Error("GPT-Live sideband sent binary data during startup.");
        this.handleEvent(rawText(frame.data));
      }
      if (terminal?.kind === "error") throw terminal.error;
      if (terminal?.kind === "close") throw new Error(`GPT-Live sideband closed (${terminal.code})${terminal.reason ? `: ${terminal.reason}` : "."}`);
      return;
    } catch (error) {
      socket.off("message", bufferFrame);
      if (this.socket === socket) this.socket = undefined;
      socket.on("error", () => undefined);
      socket.close();
      throw error;
    }
  }

  private handleEvent(text: string): void {
    const event = parseOpenAILiveEvent(text);
    if (event.kind === "malformed") {
      this.malformedEvents += 1;
      this.options.log("gpt_live_sideband_event_dropped", {reason: event.reason, malformedEvents: this.malformedEvents});
      return;
    }
    if (event.kind === "ignored") {
      this.unknownEvents += 1;
      if (this.unknownEvents <= 10 || this.unknownEvents % 100 === 0) this.options.log("gpt_live_sideband_event_ignored", {type: event.type, unknownEvents: this.unknownEvents});
      return;
    }
    if (event.kind === "known_ignored") return;
    if (event.kind === "transcript_metadata") return;
    if (event.kind === "turn_done") {
      this.options.log("gpt_live_turn_done", {role: event.role, transcriptChars: event.transcriptChars, transcriptBytes: event.transcriptBytes, truncated: event.truncated});
      this.options.onTurnDone?.({role: event.role, ...(event.transcript === undefined ? {} : {transcript: event.transcript})});
      return;
    }
    if (event.kind === "session_started") {
      if (event.expiresAt !== undefined) {
        const expiresInMs = Math.max(0, event.expiresAt * 1000 - Date.now());
        this.options.log("gpt_live_session_started", {expiresInMs});
        this.scheduleExpiry(Math.min(SESSION_TTL_MS, expiresInMs));
      }
      return;
    }
    if (event.kind === "audio_cleared") {
      this.peer?.discardPendingOutput?.();
      this.options.onOutputAudioCleared();
      return;
    }
    if (event.kind === "error") {
      if (event.fatalAuth) this.fail(new Error("Codex OAuth became unavailable."), "sideband");
      else this.options.log("gpt_live_sideband_error", {message: safeErrorMessage(new Error(event.message))});
      return;
    }
    if (this.seenDelegationIds.has(event.id)) return;
    this.seenDelegationIds.add(event.id);
    if (this.seenDelegationIds.size > MAX_SEEN_DELEGATIONS) this.seenDelegationIds.delete(this.seenDelegationIds.values().next().value!);
    this.activeDelegationIds.add(event.id);
    void Promise.resolve(this.options.onDelegation({id: event.id, prompt: event.prompt})).catch((error: unknown) => this.options.log("gpt_live_delegation_failed", {message: safeErrorMessage(error instanceof Error ? error : new Error(String(error)))}));
  }

  private async sendMessages(messages: readonly string[]): Promise<boolean> {
    const deadline = Date.now() + SIDEBAND_SEND_WAIT_MS;
    for (const message of messages) {
      while (!this.closed) {
        const socket = this.socket;
        if (socket?.readyState === WebSocket.OPEN) {
          try {
            await sendSidebandFrame(socket, message, Math.max(1, deadline - Date.now()));
            break;
          } catch (error) {
            this.handleSidebandLoss(socket, error instanceof Error ? error : new Error(String(error)));
          }
        }
        const recovery = this.sidebandRecovery;
        const remaining = deadline - Date.now();
        if (!recovery || remaining <= 0) return false;
        try {
          await within(recovery, remaining, "GPT-Live sideband send timed out.");
        } catch {
          if (this.closed || Date.now() >= deadline) return false;
        }
      }
      if (this.closed) return false;
    }
    return true;
  }

  private handleSidebandLoss(socket: WebSocket, error: Error): void {
    if (this.closed || this.socket !== socket) return;
    if (this.sidebandPing) clearInterval(this.sidebandPing);
    this.sidebandPing = undefined;
    this.socket = undefined;
    this.sidebandState = "connecting";
    this.sidebandDisconnectEpoch += 1;
    if (this.startup) {
      this.fail(error, "sideband");
      return;
    }
    if (socket.readyState < WebSocket.CLOSING) socket.close();
    const now = this.options.now?.() ?? Date.now();
    if (this.sidebandOpenedAt !== undefined && now - this.sidebandOpenedAt >= SIDEBAND_STABLE_MS) this.sidebandRapidDisconnects = 0;
    this.sidebandRapidDisconnects += 1;
    if (!this.sidebandRecovery) {
      this.sidebandRecovery = this.reconnectSideband()
        .catch((reconnectError: unknown) => {
          if (!this.closed) this.fail(reconnectError instanceof Error ? reconnectError : new Error(String(reconnectError)), "sideband");
        })
        .finally(() => { this.sidebandRecovery = undefined; });
    }
  }

  private async reconnectSideband(): Promise<void> {
    const url = this.sidebandUrl;
    const ids = this.ids;
    const expectedAccountId = this.sidebandAccountId;
    if (!url || !ids || !expectedAccountId) throw new Error("GPT-Live sideband reconnect state is unavailable.");
    let attempt = 0;
    while (!this.closed) {
      const delayMs = Math.min(SIDEBAND_RECONNECT_MAX_MS, SIDEBAND_RECONNECT_BASE_MS * 2 ** Math.max(0, this.sidebandRapidDisconnects - 1));
      await delay(delayMs, this.abort.signal);
      attempt += 1;
      const attemptTimeout = abortAfter(this.options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS, "GPT-Live sideband reconnect timed out.");
      try {
        const disconnectEpoch = this.sidebandDisconnectEpoch;
        const auth = (this.options.resolveAuth ?? (() => resolveOpenAILiveAuth(this.options.env)))();
        if (auth.accountId !== expectedAccountId) throw new Error("Codex OAuth account changed during GPT-Live sideband reconnect.");
        const attemptSignal = AbortSignal.any([
          this.abort.signal,
          attemptTimeout.signal,
        ]);
        await this.connectSideband(url, auth, ids, attemptSignal);
        if (this.sidebandDisconnectEpoch !== disconnectEpoch || this.socket?.readyState !== WebSocket.OPEN) {
          if (attempt >= MAX_SIDEBAND_RECONNECT_ATTEMPTS) throw new Error("GPT-Live sideband remained unstable after bounded reconnect attempts.");
          continue;
        }
        this.options.log("gpt_live_sideband_reconnected", {attempt});
        return;
      } catch (error) {
        const reconnectError = sanitizedError(error);
        this.options.log("gpt_live_sideband_reconnect_failed", {attempt, message: safeErrorMessage(reconnectError)});
        if (terminalSidebandReconnectFailure(reconnectError)) throw reconnectError;
        if (attempt >= MAX_SIDEBAND_RECONNECT_ATTEMPTS) throw reconnectError;
        this.sidebandRapidDisconnects += 1;
      } finally {
        attemptTimeout.dispose();
      }
    }
  }

  private fail(error: Error, source: LiveVoiceProviderFailureSource): void {
    if (this.closed) return;
    this.options.log("gpt_live_failed", {failureSource: source, message: safeErrorMessage(error)});
    this.state = "failed";
    if (source === "sideband") this.sidebandState = "failed";
    if (this.startup) {
      this.startup.reject(error);
      this.abort.abort(error);
      return;
    }
    const failure = classifyRealtimeFailure(error, source);
    this.teardown();
    if (!this.failureEmitted) {
      this.failureEmitted = true;
      this.options.onFailure(failure);
    }
  }

  private scheduleExpiry(delayMs: number): void {
    const expiresAt = Date.now() + delayMs;
    if (this.expiryAt !== undefined && expiresAt >= this.expiryAt) return;
    if (this.expiry) clearTimeout(this.expiry);
    this.expiryAt = expiresAt;
    this.expiry = setTimeout(() => {
      if (this.closed) return;
      this.options.log("gpt_live_expired", {failureSource: "session"});
      this.fail(new Error("GPT-Live session expired."), "session");
    }, Math.max(0, expiresAt - Date.now()));
    this.expiry.unref?.();
  }

  private teardown(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.state !== "failed") this.state = "closed";
    if (this.sidebandState !== "failed") this.sidebandState = "closed";
    this.startup?.reject(new Error("GPT-Live bridge closed during startup."));
    this.startup = undefined;
    this.abort.abort();
    this.release();
  }

  private release(): void {
    if (this.sidebandPing) clearInterval(this.sidebandPing);
    this.sidebandPing = undefined;
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = undefined;
    this.expiryAt = undefined;
    this.peer?.close(); this.peer = undefined;
    this.activeDelegationIds.clear();
    this.seenDelegationIds.clear();
    this.sidebandOpenedAt = undefined;
    this.sidebandRecovery = undefined;
    this.sidebandUrl = undefined;
    this.sidebandAccountId = undefined;
    const socket = this.socket; this.socket = undefined;
    if (socket?.readyState === WebSocket.OPEN) {
      try { socket.send(JSON.stringify({type: "session.close"})); } catch { /* Best-effort provider cleanup. */ }
    }
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "session stopped");
    if (this.reserved) { activeOwners.delete(this); this.reserved = false; }
  }

  private startSidebandPing(socket: WebSocket): void {
    if (this.sidebandPing) clearInterval(this.sidebandPing);
    const configured = this.options.sidebandPingMs
      ?? Number.parseInt(this.options.env?.PANDA_OPENAI_LIVE_SIDEBAND_PING_MS ?? "0", 10);
    if (!Number.isFinite(configured) || configured <= 0 || typeof socket.ping !== "function") return;
    socket.on("pong", () => { this.lastPongAt = this.options.now?.() ?? Date.now(); });
    this.sidebandPing = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      this.lastPingAt = this.options.now?.() ?? Date.now();
      try { socket.ping(); }
      catch (error) { this.handleSidebandLoss(socket, error instanceof Error ? error : new Error(String(error))); }
    }, configured);
    this.sidebandPing.unref?.();
  }
}
