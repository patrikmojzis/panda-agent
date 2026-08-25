import {randomUUID} from "node:crypto";

import type {LiveVoiceRepo} from "../../domain/live-voice/repo.js";
import {isActiveLiveVoiceTurn, type LiveVoiceTurnRecord} from "../../domain/live-voice/types.js";
import {isRetryableRuntimeInfrastructureError} from "../../domain/threads/requests/errors.js";
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

export interface LiveVoiceOutputSnapshot {
  state: string;
  responseEpoch: number;
  queuedMs: number;
  overruns: number;
}

export interface LiveVoiceOutput {
  pushPcm(audio: Buffer): void;
  interrupt(): void;
  reset(): void;
  getSnapshot(): LiveVoiceOutputSnapshot;
}

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
  ended: boolean;
  turnDone: boolean;
  delegated: boolean;
}

export type LiveVoiceUtteranceDecision =
  | {status: "accepted"; utteranceId: string}
  | {status: "continued"; utteranceId: string}
  | {status: "overlap" | "rate_limit" | "provider_unavailable"};

export interface LiveVoiceCallSnapshot {
  connected: boolean;
  recovering: boolean;
  closing: boolean;
  providerGeneration: number;
  providerReconnectCount: number;
  provider: LiveVoiceProviderHealth | undefined;
  live: LiveVoiceSessionSnapshot;
  output: LiveVoiceOutputSnapshot;
  playbackFailed: boolean;
  playbackUnderruns: number;
  outputDroppedMs: number;
  lastOutputAt?: number;
  captureActorId?: string;
  captureUtteranceId?: string;
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
  voice: Pick<LiveVoiceRepo,
    "createOrGetTurnAndEnqueueDelegation" | "getTurn" | "reserveFinalDelivery" | "releaseFinalDelivery" | "completeReservedFinal" | "failTurn"
  >;
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
  private activeUtterance?: LiveVoiceUtterance;
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
    if (this.closing) throw new Error("Live voice call is closed.");
    const combined = AbortSignal.any([this.abort.signal, ...(signal ? [signal] : [])]);
    const provider = this.createProvider();
    this.provider = provider;
    await provider.connect(combined);
    combined.throwIfAborted();
    this.connected = true;
    this.changed();
  }

  beginUtterance(actorId: string, now = Date.now()): LiveVoiceUtteranceDecision {
    if (this.closing || !this.connected || !this.provider) return {status: "provider_unavailable"};
    if (this.activeUtterance?.actorId === actorId) return {status: "continued", utteranceId: this.activeUtterance.id};
    if (this.activeUtterance) return {status: "overlap"};
    while (this.acceptedAt.length > 0 && this.acceptedAt[0]! <= now - 60_000) this.acceptedAt.shift();
    if (this.acceptedAt.length >= MAX_UTTERANCES_PER_MINUTE) return {status: "rate_limit"};
    this.acceptedAt.push(now);
    const utterance: LiveVoiceUtterance = {
      id: randomUUID(), actorId, startedAt: now, providerGeneration: this.providerGeneration,
      committed: false, ended: false, turnDone: false, delegated: false,
    };
    this.activeUtterance = utterance;
    this.changed();
    return {status: "accepted", utteranceId: utterance.id};
  }

  pushAudio(utteranceId: string, pcm24kMono: Buffer): boolean {
    const utterance = this.activeUtterance;
    if (!utterance || utterance.id !== utteranceId || this.closing || !this.connected || !this.provider || utterance.providerGeneration !== this.providerGeneration) {
      this.captureDroppedMs += Math.round(pcm24kMono.length / (24_000 * 2) * 1_000);
      this.changed();
      return false;
    }
    this.lastInputAt = Date.now();
    if (!utterance.committed) {
      if (!hasAudiblePcm16(pcm24kMono)) return false;
      utterance.committed = true;
      this.live.beginInput();
      this.provider.interrupt();
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

  endUtterance(utteranceId: string): void {
    const utterance = this.activeUtterance;
    if (!utterance || utterance.id !== utteranceId) return;
    utterance.ended = true;
    this.activeUtterance = undefined;
    if (utterance.committed) this.live.endInput();
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
    if (this.closing) return;
    this.playbackFailed = true;
    const now = Date.now();
    while (this.playbackFailureTimes.length > 0 && this.playbackFailureTimes[0]! <= now - PLAYBACK_FAILURE_WINDOW_MS) this.playbackFailureTimes.shift();
    this.playbackFailureTimes.push(now);
    this.options.log("live_voice_playback_failed", {message: safeFailureMessage(error)});
    this.options.output.reset();
    this.live.outputIdle();
    this.changed();
    if (this.playbackFailureTimes.length >= MAX_PLAYBACK_FAILURES_PER_WINDOW) this.options.onTerminalFailure("audio_output_failed");
  }

  async deliver(input: {controlId: string; text: string; mode: "progress" | "final"; liveVoiceTurnId?: string}): Promise<{delivery: "delegation" | "session"; turn?: LiveVoiceTurnRecord}> {
    if (!this.connected || !this.provider || this.closing) throw new Error("provider_unavailable");
    this.deliveryControlId = input.controlId;
    const channel: LiveVoiceContextChannel = input.mode === "progress" ? "commentary" : "speakable";
    let turn: LiveVoiceTurnRecord | undefined;
    let reserved = false;
    let sent = false;
    if (input.liveVoiceTurnId) {
      turn = await this.options.voice.getTurn(input.liveVoiceTurnId);
      if (!isActiveLiveVoiceTurn(turn) || turn.liveVoiceSessionId !== this.options.liveVoiceSessionId || turn.sessionId !== this.options.sessionId || turn.agentKey !== this.options.agentKey) throw new Error("voice_turn_conflict");
      const binding = this.turnBindingsById.get(turn.id);
      if (!binding || binding.providerGeneration !== this.providerGeneration) throw new Error("provider_unavailable");
      if (input.mode === "final") {
        const reservation = await this.options.voice.reserveFinalDelivery(turn.id, input.controlId, input.text);
        if (!reservation.reserved) throw new Error("voice_turn_conflict");
        reserved = true;
      }
      sent = this.provider.appendDelegationContext(binding.providerDelegationId, input.text, channel);
    } else {
      sent = this.provider.appendSessionContext(input.text, channel);
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
      recovering: Boolean(this.recovery),
      closing: this.closing,
      providerGeneration: this.providerGeneration,
      providerReconnectCount: this.providerReconnectCount,
      provider: this.provider?.getHealthSnapshot?.(),
      live: this.live.getSnapshot(),
      output,
      playbackFailed: this.playbackFailed,
      playbackUnderruns: this.playbackUnderruns,
      outputDroppedMs: output.overruns * 5_000,
      ...(this.lastOutputAt === undefined ? {} : {lastOutputAt: this.lastOutputAt}),
      ...(this.activeUtterance ? {captureActorId: this.activeUtterance.actorId, captureUtteranceId: this.activeUtterance.id} : {}),
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
    this.utterances.length = 0;
    return this.options.createProvider({
      initialItems: this.live.initialItems(),
      onAudio: (audio) => {
        if (!this.currentGeneration(generation)) return;
        this.lastOutputAt = Date.now();
        if (this.live.acceptOutput(audio.length)) {
          this.options.output.pushPcm(audio);
          this.playbackFailed = false;
        }
        this.changed();
      },
      onDelegation: (delegation) => this.currentGeneration(generation) ? this.delegateCurrentUtterance(generation, delegation.id, delegation.prompt) : undefined,
      onClearAudio: () => {
        if (!this.currentGeneration(generation)) return;
        this.options.output.interrupt();
        this.live.outputIdle();
        this.changed();
      },
      onTurnDone: ({role, transcript}) => {
        if (!this.currentGeneration(generation)) return;
        this.live.noteTurnDone({role, transcript});
        if (role === "user") {
          const attribution = this.utterances.find((candidate) => candidate.providerGeneration === generation && !candidate.turnDone);
          if (attribution) {
            attribution.turnDone = true;
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
    return !this.closing && generation === this.providerGeneration;
  }

  private handleProviderFailure(generation: number, failure: LiveVoiceProviderFailure): void {
    this.connected = false;
    if (!failure.retryable) {
      const reason = failure.code === "auth_unavailable" ? "auth_unavailable" : failure.code === "session_expired" ? "session_expired" : "provider_failed";
      this.options.onTerminalFailure(reason);
      return;
    }
    const now = Date.now();
    while (this.providerFailureTimes.length > 0 && this.providerFailureTimes[0]! <= now - PROVIDER_FAILURE_WINDOW_MS) this.providerFailureTimes.shift();
    this.providerFailureTimes.push(now);
    if (this.providerFailureTimes.length >= MAX_PROVIDER_FAILURES_PER_WINDOW) {
      this.options.onTerminalFailure("provider_unstable");
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
        if (!retryableStartupFailure(error)) { this.options.onTerminalFailure("provider_failed"); return; }
        failedGeneration = this.providerGeneration;
      }
    }
    this.options.onTerminalFailure("provider_failed");
  }

  private delegateCurrentUtterance(providerGeneration: number, providerDelegationId: string, prompt: string): Promise<void> | undefined {
    const attribution = this.utterances.find((candidate) => candidate.providerGeneration === providerGeneration && !candidate.delegated);
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
      if (!this.currentGeneration(providerGeneration) || this.abort.signal.aborted) {
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
