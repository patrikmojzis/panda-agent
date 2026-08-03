import WebSocket, {type RawData} from "ws";

import {resolveOpenAILiveAuth, type OpenAILiveAuth} from "./auth.js";
import {WeriftOpenAILiveAudioPeer, type OpenAILiveAudioPeer} from "./peer.js";
import {buildHeaders, createOpenAILiveCall, createRequestIds, delegationAppendMessages, parseOpenAILiveEvent, type OpenAILiveRequestIds} from "./wire.js";

const CONNECT_TIMEOUT_MS = 30_000;
const SESSION_TTL_MS = 30 * 60_000;
const MAX_SESSIONS = 8;
const activeOwners = new Set<object>();

export interface RealtimeVoiceDelegation {id: string; prompt: string}
export interface RealtimeVoiceBridge {
  connect(): Promise<void>;
  sendAudio(pcm24kMono: Buffer): void;
  noteAudioPlayed(durationMs: number): void;
  interrupt(): void;
  appendDelegationResult(delegationId: string, text: string): boolean;
  getActiveDelegationId(): string | undefined;
  close(): void;
}

export interface RealtimeVoiceBridgeOptions {
  env?: NodeJS.ProcessEnv;
  voice?: string;
  onAudio(audio: Buffer): void;
  onDelegation(delegation: RealtimeVoiceDelegation): Promise<void> | void;
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

function waitForOpen(socket: WebSocket, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onOpen = () => finish();
    const onError = (error: Error) => finish(error);
    const onClose = () => finish(new Error("GPT-Live sideband closed during startup."));
    const onAbort = () => finish(signal.reason instanceof Error ? signal.reason : new Error("GPT-Live startup stopped."));
    const finish = (error?: Error) => {
      socket.off("open", onOpen); socket.off("error", onError); socket.off("close", onClose); signal.removeEventListener("abort", onAbort);
      error ? reject(error) : resolve();
    };
    if (signal.aborted) {
      finish(signal.reason instanceof Error ? signal.reason : new Error("GPT-Live startup stopped."));
      return;
    }
    socket.once("open", onOpen); socket.once("error", onError); socket.once("close", onClose); signal.addEventListener("abort", onAbort, {once: true});
  });
}

export class OpenAILiveRealtimeVoiceBridge implements RealtimeVoiceBridge {
  private readonly abort = new AbortController();
  private peer?: OpenAILiveAudioPeer;
  private socket?: WebSocket;
  private ids?: OpenAILiveRequestIds;
  private activeDelegationId?: string;
  private activeOutputItemId?: string;
  private playedOutputMs = 0;
  private expiry?: NodeJS.Timeout;
  private expiryAt?: number;
  private startup?: {reject(error: Error): void};
  private closed = false;
  private reserved = false;

  constructor(private readonly options: RealtimeVoiceBridgeOptions) {}

  async connect(): Promise<void> {
    if (this.closed) throw new Error("GPT-Live bridge is closed.");
    if (activeOwners.size >= MAX_SESSIONS) throw new Error("GPT-Live session limit reached.");
    activeOwners.add(this); this.reserved = true;
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(CONNECT_TIMEOUT_MS)]);
    try {
      const factory = this.options.createPeer ?? ((callbacks, createSignal) => WeriftOpenAILiveAudioPeer.create(callbacks, createSignal));
      this.peer = await factory({onAudio: this.options.onAudio, onError: (error) => this.fail(error)}, signal);
      const offerSdp = await this.peer.createOffer();
      const auth = (this.options.resolveAuth ?? (() => resolveOpenAILiveAuth(this.options.env)))();
      this.ids = createRequestIds();
      const call = await createOpenAILiveCall({auth, ids: this.ids, offerSdp, voice: this.options.voice ?? "cove", signal, fetchImpl: this.options.fetchImpl});
      await this.peer.applyAnswer(call.answerSdp);
      const startupFailure = new Promise<never>((_, reject) => { this.startup = {reject}; });
      await Promise.race([
        Promise.all([
          this.peer.waitUntilConnected(signal),
          this.connectSideband(call.sidebandUrl, auth, this.ids, signal),
        ]),
        startupFailure,
      ]);
      this.startup = undefined;
      this.scheduleExpiry(SESSION_TTL_MS);
    } catch (error) {
      this.closed = true;
      this.startup = undefined;
      this.abort.abort(error);
      this.release();
      throw error;
    }
  }

  sendAudio(audio: Buffer): void { this.peer?.sendAudio(audio); }

  noteAudioPlayed(durationMs: number): void {
    if (Number.isFinite(durationMs) && durationMs > 0) this.playedOutputMs += durationMs;
  }

  interrupt(): void {
    this.options.onClearAudio();
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({type: "response.cancel"}));
      if (this.activeOutputItemId && this.playedOutputMs > 0) {
        this.socket.send(JSON.stringify({type: "conversation.item.truncate", item_id: this.activeOutputItemId, content_index: 0, audio_end_ms: Math.floor(this.playedOutputMs)}));
      }
      this.socket.send(JSON.stringify({type: "output_audio_buffer.clear"}));
    }
    this.activeOutputItemId = undefined;
    this.playedOutputMs = 0;
  }

  appendDelegationResult(delegationId: string, text: string): boolean {
    if (delegationId !== this.activeDelegationId || this.socket?.readyState !== WebSocket.OPEN) return false;
    for (const message of delegationAppendMessages(delegationId, text)) this.socket.send(message);
    return true;
  }

  getActiveDelegationId(): string | undefined { return this.activeDelegationId; }

  close(): void { this.teardown("completed"); }

  private async connectSideband(url: string, auth: OpenAILiveAuth, ids: OpenAILiveRequestIds, signal: AbortSignal): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const headers = buildHeaders(auth, ids);
      const socket = this.options.createSocket?.(url, headers) ?? new WebSocket(url, {headers, maxPayload: 1024 * 1024});
      try {
        await waitForOpen(socket, signal);
        this.socket = socket;
        socket.on("message", (data, isBinary) => { if (isBinary) return this.fail(new Error("GPT-Live sideband sent binary data.")); this.handleEvent(rawText(data)); });
        socket.on("error", (error) => this.fail(error));
        socket.on("close", (code) => { if (!this.closed) this.fail(new Error(`GPT-Live sideband closed (${code}).`)); });
        return;
      } catch (error) {
        if (this.socket === socket) this.socket = undefined;
        lastError = error;
        socket.on("error", () => undefined);
        socket.close();
        if (attempt < 2) await new Promise<void>((resolve) => { const timer = setTimeout(resolve, 200 * 2 ** attempt); timer.unref?.(); });
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
    if (event.kind === "output_item") {
      if (event.id !== this.activeOutputItemId) this.playedOutputMs = 0;
      this.activeOutputItemId = event.id;
      return;
    }
    if (event.kind === "error") {
      if (event.fatalAuth) this.fail(new Error("Codex OAuth became unavailable."));
      else this.options.log("gpt_live_sideband_error", {message: event.message});
      return;
    }
    this.activeDelegationId = event.id;
    void Promise.resolve(this.options.onDelegation(event)).catch((error: unknown) => this.options.log("gpt_live_delegation_failed", {message: error instanceof Error ? error.message : String(error)}));
  }

  private fail(error: Error): void {
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
    this.expiry = setTimeout(() => this.fail(new Error("GPT-Live session expired.")), Math.max(0, expiresAt - Date.now()));
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
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "session stopped");
    if (this.reserved) { activeOwners.delete(this); this.reserved = false; }
  }
}
