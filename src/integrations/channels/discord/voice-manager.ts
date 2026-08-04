import {randomUUID} from "node:crypto";
import {DrainLoop} from "../../../lib/drain-loop.js";

import {
  AudioPlayerStatus,
  EndBehaviorType,
  VoiceConnectionStatus,
  createAudioPlayer,
  entersState,
  joinVoiceChannel,
  type DiscordGatewayAdapterCreator,
  type VoiceConnection,
} from "@discordjs/voice";
import {createDecoder, createEncoder, Application, type OpusDecoderHandle, type OpusEncoderHandle} from "libopus-wasm";

import type {RuntimeRequestRepo} from "../../../domain/threads/requests/repo.js";
import type {DiscordChannelMetadata, DiscordWorkerRestClient} from "./api.js";
import {OpenAILiveRealtimeVoiceBridge, type RealtimeVoiceBridge, type RealtimeVoiceFailure} from "../../providers/openai-live/bridge.js";
import {resamplePcm16} from "../../providers/openai-live/peer.js";
import type {DiscordVoiceStore} from "./voice-postgres.js";
import {DISCORD_VOICE_MODEL, type DiscordVoiceControlRecord, type DiscordVoiceTurnRecord} from "./voice-types.js";
import {deriveDiscordVoiceHealth, type DiscordVoiceDiagnosticSnapshot, type DiscordVoiceInfrastructureHealth} from "./voice-health.js";
import {DiscordVoicePlayback} from "./discord-voice-playback.js";

const MAX_UTTERANCE_MS = 60_000;
const MAX_UTTERANCES_PER_MINUTE = 30;
const VOICE_READY_TIMEOUT_MS = 15_000;
const VOICE_RECONNECT_GRACE_MS = 15_000;
const VOICE_SESSION_TTL_MS = 30 * 60_000;
const PROVIDER_RECONNECT_DELAYS_MS = [0, 500, 1_500] as const;
const PROVIDER_FAILURE_WINDOW_MS = 5 * 60_000;
const MAX_PROVIDER_FAILURES_PER_WINDOW = 4;
const MAX_PENDING_INPUT_BYTES = 64 * 1024;
const MAX_PROVIDER_INPUT_BYTES = 24_000 * 2;
const LIVE_PCM_BYTES_PER_MS = 24_000 * 2 / 1_000;
const CAPTURE_SILENCE_MS = 1_000;
const HEALTH_LOG_INTERVAL_MS = 10_000;
const HEALTH_PERSIST_INTERVAL_MS = 30_000;
const VOICE_JOIN_GUIDANCE = "Voice is live. Speak at any time with `panda discord voice send --text <message>`. For longer delegated work, send brief `--mode progress` updates and finish with `--mode final`.";

type VoiceInputStream = ReturnType<VoiceConnection["receiver"]["subscribe"]>;

interface ActiveVoiceTurnBinding {
  voiceTurnId: string;
  sourceUtteranceId: string;
  delegationId: string;
  bridgeGeneration: number;
  creating: boolean;
}

interface VoiceUtteranceAttribution {
  id: string;
  speakerId: string;
  startedAt: number;
  bridgeGeneration: number;
  turnDone: boolean;
  delegated: boolean;
}

class DiscordVoicePcmQueue {
  private readonly chunks: Buffer[] = [];
  private headOffset = 0;
  private bytes = 0;

  constructor(private readonly maxBytes: number) {}

  get byteLength(): number { return this.bytes; }

  push(input: Buffer): number {
    if (input.length === 0) return 0;
    this.chunks.push(Buffer.from(input));
    this.bytes += input.length;
    const dropped = Math.max(0, this.bytes - this.maxBytes);
    if (dropped > 0) this.discard(dropped);
    return dropped;
  }

  shift(size: number): Buffer | undefined {
    if (this.bytes < size) return undefined;
    const output = Buffer.allocUnsafe(size);
    let written = 0;
    while (written < size) {
      const chunk = this.chunks[0]!;
      const available = chunk.length - this.headOffset;
      const copied = Math.min(size - written, available);
      chunk.copy(output, written, this.headOffset, this.headOffset + copied);
      written += copied;
      this.headOffset += copied;
      this.bytes -= copied;
      if (this.headOffset === chunk.length) { this.chunks.shift(); this.headOffset = 0; }
    }
    return output;
  }

  clear(): void {
    this.chunks.length = 0;
    this.headOffset = 0;
    this.bytes = 0;
  }

  private discard(size: number): void {
    let remaining = size;
    while (remaining > 0) {
      const chunk = this.chunks[0]!;
      const available = chunk.length - this.headOffset;
      const discarded = Math.min(remaining, available);
      this.headOffset += discarded;
      this.bytes -= discarded;
      remaining -= discarded;
      if (this.headOffset === chunk.length) { this.chunks.shift(); this.headOffset = 0; }
    }
  }
}

interface ActiveVoiceSession {
  connectorKey: string;
  guildId: string;
  channelId: string;
  sessionId: string;
  agentKey: string;
  voiceSessionId: string;
  connection: VoiceConnection;
  bridge: RealtimeVoiceBridge;
  playback: DiscordVoicePlayback;
  player: ReturnType<typeof createAudioPlayer>;
  speakers: DiscordVoiceSpeakerArbiter;
  inputStreams: Set<VoiceInputStream>;
  turnBindingsByUtterance: Map<string, ActiveVoiceTurnBinding>;
  turnBindingsById: Map<string, ActiveVoiceTurnBinding>;
  utteranceAttributions: VoiceUtteranceAttribution[];
  bridgeGeneration: number;
  failedBridgeGeneration?: number;
  providerRecovery?: Promise<void>;
  providerInputPending: DiscordVoicePcmQueue;
  providerFailureTimes: number[];
  lifecycleEpoch: number;
  expiry?: NodeJS.Timeout;
  healthTimer?: NodeJS.Timeout;
  health: {
    connected: boolean;
    discordVoiceStateAt: number;
    providerReconnectCount: number;
    playbackState: string;
    responseEpoch: number;
    responseActive: boolean;
    outputDroppedMs: number;
    playbackUnderruns: number;
    playbackFailed: boolean;
    lastOutputAt?: number;
    captureSpeakerId?: string;
    captureUtteranceId?: string;
    captureQueuedMs: number;
    captureDroppedMs: number;
    captureDroppedPackets: number;
    lastInputAt?: number;
    delegationId?: string;
    voiceTurnId?: string;
    delegationStatus?: string;
    delegationUpdatedAt?: number;
    deliveryControlId?: string;
    lastPersistedAt: number;
    lastPersistedKey?: string;
  };
  closing: boolean;
}

interface GuildRoomSlot {
  tail: Promise<void>;
  epoch: number;
  abort?: AbortController;
}

export interface DiscordVoiceManagerOptions {
  connectorKey: string;
  botToken: string;
  env?: NodeJS.ProcessEnv;
  gatewayAdapter(guildId: string): DiscordGatewayAdapterCreator;
  restClient: Pick<DiscordWorkerRestClient, "getChannelMetadata">;
  store: DiscordVoiceStore;
  requests: Pick<RuntimeRequestRepo, "enqueueRequest">;
  log(event: string, payload: Record<string, unknown>): void;
  getInfrastructureHealth?: () => DiscordVoiceInfrastructureHealth;
  createBridge?: (options: ConstructorParameters<typeof OpenAILiveRealtimeVoiceBridge>[0]) => RealtimeVoiceBridge;
  createInputDecoder?: typeof createDecoder;
  sessionTtlMs?: number;
  openVoiceTransport?: (input: {channelId: string; guildId: string; adapterCreator: DiscordGatewayAdapterCreator; group: string}) => Promise<{
    connection: VoiceConnection;
    player: ReturnType<typeof createAudioPlayer>;
    outputEncoder: OpusEncoderHandle;
  }>;
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function safeFailureMessage(error: unknown): string {
  return errorMessage(error).replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 500);
}

function classifyFailure(error: unknown): string {
  const status = typeof error === "object" && error !== null && "status" in error ? Number(error.status) : undefined;
  if (status === 401) return "auth_unavailable";
  if (status === 403) return "provider_startup_failed";
  const message = errorMessage(error).toLowerCase();
  if (message.includes("oauth") || message.includes("401") || message.includes("token")) return "auth_unavailable";
  if (message.includes("timed out") || message.includes("timeout") || message.includes("within")) return "timeout";
  if (message.includes("channel")) return "invalid_channel";
  return "provider_startup_failed";
}

function isPermissionFailure(error: unknown): boolean {
  const status = typeof error === "object" && error !== null && "status" in error ? Number(error.status) : undefined;
  const message = errorMessage(error).toLowerCase();
  return status === 401 || status === 403 || message.includes("401") || message.includes("403") || message.includes("permission") || message.includes("forbidden");
}

function isRetryableProviderStartupFailure(error: unknown): boolean {
  const status = typeof error === "object" && error !== null && "status" in error ? Number(error.status) : undefined;
  if (status === 429 || (status !== undefined && status >= 500)) return true;
  if (status === 401 || status === 403) return false;
  const message = errorMessage(error).toLowerCase();
  if (message.includes("oauth") || message.includes("token") || message.includes("access denied")) return false;
  return message.includes("timeout")
    || message.includes("timed out")
    || message.includes("network")
    || message.includes("socket")
    || message.includes("closed")
    || message.includes("econn");
}

function controlError(failureCode: string, message: string): string {
  return JSON.stringify({failureCode, message: message.slice(0, 500)});
}

export class DiscordVoiceSpeakerArbiter {
  activeSpeakerId?: string;
  private acceptedAt: number[] = [];

  start(userId: string, connectorUserId: string, now = Date.now()): "accepted" | "continued" | "self" | "overlap" | "rate_limit" {
    if (userId === connectorUserId) return "self";
    if (this.activeSpeakerId === userId) return "continued";
    if (this.activeSpeakerId) return "overlap";
    this.acceptedAt = this.acceptedAt.filter((value) => value > now - 60_000);
    if (this.acceptedAt.length >= MAX_UTTERANCES_PER_MINUTE) return "rate_limit";
    this.acceptedAt.push(now);
    this.activeSpeakerId = userId;
    return "accepted";
  }

  finish(userId: string): void {
    if (this.activeSpeakerId === userId) this.activeSpeakerId = undefined;
  }
}

function activeVoiceTurn(turn: DiscordVoiceTurnRecord): boolean {
  return turn.status === "pending" || turn.status === "queued" || turn.status === "running" || turn.status === "awaiting_final";
}

function requireVoiceChannel(metadata: DiscordChannelMetadata): {guildId: string; channelId: string} {
  if (metadata.type !== 2 || !metadata.guildId) throw new Error("Target channel is not a guild voice channel.");
  return {guildId: metadata.guildId, channelId: metadata.id};
}

function samplesToBuffer(samples: Int16Array): Buffer {
  const output = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) output.writeInt16LE(samples[index] ?? 0, index * 2);
  return output;
}

function discordPcmToLive(decoded: Int16Array): Buffer {
  const mono = new Int16Array(Math.floor(decoded.length / 2));
  for (let i = 0; i < mono.length; i += 1) mono[i] = Math.round(((decoded[i * 2] ?? 0) + (decoded[i * 2 + 1] ?? 0)) / 2);
  return samplesToBuffer(resamplePcm16(mono, 48_000, 24_000));
}

function destroyVoiceConnection(connection: VoiceConnection): void {
  const status = (connection as VoiceConnection & {state?: {status?: string}}).state?.status;
  if (status !== VoiceConnectionStatus.Destroyed) connection.destroy();
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Discord voice operation was cancelled.");
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => finish(abortError(signal));
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

function awaitAbortable<T>(promise: Promise<T>, signal: AbortSignal, disposeLate: (value: T) => void): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, {once: true});
    void promise.then((value) => {
      signal.removeEventListener("abort", onAbort);
      if (settled) { disposeLate(value); return; }
      settled = true;
      resolve(value);
    }, (error: unknown) => {
      signal.removeEventListener("abort", onAbort);
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

async function openVoiceTransport(input: {channelId: string; guildId: string; adapterCreator: DiscordGatewayAdapterCreator; group: string}) {
  const connection = joinVoiceChannel({...input, selfDeaf: false, selfMute: false});
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, VOICE_READY_TIMEOUT_MS);
    const player = createAudioPlayer();
    const outputEncoder = await createEncoder({application: Application.Voip, channels: 2, sampleRate: 48_000, frameSize: 960});
    return {connection, player, outputEncoder};
  } catch (error) {
    destroyVoiceConnection(connection);
    throw error;
  }
}

export class DiscordVoiceSessionManager {
  private readonly sessions = new Map<string, ActiveVoiceSession>();
  private readonly guildSlots = new Map<string, GuildRoomSlot>();
  private stopped = false;

  constructor(private readonly options: DiscordVoiceManagerOptions) {}

  async start(): Promise<void> {
    this.stopped = false;
    await this.options.store.markConnectorSessionsDisconnected(this.options.connectorKey, "worker_restarted");
    await this.options.store.failRunningControls(this.options.connectorKey, controlError("worker_unavailable", "Discord voice worker restarted."));
    await this.options.store.failConnectorActiveTurns?.(this.options.connectorKey, "Discord voice worker restarted; any in-flight speech outcome is unknown.");
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const slot of this.guildSlots.values()) {
      slot.epoch += 1;
      slot.abort?.abort(new Error("Discord voice worker stopped."));
    }
    await Promise.all([...this.sessions.keys()].map((guildId) => this.stopGuild(guildId, "worker_stopped")));
    await Promise.all([...this.guildSlots.values()].map((slot) => slot.tail.catch(() => undefined)));
    await this.options.store.markConnectorSessionsDisconnected(this.options.connectorKey, "worker_stopped");
  }

  async handle(control: DiscordVoiceControlRecord): Promise<Record<string, unknown>> {
    if (this.stopped) throw new Error(controlError("worker_unavailable", "Discord voice worker is unavailable."));
    if (control.operation === "join") return this.join(control);
    if (control.operation === "send") return this.send(control);
    return this.leave(control);
  }

  async rollbackSupersededControl(control: DiscordVoiceControlRecord, result: Record<string, unknown>): Promise<void> {
    if (control.operation !== "join" || typeof result.guildId !== "string" || typeof result.voiceSessionId !== "string") return;
    const session = this.sessions.get(result.guildId);
    if (session?.voiceSessionId === result.voiceSessionId) await this.stopGuild(session.guildId, "control_timed_out");
  }

  private async join(control: DiscordVoiceControlRecord): Promise<Record<string, unknown>> {
    if (!control.channelId) throw new Error(controlError("invalid_channel", "Voice channel id is required."));
    let channel: {guildId: string; channelId: string};
    try { channel = requireVoiceChannel(await this.options.restClient.getChannelMetadata(this.options.botToken, control.channelId)); }
    catch (error) {
      const failureCode = isPermissionFailure(error) ? "permission_denied" : "invalid_channel";
      throw new Error(controlError(failureCode, errorMessage(error)));
    }
    return this.serializeGuild(channel.guildId, () => this.joinGuild(control, channel));
  }

  private async joinGuild(control: DiscordVoiceControlRecord, channel: {guildId: string; channelId: string}): Promise<Record<string, unknown>> {
    if (this.stopped) throw new Error(controlError("worker_unavailable", "Discord voice worker is unavailable."));
    const current = this.sessions.get(channel.guildId);
    if (current) {
      if (current.sessionId !== control.sessionId) throw new Error(controlError("session_conflict", "Another Panda session owns voice in this guild."));
      if (current.channelId === channel.channelId) return this.result(current, "connected");
      await this.stopGuildNow(channel.guildId, "moved_channel");
    }

    const slot = this.getGuildSlot(channel.guildId);
    slot.epoch += 1;
    slot.abort?.abort(new Error("Discord voice join was superseded."));
    const abort = new AbortController();
    slot.abort = abort;
    const epoch = slot.epoch;

    const voiceSessionId = randomUUID();
    await this.options.store.upsertSession({connectorKey: control.connectorKey, guildId: channel.guildId, channelId: channel.channelId, sessionId: control.sessionId, agentKey: control.agentKey, voiceSessionId, state: "connecting", model: DISCORD_VOICE_MODEL});
    let connection: VoiceConnection | undefined;
    let session: ActiveVoiceSession | undefined;
    try {
      const transportPromise = (this.options.openVoiceTransport ?? openVoiceTransport)({channelId: channel.channelId, guildId: channel.guildId, adapterCreator: this.options.gatewayAdapter(channel.guildId), group: this.options.connectorKey});
      const transport = await awaitAbortable(transportPromise, abort.signal, (late) => this.disposeTransport(late));
      connection = transport.connection;
      const {player, outputEncoder} = transport;
      const bridgeFactory = this.options.createBridge ?? ((options) => new OpenAILiveRealtimeVoiceBridge(options));
      session = {
        connectorKey: control.connectorKey, guildId: channel.guildId, channelId: channel.channelId, sessionId: control.sessionId,
        agentKey: control.agentKey, voiceSessionId, connection, player,
        speakers: new DiscordVoiceSpeakerArbiter(), inputStreams: new Set(), turnBindingsByUtterance: new Map(), turnBindingsById: new Map(), utteranceAttributions: [],
        bridgeGeneration: 0,
        providerInputPending: new DiscordVoicePcmQueue(MAX_PROVIDER_INPUT_BYTES),
        providerFailureTimes: [],
        lifecycleEpoch: epoch,
        closing: false,
        health: {
          connected: false,
          discordVoiceStateAt: Date.now(),
          providerReconnectCount: 0,
          playbackState: AudioPlayerStatus.Idle,
          responseEpoch: 0,
          responseActive: false,
          outputDroppedMs: 0,
          playbackUnderruns: 0,
          playbackFailed: false,
          captureQueuedMs: 0,
          captureDroppedMs: 0,
          captureDroppedPackets: 0,
          lastPersistedAt: 0,
        },
        bridge: undefined as unknown as RealtimeVoiceBridge,
        playback: undefined as unknown as DiscordVoicePlayback,
      };
      session.playback = new DiscordVoicePlayback({
        player,
        encoder: outputEncoder,
        onError: (error) => this.handlePlaybackFailure(session!, error),
        onStateChange: () => this.syncPlaybackHealth(session!),
      });
      session.bridge = this.createBridge(session, bridgeFactory);
      connection.subscribe(player);
      await session.bridge.connect(abort.signal);
      if (abort.signal.aborted || slot.epoch !== epoch || this.stopped) throw abortError(abort.signal);
      session.health.connected = true;
      this.sessions.set(channel.guildId, session);
      this.startHealthReporter(session);
      this.attachPlayerLifecycle(session);
      this.attachReceiver(session);
      this.attachConnectionLifecycle(session);
      const activeSession = session;
      session.expiry = setTimeout(() => this.stopGuildSafely(activeSession.guildId, "session_expired"), this.options.sessionTtlMs ?? VOICE_SESSION_TTL_MS);
      session.expiry.unref?.();
      await this.options.store.upsertSession({connectorKey: control.connectorKey, guildId: channel.guildId, channelId: channel.channelId, sessionId: control.sessionId, agentKey: control.agentKey, voiceSessionId, state: "connected", model: DISCORD_VOICE_MODEL});
      await this.reportHealth(session, true);
      this.options.log("voice_connected", {connectorKey: control.connectorKey, guildId: channel.guildId, channelId: channel.channelId, sessionId: control.sessionId, model: DISCORD_VOICE_MODEL});
      return this.result(session, "connected");
    } catch (error) {
      const failureCode = classifyFailure(error);
      if (session && this.sessions.get(channel.guildId) === session) await this.stopGuildNow(channel.guildId, failureCode);
      else {
        if (session) this.disposeSessionResources(session);
        else if (connection) destroyVoiceConnection(connection);
        await this.options.store.markSessionDisconnected(control.connectorKey, channel.guildId, "error", failureCode);
      }
      throw new Error(controlError(failureCode, errorMessage(error)));
    }
  }

  private async leave(control: DiscordVoiceControlRecord): Promise<Record<string, unknown>> {
    const session = [...this.sessions.values()].find((candidate) => candidate.sessionId === control.sessionId && candidate.agentKey === control.agentKey && (!control.channelId || candidate.channelId === control.channelId));
    if (!session) throw new Error(controlError("invalid_channel", "No owned active Discord voice session matched."));
    if (control.voiceTurnId) {
      const turn = await this.options.store.getTurn(control.voiceTurnId);
      if (!activeVoiceTurn(turn) || turn.sessionId !== session.sessionId || turn.agentKey !== session.agentKey || turn.voiceSessionId !== session.voiceSessionId) {
        throw new Error(controlError("voice_turn_conflict", "The Discord voice turn is not active or does not belong to this voice session."));
      }
      await this.options.store.completeTurn(turn.id, "Left the Discord voice channel.");
      this.releaseTurnBinding(session, turn.id);
    }
    const result = this.result(session, "disconnected");
    await this.stopGuild(session.guildId, "requested");
    return {...result, ...(control.voiceTurnId ? {voiceTurnId: control.voiceTurnId} : {})};
  }

  private async send(control: DiscordVoiceControlRecord): Promise<Record<string, unknown>> {
    if (!control.channelId || !control.text || !control.mode) throw new Error(controlError("invalid_input", "Discord voice send requires channel, text, and mode."));
    const session = [...this.sessions.values()].find((candidate) => (
      candidate.sessionId === control.sessionId
      && candidate.agentKey === control.agentKey
      && candidate.channelId === control.channelId
    ));
    if (!session) throw new Error(controlError("voice_session_unavailable", "No matching active Discord voice session is connected."));
    session.health.deliveryControlId = control.id;

    const channel = control.mode === "progress" ? "commentary" : "speakable";
    let delivery: "delegation" | "session" = "session";
    let turn: Awaited<ReturnType<DiscordVoiceStore["getTurn"]>> | undefined;
    let finalReserved = false;
    let sent = false;
    if (control.voiceTurnId) {
      turn = await this.options.store.getTurn(control.voiceTurnId);
      if (!activeVoiceTurn(turn) || turn.sessionId !== session.sessionId || turn.agentKey !== session.agentKey || turn.voiceSessionId !== session.voiceSessionId) {
        throw new Error(controlError("voice_turn_conflict", "The Discord voice turn is not active or does not belong to this voice session."));
      }
      const binding = session.turnBindingsById.get(turn.id);
      if (!binding || binding.bridgeGeneration !== session.bridgeGeneration) {
        throw new Error(controlError("provider_unavailable", "The delegated voice turn is not bound to the current GPT-Live session."));
      }
      if (control.mode === "final") {
        const reservation = await this.options.store.reserveFinalDelivery(turn.id, control.id, control.text);
        if (!reservation.reserved) throw new Error(controlError("voice_turn_conflict", "A final voice delivery was already reserved or completed."));
        finalReserved = true;
      }
      sent = session.bridge.appendDelegationContext(binding.delegationId, control.text, channel);
      if (sent) delivery = "delegation";
    }
    else sent = session.bridge.appendSessionContext(control.text, channel);
    if (!sent) {
      if (turn && finalReserved) await this.options.store.releaseFinalDelivery(turn.id, control.id);
      throw new Error(controlError("provider_unavailable", "GPT-Live is not ready to accept voice context."));
    }
    if (turn && control.mode === "final") {
      await this.options.store.completeReservedFinal(turn.id, control.id);
      this.releaseTurnBinding(session, turn.id);
    }
    session.health.delegationStatus = turn ? (control.mode === "final" ? "final_sent" : "progress_sent") : "proactive_sent";
    session.health.delegationUpdatedAt = Date.now();
    void this.reportHealth(session, true);
    this.options.log("voice_context_sent", {connectorKey: session.connectorKey, guildId: session.guildId, channelId: session.channelId, mode: control.mode, delivery, ...(turn ? {voiceTurnId: turn.id} : {})});
    return {ok: true, state: "sent", connectorKey: session.connectorKey, guildId: session.guildId, channelId: session.channelId, sessionId: session.sessionId, voiceSessionId: session.voiceSessionId, model: DISCORD_VOICE_MODEL, mode: control.mode, delivery, ...(turn ? {voiceTurnId: turn.id} : {})};
  }

  private result(session: ActiveVoiceSession, state: "connected" | "disconnected"): Record<string, unknown> {
    return {ok: true, state, connectorKey: session.connectorKey, guildId: session.guildId, channelId: session.channelId, sessionId: session.sessionId, voiceSessionId: session.voiceSessionId, model: DISCORD_VOICE_MODEL, ...(state === "connected" ? {guidance: VOICE_JOIN_GUIDANCE} : {})};
  }

  private startHealthReporter(session: ActiveVoiceSession): void {
    if (session.healthTimer) clearInterval(session.healthTimer);
    session.healthTimer = setInterval(() => {
      void this.reportHealth(session).catch((error: unknown) => this.options.log("voice_health_failed", {
        connectorKey: session.connectorKey,
        guildId: session.guildId,
        message: safeFailureMessage(error),
      }));
    }, HEALTH_LOG_INTERVAL_MS);
    session.healthTimer.unref?.();
    void this.reportHealth(session, true);
  }

  private async reportHealth(session: ActiveVoiceSession, transition = false): Promise<void> {
    if (session.closing || this.sessions.get(session.guildId) !== session) return;
    this.syncPlaybackHealth(session);
    const now = Date.now();
    const infrastructure = this.options.getInfrastructureHealth?.() ?? {};
    const bridge = session.bridge.getHealthSnapshot?.();
    const connectionState = (session.connection as VoiceConnection & {state?: {status?: string}}).state?.status ?? "unknown";
    const providerState = session.providerRecovery
      ? "recovering"
      : bridge?.state ?? (session.health.connected ? "connected" : "connecting");
    const health = deriveDiscordVoiceHealth({
      connecting: !session.health.connected && !session.providerRecovery,
      closing: session.closing,
      discordVoiceReady: connectionState === VoiceConnectionStatus.Ready,
      gateway: infrastructure.gateway,
      providerState,
      listenerStatus: infrastructure.listener?.status,
      poolWaiting: infrastructure.pool?.waitingCount,
      audioDropped: session.health.outputDroppedMs > 0 || session.health.captureDroppedPackets > 0,
      playbackFailed: session.health.playbackFailed,
    });
    const media = bridge?.media;
    const snapshot: DiscordVoiceDiagnosticSnapshot = {
      version: 1,
      observedAt: now,
      state: health.state,
      reasons: health.reasons,
      identity: {connectorKey: session.connectorKey, guildId: session.guildId, channelId: session.channelId, voiceSessionId: session.voiceSessionId},
      gateway: infrastructure.gateway ?? null,
      discordVoice: {state: connectionState, stateAt: session.health.discordVoiceStateAt, dave: "unknown"},
      provider: {
        generation: session.bridgeGeneration,
        state: providerState,
        sidebandState: bridge?.sidebandState ?? "connecting",
        sidebandOpenedAt: bridge?.sidebandOpenedAt ?? null,
        sidebandAgeMs: bridge?.sidebandAgeMs ?? null,
        lastPingAt: bridge?.lastPingAt ?? null,
        lastPongAt: bridge?.lastPongAt ?? null,
        pongAgeMs: bridge?.pongAgeMs ?? null,
        lastRtpAt: media?.lastRtpAt ?? null,
        rtpAgeMs: media?.lastRtpAt ? Math.max(0, now - media.lastRtpAt) : null,
        reconnectCount: session.health.providerReconnectCount,
        lastCloseCode: bridge?.lastCloseCode ?? null,
        lastCloseOpenForMs: bridge?.lastCloseOpenForMs ?? null,
        malformedEvents: bridge?.malformedEvents ?? 0,
        unknownEvents: bridge?.unknownEvents ?? 0,
      },
      playback: {
        state: session.health.playbackState,
        responseEpoch: session.health.responseEpoch,
        queuedMs: session.playback.getSnapshot().queuedMs,
        droppedMs: session.health.outputDroppedMs,
        underruns: session.health.playbackUnderruns,
        lastAudioAt: session.health.lastOutputAt ?? null,
      },
      capture: {
        state: session.health.captureUtteranceId ? "capturing" : "idle",
        speakerId: session.health.captureSpeakerId ?? null,
        utteranceId: session.health.captureUtteranceId ?? null,
        queuedMs: session.health.captureQueuedMs,
        droppedMs: session.health.captureDroppedMs + (media?.droppedInputMs ?? 0),
        droppedPackets: session.health.captureDroppedPackets,
        lastAudioAt: session.health.lastInputAt ?? null,
      },
      delegation: {
        delegationId: session.health.delegationId ?? null,
        voiceTurnId: session.health.voiceTurnId ?? null,
        runId: null,
        deliveryControlId: session.health.deliveryControlId ?? null,
        status: session.health.delegationStatus ?? null,
        updatedAt: session.health.delegationUpdatedAt ?? null,
      },
      postgres: {
        listenerStatus: infrastructure.listener?.status ?? null,
        listenerLastConnectedAt: infrastructure.listener?.lastConnectedAt ?? null,
        listenerLastErrorAt: infrastructure.listener?.lastErrorAt ?? null,
        poolMax: infrastructure.pool?.max ?? null,
        poolTotal: infrastructure.pool?.totalCount ?? null,
        poolIdle: infrastructure.pool?.idleCount ?? null,
        poolWaiting: infrastructure.pool?.waitingCount ?? null,
      },
    };
    this.options.log("discord_voice_health", {transition, snapshot});
    const persistedKey = `${health.state}:${health.reasons.join(",")}`;
    if (persistedKey === session.health.lastPersistedKey && now - session.health.lastPersistedAt < HEALTH_PERSIST_INTERVAL_MS) return;
    session.health.lastPersistedKey = persistedKey;
    session.health.lastPersistedAt = now;
    await this.options.store.updateSessionHealth?.({
      connectorKey: session.connectorKey,
      guildId: session.guildId,
      voiceSessionId: session.voiceSessionId,
      health: health.state,
      reasons: health.reasons,
      observedAt: now,
    });
  }

  private attachReceiver(session: ActiveVoiceSession): void {
    session.connection.receiver.speaking.on("start", (userId) => {
      const decision = session.speakers.start(userId, this.options.connectorKey);
      if (decision !== "accepted") {
        if (decision !== "self" && decision !== "continued") this.options.log("voice_utterance_dropped", {connectorKey: session.connectorKey, guildId: session.guildId, channelId: session.channelId, speakerId: userId, reason: decision});
        return;
      }
      session.bridge.interrupt();
      const utteranceId = randomUUID();
      const attribution: VoiceUtteranceAttribution = {
        id: utteranceId,
        speakerId: userId,
        startedAt: Date.now(),
        bridgeGeneration: session.bridgeGeneration,
        turnDone: false,
        delegated: false,
      };
      let attributionCommitted = false;
      session.health.captureSpeakerId = userId;
      session.health.captureUtteranceId = utteranceId;
      session.health.delegationUpdatedAt = Date.now();
      void this.reportHealth(session, true);
      let stream: VoiceInputStream;
      try {
        stream = session.connection.receiver.subscribe(userId, {end: {behavior: EndBehaviorType.AfterSilence, duration: CAPTURE_SILENCE_MS}});
      } catch (error) {
        session.speakers.finish(userId);
        this.options.log("voice_utterance_dropped", {connectorKey: session.connectorKey, guildId: session.guildId, channelId: session.channelId, speakerId: userId, reason: "subscribe_failed", message: safeFailureMessage(error)});
        return;
      }
      session.inputStreams.add(stream);
      const timer = setTimeout(() => stream.destroy(new Error("Maximum Discord voice utterance exceeded.")), MAX_UTTERANCE_MS);
      timer.unref?.();
      let decoder: OpusDecoderHandle | undefined;
      let pendingPackets: Buffer[] = [];
      let pendingBytes = 0;
      let released = false;
      const decode = (packet: Buffer) => {
        try {
          if (session.closing || !decoder || session.bridgeGeneration !== attribution.bridgeGeneration) return;
          const pcm = discordPcmToLive(decoder.decode(packet, {maxFrameSize: 5_760}));
          if (pcm.length === 0) return;
          if (!attributionCommitted) {
            attributionCommitted = true;
            // A completed, undelegated predecessor was casual speech. Retire it
            // before admitting the next provider user turn.
            session.utteranceAttributions = session.utteranceAttributions.filter((candidate) => !candidate.turnDone);
            session.utteranceAttributions.push(attribution);
            if (session.utteranceAttributions.length > 32) session.utteranceAttributions.shift();
          }
          this.sendProviderInput(session, pcm);
        }
        catch (error) { this.options.log("voice_decode_failed", {connectorKey: session.connectorKey, guildId: session.guildId, speakerId: userId, message: errorMessage(error)}); }
      };
      const onData = (packet: Buffer) => {
        if (released || session.closing) return;
        session.health.lastInputAt = Date.now();
        const copy = Buffer.from(packet);
        if (decoder) { decode(copy); return; }
        while (pendingPackets.length > 0 && pendingBytes + copy.length > MAX_PENDING_INPUT_BYTES) {
          pendingBytes -= pendingPackets.shift()!.length;
          session.health.captureDroppedPackets += 1;
        }
        if (copy.length <= MAX_PENDING_INPUT_BYTES) { pendingPackets.push(copy); pendingBytes += copy.length; }
        else session.health.captureDroppedPackets += 1;
        session.health.captureQueuedMs = Math.round(pendingBytes / LIVE_PCM_BYTES_PER_MS);
      };
      const release = () => {
        if (released) return;
        released = true;
        clearTimeout(timer);
        stream.off("data", onData);
        session.inputStreams.delete(stream);
        session.speakers.finish(userId);
        if (session.health.captureUtteranceId === utteranceId) {
          session.health.captureSpeakerId = undefined;
          session.health.captureUtteranceId = undefined;
          session.health.captureQueuedMs = 0;
        }
        pendingPackets = [];
        pendingBytes = 0;
        decoder?.free();
        decoder = undefined;
      };
      stream.on("data", onData);
      stream.once("end", release);
      stream.once("close", release);
      stream.once("error", (error) => {
        this.options.log("voice_utterance_ended", {connectorKey: session.connectorKey, guildId: session.guildId, speakerId: userId, message: error.message});
        release();
      });
      const decoderFactory = this.options.createInputDecoder ?? createDecoder;
      void Promise.resolve().then(() => decoderFactory({channels: 2, sampleRate: 48_000})).then((created) => {
        if (released || session.closing) { created.free(); return; }
        decoder = created;
        const packets = pendingPackets;
        pendingPackets = [];
        pendingBytes = 0;
        for (const packet of packets) decode(packet);
      }).catch((error: unknown) => stream.destroy(error instanceof Error ? error : new Error(String(error))));
    });
  }

  private attachPlayerLifecycle(session: ActiveVoiceSession): void {
    session.player.on("error", (error) => {
      this.handlePlaybackFailure(session, error);
    });
    session.player.on("stateChange", (_oldState, newState) => {
      const state = session.playback.getSnapshot().state;
      if (newState.status === AudioPlayerStatus.Idle && (state === "streaming" || state === "preroll")) session.health.playbackUnderruns += 1;
      this.syncPlaybackHealth(session);
      void this.reportHealth(session, true);
    });
  }

  private handlePlaybackFailure(session: ActiveVoiceSession, error: unknown): void {
    if (session.closing) return;
    session.health.playbackFailed = true;
    this.options.log("voice_playback_failed", {connectorKey: session.connectorKey, guildId: session.guildId, channelId: session.channelId, message: safeFailureMessage(error)});
    this.stopGuildSafely(session.guildId, "discord_audio_failed");
  }

  private syncPlaybackHealth(session: ActiveVoiceSession): void {
    const playback = session.playback.getSnapshot();
    session.health.playbackState = playback.state;
    session.health.responseEpoch = playback.responseEpoch;
    session.health.responseActive = playback.state !== "idle" && playback.state !== "closed";
    session.health.outputDroppedMs = playback.overruns * 5_000;
  }

  private attachConnectionLifecycle(session: ActiveVoiceSession): void {
    if (typeof (session.connection as unknown as {on?: unknown}).on !== "function") return;
    session.connection.on("error", (error) => {
      if (session.closing) return;
      this.options.log("voice_connection_failed", {connectorKey: session.connectorKey, guildId: session.guildId, channelId: session.channelId, message: safeFailureMessage(error)});
      this.stopGuildSafely(session.guildId, "discord_connection_failed");
    });
    session.connection.on("stateChange", (_oldState, newState) => {
      if (session.closing) return;
      session.health.discordVoiceStateAt = Date.now();
      void this.reportHealth(session, true);
      if (newState.status === VoiceConnectionStatus.Destroyed) {
        this.stopGuildSafely(session.guildId, "discord_connection_destroyed");
        return;
      }
      if (newState.status === VoiceConnectionStatus.Disconnected) {
        void entersState(session.connection, VoiceConnectionStatus.Ready, VOICE_RECONNECT_GRACE_MS).catch(() => this.stopGuildSafely(session.guildId, "discord_reconnect_failed"));
      }
    });
  }

  private clearPlayback(session: ActiveVoiceSession): void {
    if (session.closing) return;
    session.playback.interrupt();
    this.syncPlaybackHealth(session);
    void this.reportHealth(session, true);
  }

  private createBridge(session: ActiveVoiceSession, bridgeFactory = this.options.createBridge ?? ((options) => new OpenAILiveRealtimeVoiceBridge(options))): RealtimeVoiceBridge {
    const droppedInputBytes = session.providerInputPending.byteLength;
    if (droppedInputBytes > 0) session.health.captureDroppedMs += Math.round(droppedInputBytes / LIVE_PCM_BYTES_PER_MS);
    session.providerInputPending.clear();
    session.utteranceAttributions = [];
    const generation = ++session.bridgeGeneration;
    const lifecycleEpoch = session.lifecycleEpoch;
    return bridgeFactory({
      env: this.options.env, voice: this.options.env?.PANDA_DISCORD_VOICE_VOICE ?? "cove",
      onAudio: (audio) => {
        if (!this.isCurrentBridge(session, lifecycleEpoch, generation)) return;
        session.health.lastOutputAt = Date.now();
        session.playback.pushPcm(audio);
        this.syncPlaybackHealth(session);
      },
      onDelegation: (delegation) => this.isCurrentBridge(session, lifecycleEpoch, generation) ? this.delegateCurrentUtterance(session, generation, delegation.id, delegation.prompt) : undefined,
      onClearAudio: () => {
        if (!this.isCurrentBridge(session, lifecycleEpoch, generation)) return;
        try { this.clearPlayback(session); } catch (error) { this.handlePlaybackFailure(session, error); }
      },
      onTurnDone: ({role}) => {
        if (!this.isCurrentBridge(session, lifecycleEpoch, generation)) return;
        if (role === "user") {
          const attribution = session.utteranceAttributions.find((candidate) => candidate.bridgeGeneration === generation && !candidate.turnDone);
          if (attribution) {
            attribution.turnDone = true;
            if (attribution.delegated) session.utteranceAttributions = session.utteranceAttributions.filter((candidate) => candidate !== attribution);
          }
          return;
        }
        if (role !== "assistant") return;
        session.playback.finishResponse();
        this.syncPlaybackHealth(session);
        session.health.delegationUpdatedAt = Date.now();
        void this.reportHealth(session, true);
      },
      onFailure: (failure) => {
        if (!this.isCurrentBridge(session, lifecycleEpoch, generation)) return;
        this.handleProviderFailure(session, generation, failure);
      },
      log: this.options.log,
    });
  }

  private isCurrentBridge(session: ActiveVoiceSession, lifecycleEpoch: number, generation: number): boolean {
    return !session.closing
      && session.lifecycleEpoch === lifecycleEpoch
      && this.getGuildSlot(session.guildId).epoch === lifecycleEpoch
      && session.bridgeGeneration === generation
      && this.sessions.get(session.guildId) === session;
  }

  private handleProviderFailure(session: ActiveVoiceSession, generation: number, failure: RealtimeVoiceFailure): void {
    if (!failure.retryable) {
      const reason = failure.code === "auth_unavailable" ? "auth_unavailable"
        : failure.code === "session_expired" ? "session_expired"
          : "provider_failed";
      this.stopGuildSafely(session.guildId, reason);
      return;
    }
    const now = Date.now();
    session.providerFailureTimes = session.providerFailureTimes.filter((failedAt) => failedAt > now - PROVIDER_FAILURE_WINDOW_MS);
    session.providerFailureTimes.push(now);
    if (session.providerFailureTimes.length >= MAX_PROVIDER_FAILURES_PER_WINDOW) {
      this.options.log("voice_provider_circuit_open", {connectorKey: session.connectorKey, guildId: session.guildId, channelId: session.channelId, failures: session.providerFailureTimes.length, windowMs: PROVIDER_FAILURE_WINDOW_MS});
      this.stopGuildSafely(session.guildId, "provider_unstable");
      return;
    }
    session.failedBridgeGeneration = generation;
    session.health.connected = false;
    session.health.providerReconnectCount += 1;
    session.playback.reset();
    this.syncPlaybackHealth(session);
    void this.reportHealth(session, true);
    this.recoverProvider(session);
  }

  private recoverProvider(session: ActiveVoiceSession): void {
    if (session.providerRecovery || session.closing || this.sessions.get(session.guildId) !== session) return;
    session.providerRecovery = this.runProviderRecovery(session)
      .catch(async (error: unknown) => {
        this.options.log("voice_provider_recovery_failed", {connectorKey: session.connectorKey, guildId: session.guildId, channelId: session.channelId, message: safeFailureMessage(error)});
        await this.stopGuild(session.guildId, "provider_failed").catch((stopError: unknown) => this.options.log("voice_disconnect_failed", {connectorKey: session.connectorKey, guildId: session.guildId, message: safeFailureMessage(stopError)}));
      })
      .finally(() => {
        session.providerRecovery = undefined;
        if (session.failedBridgeGeneration === session.bridgeGeneration) this.recoverProvider(session);
      });
  }

  private async runProviderRecovery(session: ActiveVoiceSession): Promise<void> {
    const signal = this.getGuildSlot(session.guildId).abort?.signal;
    if (!signal) return;
    for (const [index, delayMs] of PROVIDER_RECONNECT_DELAYS_MS.entries()) {
      if (delayMs > 0) await abortableDelay(delayMs, signal).catch(() => undefined);
      if (signal.aborted) return;
      if (session.closing || this.sessions.get(session.guildId) !== session) return;
      const bridge = this.createBridge(session);
      session.bridge = bridge;
      try {
        await bridge.connect(signal);
        if (session.closing || this.sessions.get(session.guildId) !== session) { bridge.close(); return; }
        if (session.failedBridgeGeneration === session.bridgeGeneration) continue;
        session.failedBridgeGeneration = undefined;
        session.health.connected = true;
        this.flushProviderInput(session);
        await this.reportHealth(session, true);
        this.options.log("voice_provider_reconnected", {connectorKey: session.connectorKey, guildId: session.guildId, channelId: session.channelId, attempt: index + 1});
        return;
      } catch (error) {
        bridge.close();
        if (signal.aborted || session.closing) return;
        const failureCode = classifyFailure(error);
        this.options.log("voice_provider_reconnect_failed", {connectorKey: session.connectorKey, guildId: session.guildId, channelId: session.channelId, attempt: index + 1, failureCode, message: safeFailureMessage(error)});
        if (!isRetryableProviderStartupFailure(error)) { await this.stopGuild(session.guildId, failureCode); return; }
      }
    }
    await this.stopGuild(session.guildId, "provider_failed");
  }

  private sendProviderInput(session: ActiveVoiceSession, pcm: Buffer): void {
    if (session.health.connected) {
      session.bridge.sendAudio(pcm);
      return;
    }
    const dropped = session.providerInputPending.push(pcm);
    if (dropped > 0) session.health.captureDroppedMs += Math.round(dropped / LIVE_PCM_BYTES_PER_MS);
  }

  private flushProviderInput(session: ActiveVoiceSession): void {
    while (session.health.connected && session.providerInputPending.byteLength > 0) {
      const size = Math.min(4_800, session.providerInputPending.byteLength);
      session.bridge.sendAudio(session.providerInputPending.shift(size)!);
    }
  }

  private delegateCurrentUtterance(session: ActiveVoiceSession, bridgeGeneration: number, delegationId: string, prompt: string): Promise<void> | undefined {
    const attribution = session.utteranceAttributions.find((candidate) => candidate.bridgeGeneration === bridgeGeneration && !candidate.delegated);
    if (!attribution) {
      this.options.log("voice_delegation_dropped", {connectorKey: session.connectorKey, guildId: session.guildId, channelId: session.channelId, reason: "speaker_attribution_unavailable"});
      return;
    }
    attribution.delegated = true;
    if (attribution.turnDone) session.utteranceAttributions = session.utteranceAttributions.filter((candidate) => candidate !== attribution);
    return this.delegate(session, bridgeGeneration, delegationId, prompt, attribution);
  }

  private async delegate(session: ActiveVoiceSession, bridgeGeneration: number, delegationId: string, prompt: string, attribution: VoiceUtteranceAttribution): Promise<void> {
    const existing = session.turnBindingsByUtterance.get(attribution.id);
    if (existing) {
      if (existing.creating || activeVoiceTurn(await this.options.store.getTurn(existing.voiceTurnId))) {
        existing.delegationId = delegationId;
        existing.bridgeGeneration = bridgeGeneration;
        this.options.log("voice_delegation_rebound", {connectorKey: session.connectorKey, guildId: session.guildId, channelId: session.channelId, voiceTurnId: existing.voiceTurnId});
        return;
      }
      this.releaseTurnBinding(session, existing.voiceTurnId);
    }
    const id = randomUUID();
    const binding: ActiveVoiceTurnBinding = {voiceTurnId: id, sourceUtteranceId: attribution.id, delegationId, bridgeGeneration, creating: true};
    session.turnBindingsByUtterance.set(attribution.id, binding);
    session.turnBindingsById.set(id, binding);
    session.health.delegationId = delegationId;
    session.health.voiceTurnId = id;
    session.health.delegationStatus = "creating";
    session.health.delegationUpdatedAt = Date.now();
    try {
      const {turn} = await this.options.store.createOrGetTurn({id, voiceSessionId: session.voiceSessionId, delegationId, connectorKey: session.connectorKey, guildId: session.guildId, channelId: session.channelId, sessionId: session.sessionId, agentKey: session.agentKey, externalActorId: attribution.speakerId, sourceUtteranceId: attribution.id, prompt});
      if (!activeVoiceTurn(turn)) {
        this.releaseTurnBinding(session, id);
        return;
      }
      if (turn.id !== id) {
        session.turnBindingsById.delete(id);
        binding.voiceTurnId = turn.id;
        session.turnBindingsById.set(turn.id, binding);
      }
      binding.creating = false;
      await this.options.requests.enqueueRequest(
        {kind: "discord_voice_delegation", payload: {voiceTurnId: turn.id}},
        {idempotencyKey: `discord_voice_delegation:${turn.id}`},
      );
      session.health.delegationStatus = "queued";
      session.health.delegationUpdatedAt = Date.now();
      void this.reportHealth(session, true);
    } catch (error) {
      this.releaseTurnBinding(session, binding.voiceTurnId);
      await this.options.store.failTurn(binding.voiceTurnId, "Failed to enqueue the Discord voice delegation.").catch(() => undefined);
      throw error;
    }
    this.options.log("voice_delegation_queued", {connectorKey: session.connectorKey, guildId: session.guildId, channelId: session.channelId, voiceTurnId: binding.voiceTurnId});
  }

  private releaseTurnBinding(session: ActiveVoiceSession, voiceTurnId: string): void {
    const binding = session.turnBindingsById.get(voiceTurnId);
    if (!binding) return;
    session.turnBindingsById.delete(voiceTurnId);
    if (session.turnBindingsByUtterance.get(binding.sourceUtteranceId) === binding) session.turnBindingsByUtterance.delete(binding.sourceUtteranceId);
  }

  private stopGuildSafely(guildId: string, reason: string): void {
    void this.stopGuild(guildId, reason).catch((error: unknown) => {
      this.options.log("voice_disconnect_failed", {connectorKey: this.options.connectorKey, guildId, reason, message: safeFailureMessage(error)});
    });
  }

  private async stopGuild(guildId: string, reason: string): Promise<void> {
    const slot = this.getGuildSlot(guildId);
    slot.epoch += 1;
    slot.abort?.abort(new Error(`Discord voice room closed: ${reason}.`));
    await this.serializeGuild(guildId, () => this.stopGuildNow(guildId, reason));
  }

  private async stopGuildNow(guildId: string, reason: string): Promise<void> {
    const session = this.sessions.get(guildId);
    if (!session || session.closing) return;
    session.closing = true;
    this.sessions.delete(guildId);
    if (session.expiry) clearTimeout(session.expiry);
    if (session.healthTimer) clearInterval(session.healthTimer);
    this.disposeSessionResources(session);
    await Promise.all([...session.turnBindingsById.keys()].map((turnId) => this.options.store.failTurn(turnId, `Discord voice session ended: ${reason}.`).catch(() => undefined)));
    const normalReasons = new Set(["requested", "moved_channel", "control_timed_out", "worker_stopped", "session_expired"]);
    await this.options.store.markSessionDisconnected(session.connectorKey, session.guildId, normalReasons.has(reason) ? "disconnected" : "error", reason);
    this.options.log("voice_disconnected", {connectorKey: session.connectorKey, guildId: session.guildId, channelId: session.channelId, sessionId: session.sessionId, reason});
  }

  private getGuildSlot(guildId: string): GuildRoomSlot {
    let slot = this.guildSlots.get(guildId);
    if (!slot) {
      slot = {tail: Promise.resolve(), epoch: 0};
      this.guildSlots.set(guildId, slot);
    }
    return slot;
  }

  private serializeGuild<T>(guildId: string, operation: () => Promise<T>): Promise<T> {
    const slot = this.getGuildSlot(guildId);
    const result = slot.tail.catch(() => undefined).then(operation);
    slot.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private disposeTransport(transport: {connection: VoiceConnection; player: ReturnType<typeof createAudioPlayer>; outputEncoder: OpusEncoderHandle}): void {
    transport.player.stop(true);
    transport.outputEncoder.free();
    destroyVoiceConnection(transport.connection);
  }

  private disposeSessionResources(session: ActiveVoiceSession): void {
    session.bridge.close();
    session.providerInputPending.clear();
    for (const stream of session.inputStreams) stream.destroy();
    session.inputStreams.clear();
    session.playback.close();
    destroyVoiceConnection(session.connection);
  }
}

export class DiscordVoiceControlWorker {
  private readonly drainLoop: DrainLoop;

  constructor(private readonly input: {connectorKey: string; store: DiscordVoiceStore; manager: DiscordVoiceSessionManager; log?: (event: string, payload: Record<string, unknown>) => void}) {
    this.drainLoop = new DrainLoop({
      label: `Discord voice controls ${input.connectorKey}`,
      pollIntervalMs: 5_000,
      drain: () => this.drainOnce(),
      onError: (error) => input.log?.("voice_control_drain_failed", {connectorKey: input.connectorKey, message: safeFailureMessage(error)}),
    });
  }

  async start(): Promise<void> {
    await this.input.manager.start();
    this.drainLoop.start();
    await this.drainLoop.trigger();
  }

  async stop(): Promise<void> {
    await this.drainLoop.stop();
    await this.input.manager.stop();
  }

  triggerDrain(): Promise<void> { return this.drainLoop.trigger(); }

  private async drainOnce(): Promise<void> {
    while (!this.drainLoop.isStopped) {
      const control = await this.input.store.claimNextControl(this.input.connectorKey);
      if (!control) break;
      try {
        const result = await this.input.manager.handle(control);
        const terminal = await this.input.store.completeControl(control.id, result as never);
        if (terminal.status !== "completed") await this.input.manager.rollbackSupersededControl(control, result);
      } catch (error) {
        const raw = errorMessage(error);
        await this.input.store.failControl(control.id, raw.startsWith("{") ? raw : controlError("worker_failed", raw));
      }
    }
  }
}
