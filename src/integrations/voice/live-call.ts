import {randomUUID} from "node:crypto";

import type {LiveVoiceRepo} from "../../domain/live-voice/repo.js";
import {isActiveLiveVoiceTurn, type LiveVoiceTurnRecord} from "../../domain/live-voice/types.js";
import {isRetryableRuntimeInfrastructureError} from "../../domain/threads/requests/errors.js";
import type {JsonObject} from "../../lib/json.js";
import {hasAudiblePcm16} from "./pcm.js";
import {LiveVoiceSession, type LiveVoiceSessionSnapshot} from "./live-voice-session.js";
import type {
  LiveVoiceContextChannel,
  LiveVoiceProviderFactory,
  LiveVoiceProviderFailure,
  LiveVoiceProviderHealth,
  LiveVoiceProviderSession,
} from "./provider.js";

const MAX_UTTERANCES_PER_MINUTE = 30;
const PROVIDER_RECONNECT_DELAYS_MS = [0, 500, 1_500] as const;
const PROVIDER_FAILURE_WINDOW_MS = 5 * 60_000;
const MAX_PROVIDER_FAILURES_PER_WINDOW = 4;
const PLAYBACK_FAILURE_WINDOW_MS = 60_000;
const MAX_PLAYBACK_FAILURES_PER_WINDOW = 4;
const DELEGATION_CLOSE_WAIT_MS = 5_000;
const PROVIDER_TURN_TIMEOUT_MS = 10_000;
const DELIVERY_RECOVERY_WAIT_MS = 45_000;

export interface LiveVoiceOutputSnapshot {
  state: string;
  responseEpoch: number;
  queuedMs: number;
  overruns: number;
  transport?: JsonObject;
}

export interface LiveVoiceOutput {
  pushPcm(audio: Buffer): void;
  interrupt(): void;
  reset(): void;
  getSnapshot(): LiveVoiceOutputSnapshot;
}

/** Narrow persistence seam required by one transient live voice call. */
export type LiveVoiceStore = Pick<LiveVoiceRepo,
  "createOrGetTurnAndEnqueueDelegation" | "getTurn" | "reserveFinalDelivery" | "releaseFinalDelivery" | "completeReservedFinal" | "failTurn"
>;

interface LiveVoiceTurnBinding {
  liveVoiceTurnId: string;
  sourceUtteranceId: string;
  providerDelegationId: string;
  providerGeneration: number;
  creating: boolean;
}

interface LiveVoiceUtterance {
  id: string;
  actorId: string;
  startedAt: number;
  providerGeneration: number;
  committed: boolean;
  turnDone: boolean;
  delegated: boolean;
}

interface LiveVoiceCapture {
  id: string;
  actorId: string;
  providerGeneration: number;
  audible: boolean;
  utterance: LiveVoiceUtterance;
}

export type LiveVoiceCaptureDecision =
  | {status: "accepted"; captureId: string}
  | {status: "continued"; captureId: string}
  | {status: "overlap" | "rate_limit" | "provider_unavailable"};

export interface LiveVoiceCallSnapshot {
  connected: boolean;
  recovering: boolean;
  closing: boolean;
  terminalReason?: string;
  providerGeneration: number;
  providerReconnectCount: number;
  provider: LiveVoiceProviderHealth | undefined;
  live: LiveVoiceSessionSnapshot;
  output: LiveVoiceOutputSnapshot;
  playbackFailed: boolean;
  playbackUnderruns: number;
  providerOutputClears: number;
  outputDroppedMs: number;
  lastOutputAt?: number;
  captureActorId?: string;
  captureId?: string;
  captureDroppedMs: number;
  captureDroppedPackets: number;
  lastInputAt?: number;
  providerDelegationId?: string;
  liveVoiceTurnId?: string;
  delegationStatus?: string;
  delegationUpdatedAt?: number;
  deliveryControlId?: string;
}

export interface LiveVoiceCallOptions {
  liveVoiceSessionId: string;
  sessionId: string;
  agentKey: string;
  voice: LiveVoiceStore;
  createProvider: LiveVoiceProviderFactory;
  output: LiveVoiceOutput;
  log(event: string, payload: Record<string, unknown>): void;
  onStateChange?(): void;
  onTerminalFailure(reason: string): void;
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function safeFailureMessage(error: unknown): string {
  return errorMessage(error).replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 500);
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => finish(signal.reason instanceof Error ? signal.reason : new Error("Live voice call stopped."));
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

function boundedWait<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
    void promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

function retryableStartupFailure(error: unknown): boolean {
  const status = typeof error === "object" && error !== null && "status" in error ? Number(error.status) : undefined;
  if (status === 429 || (status !== undefined && status >= 500)) return true;
  if (status === 401 || status === 403) return false;
  const message = errorMessage(error).toLowerCase();
  if (message.includes("oauth") || message.includes("token") || message.includes("access denied")) return false;
  return message.includes("timeout") || message.includes("network") || message.includes("socket") || message.includes("closed") || message.includes("econn");
}

/** Owns channel-neutral provider, turn, barge-in, and durable delegation policy for one live call. */
export class LiveVoiceCall {
  private readonly abort = new AbortController();
  private readonly live = new LiveVoiceSession({onStateChange: () => this.changed()});
  private provider?: LiveVoiceProviderSession;
  private providerGeneration = 0;
  private connected = false;
  private recovery?: Promise<void>;
  private closing = false;
  private terminalReason?: string;
  private activeCapture?: LiveVoiceCapture;
  private pendingUtterance?: LiveVoiceUtterance;
  private providerTurnTimeout?: NodeJS.Timeout;
  private readonly utterances: LiveVoiceUtterance[] = [];
  private readonly acceptedAt: number[] = [];
  private readonly turnBindingsByUtterance = new Map<string, LiveVoiceTurnBinding>();
  private readonly turnBindingsById = new Map<string, LiveVoiceTurnBinding>();
  private readonly delegationPersistence = new Set<Promise<void>>();
  private readonly providerFailureTimes: number[] = [];
  private readonly playbackFailureTimes: number[] = [];
  private providerReconnectCount = 0;
  private playbackFailed = false;
  private playbackUnderruns = 0;
  private providerOutputClears = 0;
  private captureDroppedMs = 0;
  private captureDroppedPackets = 0;
  private lastInputAt?: number;
  private lastOutputAt?: number;
  private providerDelegationId?: string;
  private liveVoiceTurnId?: string;
  private delegationStatus?: string;
  private delegationUpdatedAt?: number;
  private deliveryControlId?: string;

  constructor(private readonly options: LiveVoiceCallOptions) {}

  async start(signal?: AbortSignal): Promise<void> {
    if (this.closing || this.terminalReason) throw new Error("Live voice call is closed.");
    const combined = AbortSignal.any([this.abort.signal, ...(signal ? [signal] : [])]);
    const provider = this.createProvider();
    this.provider = provider;
    await provider.connect(combined);
    combined.throwIfAborted();
    this.connected = true;
    this.changed();
  }

  beginCapture(actorId: string, now = Date.now()): LiveVoiceCaptureDecision {
    if (this.closing || !this.connected || !this.provider) return {status: "provider_unavailable"};
    if (this.activeCapture?.actorId === actorId) return {status: "continued", captureId: this.activeCapture.id};
    if (this.activeCapture) return {status: "overlap"};
    let utterance = this.pendingUtterance;
    if (utterance && !utterance.turnDone) {
      if (utterance.actorId !== actorId) return {status: "overlap"};
      this.clearProviderTurnTimeout();
    } else {
      utterance = this.reserveUtterance(actorId, now);
      if (!utterance) return {status: "rate_limit"};
    }
    const capture: LiveVoiceCapture = {
      id: randomUUID(), actorId, providerGeneration: this.providerGeneration, audible: false, utterance,
    };
    this.activeCapture = capture;
    this.changed();
    return {status: "accepted", captureId: capture.id};
  }

  pushAudio(captureId: string, pcm24kMono: Buffer): boolean {
    const capture = this.activeCapture;
    if (!capture || capture.id !== captureId || this.closing || !this.connected || !this.provider || capture.providerGeneration !== this.providerGeneration) {
      this.captureDroppedMs += Math.round(pcm24kMono.length / (24_000 * 2) * 1_000);
      this.changed();
      return false;
    }
    this.lastInputAt = Date.now();
    if (!capture.audible) {
      if (!hasAudiblePcm16(pcm24kMono)) return false;
      capture.audible = true;
      this.live.beginInput();
    }
    if (capture.utterance.turnDone) {
      const continuation = this.reserveUtterance(capture.actorId, Date.now());
      if (!continuation) {
        this.noteCaptureDrop(1, Math.round(pcm24kMono.length / (24_000 * 2) * 1_000));
        return false;
      }
      capture.utterance = continuation;
    }
    const utterance = capture.utterance;
    if (!utterance.committed) {
      utterance.committed = true;
      for (let index = this.utterances.length - 1; index >= 0; index -= 1) {
        const candidate = this.utterances[index]!;
        if (candidate.turnDone && !candidate.delegated) this.utterances.splice(index, 1);
      }
      this.utterances.push(utterance);
      if (this.utterances.length > 32) this.utterances.shift();
    }
    this.provider.sendAudio(pcm24kMono);
    this.changed();
    return true;
  }

  endCapture(captureId: string): void {
    const capture = this.activeCapture;
    if (!capture || capture.id !== captureId) return;
    const utterance = capture.utterance;
    this.activeCapture = undefined;
    if (capture.audible) this.live.endInput();
    if (!utterance.committed) {
      if (this.pendingUtterance === utterance) this.pendingUtterance = undefined;
    } else if (!utterance.turnDone) {
      this.scheduleProviderTurnTimeout(utterance);
    }
    this.changed();
  }

  noteCaptureDrop(packets = 1, milliseconds = 0): void {
    this.captureDroppedPackets += Math.max(0, packets);
    this.captureDroppedMs += Math.max(0, milliseconds);
    this.changed();
  }

  noteOutputIdle(underrun = false): void {
    if (underrun) this.playbackUnderruns += 1;
    this.live.outputIdle();
    this.changed();
  }

  noteOutputFailure(error: unknown): void {
    if (this.closing || this.terminalReason) return;
    this.playbackFailed = true;
    const now = Date.now();
    while (this.playbackFailureTimes.length > 0 && this.playbackFailureTimes[0]! <= now - PLAYBACK_FAILURE_WINDOW_MS) this.playbackFailureTimes.shift();
    this.playbackFailureTimes.push(now);
    this.options.log("live_voice_playback_failed", {message: safeFailureMessage(error)});
    if (this.playbackFailureTimes.length >= MAX_PLAYBACK_FAILURES_PER_WINDOW) {
      this.failTerminal("audio_output_failed");
      return;
    }
    this.options.output.reset();
    this.live.outputIdle();
    this.changed();
  }

  async deliver(input: {controlId: string; text: string; mode: "progress" | "final"; liveVoiceTurnId?: string}): Promise<{delivery: "delegation" | "session"; turn?: LiveVoiceTurnRecord}> {
    if (!this.connected && this.recovery && !this.closing && !this.terminalReason) {
      await boundedWait(this.recovery, DELIVERY_RECOVERY_WAIT_MS, "Live voice provider recovery timed out during delivery.");
    }
    if (!this.connected || !this.provider || this.closing) throw new Error("provider_unavailable");
    this.deliveryControlId = input.controlId;
    const channel: LiveVoiceContextChannel = input.mode === "progress" ? "commentary" : "speakable";
    let turn: LiveVoiceTurnRecord | undefined;
    let binding: LiveVoiceTurnBinding | undefined;
    let reserved = false;
    let sent = false;
    if (input.liveVoiceTurnId) {
      turn = await this.options.voice.getTurn(input.liveVoiceTurnId);
      if (!isActiveLiveVoiceTurn(turn) || turn.liveVoiceSessionId !== this.options.liveVoiceSessionId || turn.sessionId !== this.options.sessionId || turn.agentKey !== this.options.agentKey) throw new Error("voice_turn_conflict");
      binding = this.turnBindingsById.get(turn.id);
      if (!binding) throw new Error("provider_unavailable");
      if (input.mode === "final") {
        const reservation = await this.options.voice.reserveFinalDelivery(turn.id, input.controlId, input.text);
        if (!reservation.reserved) throw new Error("voice_turn_conflict");
        reserved = true;
      }
    }
    const append = async () => {
      const provider = this.provider;
      if (!this.connected || !provider || this.closing) return false;
      return binding?.providerGeneration === this.providerGeneration
        ? provider.appendDelegationContext(binding.providerDelegationId, input.text, channel)
        : provider.appendSessionContext(input.text, channel);
    };
    try {
      sent = await append();
      if (!sent && !this.closing) {
        const recovery = this.recovery;
        if (recovery) await boundedWait(recovery, DELIVERY_RECOVERY_WAIT_MS, "Live voice provider recovery timed out during delivery.");
        sent = await append();
      }
    } catch (error) {
      if (turn && reserved) await this.options.voice.releaseFinalDelivery(turn.id, input.controlId);
      throw error;
    }
    if (!sent) {
      if (turn && reserved) await this.options.voice.releaseFinalDelivery(turn.id, input.controlId);
      throw new Error("provider_unavailable");
    }
    if (turn && input.mode === "final") {
      await this.options.voice.completeReservedFinal(turn.id, input.controlId);
      this.releaseTurnBinding(turn.id);
    }
    this.delegationStatus = turn ? (input.mode === "final" ? "final_sent" : "progress_sent") : "proactive_sent";
    this.delegationUpdatedAt = Date.now();
    this.changed();
    return {delivery: turn ? "delegation" : "session", ...(turn ? {turn} : {})};
  }

  getSnapshot(): LiveVoiceCallSnapshot {
    const output = this.options.output.getSnapshot();
    return {
      connected: this.connected,
      recovering: !this.terminalReason && Boolean(this.recovery),
      closing: this.closing,
      ...(this.terminalReason ? {terminalReason: this.terminalReason} : {}),
      providerGeneration: this.providerGeneration,
      providerReconnectCount: this.providerReconnectCount,
      provider: this.provider?.getHealthSnapshot?.(),
      live: this.live.getSnapshot(),
      output,
      playbackFailed: this.playbackFailed,
      playbackUnderruns: this.playbackUnderruns,
      providerOutputClears: this.providerOutputClears,
      outputDroppedMs: output.overruns * 5_000,
      ...(this.lastOutputAt === undefined ? {} : {lastOutputAt: this.lastOutputAt}),
      ...(this.activeCapture ? {captureActorId: this.activeCapture.actorId, captureId: this.activeCapture.id} : {}),
      captureDroppedMs: this.captureDroppedMs,
      captureDroppedPackets: this.captureDroppedPackets,
      ...(this.lastInputAt === undefined ? {} : {lastInputAt: this.lastInputAt}),
      ...(this.providerDelegationId ? {providerDelegationId: this.providerDelegationId} : {}),
      ...(this.liveVoiceTurnId ? {liveVoiceTurnId: this.liveVoiceTurnId} : {}),
      ...(this.delegationStatus ? {delegationStatus: this.delegationStatus} : {}),
      ...(this.delegationUpdatedAt === undefined ? {} : {delegationUpdatedAt: this.delegationUpdatedAt}),
      ...(this.deliveryControlId ? {deliveryControlId: this.deliveryControlId} : {}),
    };
  }

  async close(reason: string): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.abort.abort(new Error(`Live voice call closed: ${reason}.`));
    this.connected = false;
    this.clearProviderTurnTimeout();
    this.provider?.close();
    this.provider = undefined;
    this.live.close();
    this.options.output.reset();
    const turnIds = [...this.turnBindingsById.keys()];
    this.turnBindingsById.clear();
    this.turnBindingsByUtterance.clear();
    await Promise.all(turnIds.map((turnId) => this.options.voice.failTurn(turnId, `Live voice session ended: ${reason}.`).catch(() => undefined)));
    const persistence = [...this.delegationPersistence];
    if (persistence.length > 0) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled(persistence),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, DELEGATION_CLOSE_WAIT_MS);
          timer.unref?.();
        }),
      ]);
      if (timer) clearTimeout(timer);
    }
    this.changed();
  }

  private createProvider(): LiveVoiceProviderSession {
    const generation = ++this.providerGeneration;
    this.clearProviderTurnTimeout();
    const capture = this.activeCapture;
    if (capture?.audible) this.live.endInput();
    this.pendingUtterance = undefined;
    this.utterances.length = 0;
    if (capture) {
      capture.providerGeneration = generation;
      capture.audible = false;
      capture.utterance.providerGeneration = generation;
      capture.utterance.committed = false;
      capture.utterance.turnDone = false;
      capture.utterance.delegated = false;
      this.pendingUtterance = capture.utterance;
    }
    return this.options.createProvider({
      initialItems: this.live.initialItems(),
      onAudio: (audio) => {
        if (!this.currentGeneration(generation)) return;
        this.lastOutputAt = Date.now();
        if (this.live.acceptOutput()) {
          this.options.output.pushPcm(audio);
          this.playbackFailed = false;
        }
        this.changed();
      },
      onDelegation: (delegation) => this.currentGeneration(generation) ? this.delegateCurrentUtterance(generation, delegation.id, delegation.prompt) : undefined,
      onOutputAudioCleared: () => {
        if (!this.currentGeneration(generation)) return;
        this.providerOutputClears += 1;
        const hadOutput = this.live.noteOutputAudioCleared();
        this.options.output.interrupt();
        this.options.log("live_voice_output_audio_cleared", {providerGeneration: generation, hadOutput});
        this.changed();
      },
      onTurnDone: ({role, transcript}) => {
        if (!this.currentGeneration(generation)) return;
        this.live.noteTurnDone({role, transcript});
        if (role === "user") {
          const attribution = this.utterances.find((candidate) => candidate.providerGeneration === generation && !candidate.turnDone);
          if (attribution) {
            attribution.turnDone = true;
            if (this.pendingUtterance === attribution) this.pendingUtterance = undefined;
            this.clearProviderTurnTimeout();
            if (attribution.delegated) this.removeUtterance(attribution);
          }
        }
        if (role === "assistant") this.delegationUpdatedAt = Date.now();
        this.changed();
      },
      onFailure: (failure) => {
        if (this.currentGeneration(generation)) this.handleProviderFailure(generation, failure);
      },
    });
  }

  private currentGeneration(generation: number): boolean {
    return !this.closing && !this.terminalReason && generation === this.providerGeneration;
  }

  private reserveUtterance(actorId: string, now: number): LiveVoiceUtterance | undefined {
    while (this.acceptedAt.length > 0 && this.acceptedAt[0]! <= now - 60_000) this.acceptedAt.shift();
    if (this.acceptedAt.length >= MAX_UTTERANCES_PER_MINUTE) return undefined;
    this.acceptedAt.push(now);
    const utterance: LiveVoiceUtterance = {
      id: randomUUID(), actorId, startedAt: now, providerGeneration: this.providerGeneration,
      committed: false, turnDone: false, delegated: false,
    };
    this.pendingUtterance = utterance;
    return utterance;
  }

  private scheduleProviderTurnTimeout(utterance: LiveVoiceUtterance): void {
    this.clearProviderTurnTimeout();
    this.providerTurnTimeout = setTimeout(() => {
      this.providerTurnTimeout = undefined;
      if (!this.currentGeneration(utterance.providerGeneration) || !this.connected || this.pendingUtterance !== utterance || utterance.turnDone || this.activeCapture?.utterance === utterance) return;
      this.options.log("live_voice_provider_turn_timeout", {providerGeneration: utterance.providerGeneration});
      this.handleProviderFailure(utterance.providerGeneration, {
        source: "sideband", code: "transport_failed", retryable: true,
        message: "GPT-Live omitted turn.done after an accepted capture.",
      });
    }, PROVIDER_TURN_TIMEOUT_MS);
    this.providerTurnTimeout.unref?.();
  }

  private clearProviderTurnTimeout(): void {
    if (this.providerTurnTimeout) clearTimeout(this.providerTurnTimeout);
    this.providerTurnTimeout = undefined;
  }

  private handleProviderFailure(generation: number, failure: LiveVoiceProviderFailure): void {
    if (!this.currentGeneration(generation)) return;
    this.connected = false;
    this.clearProviderTurnTimeout();
    if (!failure.retryable) {
      const reason = failure.code === "auth_unavailable" ? "auth_unavailable" : failure.code === "session_expired" ? "session_expired" : "provider_failed";
      this.failTerminal(reason);
      return;
    }
    const now = Date.now();
    while (this.providerFailureTimes.length > 0 && this.providerFailureTimes[0]! <= now - PROVIDER_FAILURE_WINDOW_MS) this.providerFailureTimes.shift();
    this.providerFailureTimes.push(now);
    if (this.providerFailureTimes.length >= MAX_PROVIDER_FAILURES_PER_WINDOW) {
      this.failTerminal("provider_unstable");
      return;
    }
    this.providerReconnectCount += 1;
    this.options.output.reset();
    this.live.outputIdle();
    this.changed();
    if (!this.recovery) {
      this.recovery = this.recoverProvider(generation)
        .catch((error: unknown) => this.options.log("live_voice_provider_recovery_failed", {message: safeFailureMessage(error)}))
        .finally(() => { this.recovery = undefined; this.changed(); });
    }
  }

  private async recoverProvider(failedGeneration: number): Promise<void> {
    const oldProvider = this.provider;
    for (const [index, delayMs] of PROVIDER_RECONNECT_DELAYS_MS.entries()) {
      if (delayMs > 0) await abortableDelay(delayMs, this.abort.signal);
      if (this.closing || this.abort.signal.aborted || failedGeneration !== this.providerGeneration) return;
      oldProvider?.close();
      const provider = this.createProvider();
      this.provider = provider;
      try {
        await provider.connect(this.abort.signal);
        if (this.closing || this.abort.signal.aborted || this.provider !== provider) { provider.close(); return; }
        this.connected = true;
        this.options.log("live_voice_provider_reconnected", {attempt: index + 1});
        this.changed();
        return;
      } catch (error) {
        provider.close();
        if (this.closing || this.abort.signal.aborted) return;
        this.options.log("live_voice_provider_reconnect_failed", {attempt: index + 1, message: safeFailureMessage(error)});
        if (!retryableStartupFailure(error)) { this.failTerminal("provider_failed"); return; }
        failedGeneration = this.providerGeneration;
      }
    }
    this.failTerminal("provider_failed");
  }

  private failTerminal(reason: string): void {
    if (this.closing || this.terminalReason) return;
    this.terminalReason = reason;
    this.connected = false;
    this.clearProviderTurnTimeout();
    this.abort.abort(new Error(`Live voice call failed: ${reason}.`));
    this.provider?.close();
    this.provider = undefined;
    this.options.output.reset();
    this.live.outputIdle();
    this.changed();
    this.options.onTerminalFailure(reason);
  }

  private delegateCurrentUtterance(providerGeneration: number, providerDelegationId: string, prompt: string): Promise<void> | undefined {
    const pending = this.pendingUtterance;
    const attribution = pending?.providerGeneration === providerGeneration && pending.committed && !pending.delegated
      ? pending
      : [...this.utterances].reverse().find((candidate) => candidate.providerGeneration === providerGeneration && candidate.turnDone && !candidate.delegated);
    if (!attribution) {
      this.options.log("live_voice_delegation_dropped", {reason: "actor_attribution_unavailable"});
      return;
    }
    attribution.delegated = true;
    if (attribution.turnDone) this.removeUtterance(attribution);
    const persistence = this.delegate(providerGeneration, providerDelegationId, prompt, attribution);
    this.delegationPersistence.add(persistence);
    void persistence.then(
      () => { this.delegationPersistence.delete(persistence); },
      () => { this.delegationPersistence.delete(persistence); },
    );
    return persistence;
  }

  private async delegate(providerGeneration: number, providerDelegationId: string, prompt: string, attribution: LiveVoiceUtterance): Promise<void> {
    const existing = this.turnBindingsByUtterance.get(attribution.id);
    if (existing) {
      if (existing.creating || isActiveLiveVoiceTurn(await this.options.voice.getTurn(existing.liveVoiceTurnId))) {
        existing.providerDelegationId = providerDelegationId;
        existing.providerGeneration = providerGeneration;
        this.providerDelegationId = providerDelegationId;
        this.liveVoiceTurnId = existing.liveVoiceTurnId;
        this.delegationStatus = existing.creating ? "creating" : "queued";
        this.delegationUpdatedAt = Date.now();
        this.changed();
        this.options.log("live_voice_delegation_rebound", {liveVoiceTurnId: existing.liveVoiceTurnId});
        return;
      }
      this.releaseTurnBinding(existing.liveVoiceTurnId);
    }
    const id = randomUUID();
    const binding: LiveVoiceTurnBinding = {liveVoiceTurnId: id, sourceUtteranceId: attribution.id, providerDelegationId, providerGeneration, creating: true};
    this.turnBindingsByUtterance.set(attribution.id, binding);
    this.turnBindingsById.set(id, binding);
    this.providerDelegationId = providerDelegationId;
    this.liveVoiceTurnId = id;
    this.delegationStatus = "creating";
    this.delegationUpdatedAt = Date.now();
    this.changed();
    try {
      const turnInput = {
        id,
        liveVoiceSessionId: this.options.liveVoiceSessionId,
        providerDelegationId,
        sourceUtteranceId: attribution.id,
        sessionId: this.options.sessionId,
        agentKey: this.options.agentKey,
        externalActorId: attribution.actorId,
        prompt,
      };
      let turn: LiveVoiceTurnRecord;
      let retryAttempt = 0;
      while (true) {
        try {
          turn = await this.options.voice.createOrGetTurnAndEnqueueDelegation(turnInput);
          break;
        } catch (error) {
          if (!isRetryableRuntimeInfrastructureError(error)) throw error;
          retryAttempt += 1;
          this.delegationStatus = "retrying";
          this.delegationUpdatedAt = Date.now();
          this.changed();
          this.options.log("live_voice_delegation_retrying", {
            liveVoiceTurnId: binding.liveVoiceTurnId,
            retryAttempt,
            message: safeFailureMessage(error),
          });
          await abortableDelay(Math.min(2_000, retryAttempt * 250), this.abort.signal);
        }
      }
      if (this.closing || this.abort.signal.aborted) {
        await this.options.voice.failTurn(turn.id, "Live voice session ended before delegation enqueue completed.");
        this.releaseTurnBinding(binding.liveVoiceTurnId);
        return;
      }
      if (!isActiveLiveVoiceTurn(turn)) { this.releaseTurnBinding(id); return; }
      if (turn.id !== id) {
        this.turnBindingsById.delete(id);
        binding.liveVoiceTurnId = turn.id;
        this.turnBindingsById.set(turn.id, binding);
      }
      binding.creating = false;
      this.liveVoiceTurnId = turn.id;
      this.delegationStatus = "queued";
      this.delegationUpdatedAt = Date.now();
      this.changed();
      this.options.log("live_voice_delegation_queued", {liveVoiceTurnId: turn.id});
    } catch (error) {
      this.releaseTurnBinding(binding.liveVoiceTurnId);
      await this.options.voice.failTurn(binding.liveVoiceTurnId, "Failed to enqueue the live voice delegation.").catch(() => undefined);
      throw error;
    }
  }

  private releaseTurnBinding(liveVoiceTurnId: string): void {
    const binding = this.turnBindingsById.get(liveVoiceTurnId);
    if (!binding) return;
    this.turnBindingsById.delete(liveVoiceTurnId);
    if (this.turnBindingsByUtterance.get(binding.sourceUtteranceId) === binding) this.turnBindingsByUtterance.delete(binding.sourceUtteranceId);
  }

  private removeUtterance(utterance: LiveVoiceUtterance): void {
    const index = this.utterances.indexOf(utterance);
    if (index >= 0) this.utterances.splice(index, 1);
  }

  private changed(): void { this.options.onStateChange?.(); }
}
