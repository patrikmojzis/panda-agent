import WebSocket, {type RawData} from "ws";

import {resolveOpenAILiveAuth, type OpenAILiveAuth} from "./auth.js";
import {WeriftOpenAILiveAudioPeer, type OpenAILiveAudioPeer} from "./peer.js";
import {
  buildHeaders,
  createOpenAILiveCall,
  createRequestIds,
  delegationAppendMessages,
  parseOpenAILiveEvent,
  sessionSpeechMessages,
  type OpenAILiveInitialItem,
  type OpenAILiveRequestIds,
} from "./wire.js";

const CONNECT_TIMEOUT_MS = 30_000;
const SESSION_TTL_MS = 30 * 60_000;
const MAX_SESSIONS = 8;
const MAX_SIDEBAND_PAYLOAD_BYTES = 16 * 1024 * 1024;
const MAX_EARLY_FRAMES = 32;
const MAX_EARLY_FRAME_BYTES = 1024 * 1024;
const activeOwners = new Set<object>();
type RealtimeVoiceFailureSource = "media" | "sideband" | "session";
type SidebandTerminal = {kind: "error"; error: Error} | {kind: "close"; code: number; reason: string};

export interface RealtimeVoiceDelegation {id: string; prompt: string}
export interface RealtimeVoiceBridge {
  connect(): Promise<void>;
  sendAudio(pcm24kMono: Buffer): void;
  interrupt(): void;
  appendDelegationResult(delegationId: string, text: string): boolean;
  appendSpeech(text: string): boolean;
  close(): void;
}

export interface RealtimeVoiceBridgeOptions {
  env?: NodeJS.ProcessEnv;
  voice?: string;
  initialItems?: readonly OpenAILiveInitialItem[];
  connectTimeoutMs?: number;
  onAudio(audio: Buffer): void;
  onDelegation(delegation: RealtimeVoiceDelegation): Promise<void> | void;
  onTranscript?(role: "user" | "assistant", text: string): void;
  onClearAudio(): void;
  onClose(reason: string): void;
  log(event: string, payload: Record<string, unknown>): void;
  fetchImpl?: typeof fetch;
  resolveAuth?: () => OpenAILiveAuth;
  createPeer?: (callbacks: {onAudio(audio: Buffer): void; onError(error: Error): void}, signal: AbortSignal) => Promise<OpenAILiveAudioPeer>;
  createSocket?: (url: string, headers: Record<string, string>) => WebSocket;
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
      if (opened) { terminal ??= {kind: "close", code, reason: reason.toString("utf8").slice(0, 200)}; return; }
      finish(new Error("GPT-Live sideband closed during startup."));
    };
    const onAbort = () => finish(signal.reason instanceof Error ? signal.reason : new Error("GPT-Live startup stopped."));
    const finish = (error?: Error) => {
      socket.off("open", onOpen); signal.removeEventListener("abort", onAbort);
      if (error) { detachTerminal(); reject(error); }
      else resolve(detachTerminal);
    };
    if (signal.aborted) {
      finish(signal.reason instanceof Error ? signal.reason : new Error("GPT-Live startup stopped."));
      return;
    }
    socket.once("open", onOpen); socket.on("error", onError); socket.on("close", onClose); signal.addEventListener("abort", onAbort, {once: true});
  });
}

function retryDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => finish(signal.reason instanceof Error ? signal.reason : new Error("GPT-Live startup stopped."));
    const finish = (error?: Error) => {
      clearTimeout(timer); signal.removeEventListener("abort", onAbort);
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(finish, ms);
    timer.unref?.();
    signal.addEventListener("abort", onAbort, {once: true});
    if (signal.aborted) onAbort();
  });
}

function abortFailure(signal: AbortSignal): {promise: Promise<never>; dispose(): void} {
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<never>((_, reject) => { rejectPromise = reject; });
  const onAbort = () => rejectPromise(signal.reason instanceof Error ? signal.reason : new Error("GPT-Live startup stopped."));
  signal.addEventListener("abort", onAbort, {once: true});
  if (signal.aborted) onAbort();
  return {promise, dispose: () => signal.removeEventListener("abort", onAbort)};
}

export class OpenAILiveRealtimeVoiceBridge implements RealtimeVoiceBridge {
  private readonly abort = new AbortController();
  private peer?: OpenAILiveAudioPeer;
  private socket?: WebSocket;
  private ids?: OpenAILiveRequestIds;
  private activeDelegationId?: string;
  private expiry?: NodeJS.Timeout;
  private expiryAt?: number;
  private startup?: {reject(error: Error): void};
  private closed = false;
  private reserved = false;
  private connectPromise?: Promise<void>;

  constructor(private readonly options: RealtimeVoiceBridgeOptions) {}

  connect(): Promise<void> {
    this.connectPromise ??= this.connectInternal();
    return this.connectPromise;
  }

  private async connectInternal(): Promise<void> {
    if (this.closed) throw new Error("GPT-Live bridge is closed.");
    if (activeOwners.size >= MAX_SESSIONS) throw new Error("GPT-Live session limit reached.");
    activeOwners.add(this); this.reserved = true;
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(this.options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS)]);
    const startupFailure = new Promise<never>((_, reject) => { this.startup = {reject}; });
    const aborted = abortFailure(signal);
    try {
      await Promise.race([
        this.establish(signal),
        startupFailure,
        aborted.promise,
      ]);
      this.startup = undefined;
      this.scheduleExpiry(SESSION_TTL_MS);
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
      auth, ids: this.ids, offerSdp, voice: this.options.voice ?? "cove", initialItems: this.options.initialItems,
      signal, fetchImpl: this.options.fetchImpl,
    });
    await this.peer.applyAnswer(call.answerSdp);
    await Promise.all([
      this.peer.waitUntilConnected(signal),
      this.connectSideband(call.sidebandUrl, auth, this.ids, signal),
    ]);
  }

  sendAudio(audio: Buffer): void { this.peer?.sendAudio(audio); }

  interrupt(): void {
    this.options.onClearAudio();
  }

  appendDelegationResult(delegationId: string, text: string): boolean {
    if (delegationId !== this.activeDelegationId || this.socket?.readyState !== WebSocket.OPEN) return false;
    this.activeDelegationId = undefined;
    return this.sendMessages(delegationAppendMessages(delegationId, text));
  }

  appendSpeech(text: string): boolean {
    return this.sendMessages(sessionSpeechMessages(text));
  }

  close(): void { this.teardown("completed"); }

  private async connectSideband(url: string, auth: OpenAILiveAuth, ids: OpenAILiveRequestIds, signal: AbortSignal): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
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
        socket.on("message", (data, isBinary) => { if (isBinary) return this.fail(new Error("GPT-Live sideband sent binary data."), "sideband"); this.handleEvent(rawText(data)); });
        socket.on("error", (error) => this.fail(error, "sideband"));
        socket.on("close", (code, reason) => {
          const detail = reason?.length > 0 ? `: ${reason.toString("utf8").slice(0, 200)}` : ".";
          if (!this.closed) this.fail(new Error(`GPT-Live sideband closed (${code})${detail}`), "sideband");
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
        lastError = error;
        socket.on("error", () => undefined);
        socket.close();
        if (attempt < 2) await retryDelay(200 * 2 ** attempt, signal);
      }
    }
    throw lastError;
  }

  private handleEvent(text: string): void {
    const event = parseOpenAILiveEvent(text);
    if (!event || event.kind === "ignored") return;
    if (event.kind === "session_started") {
      if (event.expiresAt !== undefined) this.scheduleExpiry(Math.min(SESSION_TTL_MS, Math.max(0, event.expiresAt * 1000 - Date.now())));
      return;
    }
    if (event.kind === "audio_cleared") { this.options.onClearAudio(); return; }
    if (event.kind === "transcript") { this.options.onTranscript?.(event.role, event.text); return; }
    if (event.kind === "error") {
      if (event.fatalAuth) this.fail(new Error("Codex OAuth became unavailable."), "sideband");
      else this.options.log("gpt_live_sideband_error", {message: safeErrorMessage(new Error(event.message))});
      return;
    }
    this.activeDelegationId = event.id;
    void Promise.resolve(this.options.onDelegation({id: event.id, prompt: event.prompt})).catch((error: unknown) => this.options.log("gpt_live_delegation_failed", {message: safeErrorMessage(error instanceof Error ? error : new Error(String(error)))}));
  }

  private sendMessages(messages: readonly string[]): boolean {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) return false;
    try {
      for (const message of messages) socket.send(message);
      return true;
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)), "sideband");
      return false;
    }
  }

  private fail(error: Error, source: RealtimeVoiceFailureSource): void {
    if (this.closed) return;
    this.options.log("gpt_live_failed", {failureSource: source, message: safeErrorMessage(error)});
    if (this.startup) {
      this.startup.reject(error);
      this.abort.abort(error);
      return;
    }
    this.teardown(error.message.toLowerCase().includes("oauth") ? "auth_unavailable" : "provider_failed");
  }

  private scheduleExpiry(delayMs: number): void {
    const expiresAt = Date.now() + delayMs;
    if (this.expiryAt !== undefined && expiresAt >= this.expiryAt) return;
    if (this.expiry) clearTimeout(this.expiry);
    this.expiryAt = expiresAt;
    this.expiry = setTimeout(() => {
      if (this.closed) return;
      this.options.log("gpt_live_expired", {failureSource: "session"});
      this.teardown("session_expired");
    }, Math.max(0, expiresAt - Date.now()));
    this.expiry.unref?.();
  }

  private teardown(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.startup?.reject(new Error(`GPT-Live bridge closed during startup: ${reason}.`));
    this.startup = undefined;
    this.abort.abort();
    this.release();
    this.options.onClose(reason);
  }

  private release(): void {
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = undefined;
    this.expiryAt = undefined;
    this.peer?.close(); this.peer = undefined;
    const socket = this.socket; this.socket = undefined;
    if (socket?.readyState === WebSocket.OPEN) {
      try { socket.send(JSON.stringify({type: "session.close"})); } catch { /* Best-effort provider cleanup. */ }
    }
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "session stopped");
    if (this.reserved) { activeOwners.delete(this); this.reserved = false; }
  }
}
