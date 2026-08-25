import {randomUUID} from "node:crypto";
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

import type {LiveVoiceRepo} from "../../../domain/live-voice/repo.js";
import {isActiveLiveVoiceTurn} from "../../../domain/live-voice/types.js";
import {DrainLoop} from "../../../lib/drain-loop.js";
import {deriveLiveVoiceHealth, type LiveVoiceDiagnosticSnapshot} from "../../voice/health.js";
import {LiveVoiceCall} from "../../voice/live-call.js";
import type {LiveVoiceProviderDefinition} from "../../voice/provider.js";
import {resamplePcm16} from "../../voice/pcm.js";
import type {DiscordChannelMetadata, DiscordWorkerRestClient} from "./api.js";
import {createOpenAILiveVoiceProvider} from "../../providers/openai-live/provider.js";
import type {DiscordVoiceControlRepo} from "./voice-postgres.js";
import type {DiscordVoiceControlRecord} from "./voice-types.js";
import {DISCORD_SOURCE} from "./config.js";
import {discordVoiceTransportDiagnostics, type DiscordVoiceInfrastructureHealth} from "./voice-transport-health.js";
import {DISCORD_VOICE_MAX_MISSED_FRAMES, DiscordVoicePlayback} from "./discord-voice-playback.js";

const MAX_UTTERANCE_MS = 60_000;
const VOICE_READY_TIMEOUT_MS = 15_000;
const VOICE_RECONNECT_GRACE_MS = 15_000;
const VOICE_SESSION_TTL_MS = 30 * 60_000;
const MAX_PENDING_INPUT_BYTES = 64 * 1024;
const DISCORD_INPUT_PACKET_MS = 20;
const CAPTURE_SILENCE_MS = 500;
const HEALTH_LOG_INTERVAL_MS = 10_000;
const HEALTH_PERSIST_INTERVAL_MS = 30_000;
const VOICE_JOIN_GUIDANCE = "Voice is live. Speak at any time with `panda discord voice send --text <message>`. For longer delegated work, send brief `--mode progress` updates and finish with `--mode final`.";

type VoiceInputStream = ReturnType<VoiceConnection["receiver"]["subscribe"]>;

interface ActiveVoiceSession {
  connectorKey: string;
  guildId: string;
  channelId: string;
  sessionId: string;
  agentKey: string;
  liveVoiceSessionId: string;
  connection: VoiceConnection;
  call: LiveVoiceCall;
  playback: DiscordVoicePlayback;
  player: ReturnType<typeof createAudioPlayer>;
  inputStreams: Set<VoiceInputStream>;
  lifecycleEpoch: number;
  expiry?: NodeJS.Timeout;
  healthTimer?: NodeJS.Timeout;
  health: {
    discordVoiceStateAt: number;
    playerState: string;
    captureQueuedMs: number;
    lastPersistedAt: number;
    lastPersistedKey?: string;
  };
  model: string;
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
  controls: DiscordVoiceControlRepo;
  voice: LiveVoiceRepo;
  log(event: string, payload: Record<string, unknown>): void;
  getInfrastructureHealth?: () => DiscordVoiceInfrastructureHealth;
  provider?: LiveVoiceProviderDefinition;
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

function controlError(failureCode: string, message: string): string {
  return JSON.stringify({failureCode, message: message.slice(0, 500)});
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
    const player = createAudioPlayer({behaviors: {maxMissedFrames: DISCORD_VOICE_MAX_MISSED_FRAMES}});
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
    await this.options.voice.markConnectorSessionsDisconnected(DISCORD_SOURCE, this.options.connectorKey, "worker_restarted");
    await this.options.controls.failRunningControls(this.options.connectorKey, controlError("worker_unavailable", "Discord voice worker restarted."));
    await this.options.voice.failConnectorActiveTurns(DISCORD_SOURCE, this.options.connectorKey, "Discord voice worker restarted; any in-flight speech outcome is unknown.");
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const slot of this.guildSlots.values()) {
      slot.epoch += 1;
      slot.abort?.abort(new Error("Discord voice worker stopped."));
    }
    await Promise.all([...this.sessions.keys()].map((guildId) => this.stopGuild(guildId, "worker_stopped")));
    await Promise.all([...this.guildSlots.values()].map((slot) => slot.tail.catch(() => undefined)));
    await this.options.voice.markConnectorSessionsDisconnected(DISCORD_SOURCE, this.options.connectorKey, "worker_stopped");
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
    if (session?.liveVoiceSessionId === result.voiceSessionId) await this.stopGuild(session.guildId, "control_timed_out");
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

    const liveVoiceSessionId = randomUUID();
    const provider = this.options.provider ?? createOpenAILiveVoiceProvider({
      env: this.options.env,
      voice: this.options.env?.PANDA_DISCORD_VOICE_VOICE,
      log: this.options.log,
    });
    const sessionRecord = {
      id: liveVoiceSessionId,
      source: DISCORD_SOURCE,
      connectorKey: control.connectorKey,
      scopeKey: channel.guildId,
      roomKey: channel.channelId,
      sessionId: control.sessionId,
      agentKey: control.agentKey,
      provider: provider.id,
      model: provider.model,
      state: "connecting" as const,
      transportContext: {guildId: channel.guildId, channelId: channel.channelId},
    };
    await this.options.voice.upsertSession(sessionRecord);
    let connection: VoiceConnection | undefined;
    let session: ActiveVoiceSession | undefined;
    try {
      const transportPromise = (this.options.openVoiceTransport ?? openVoiceTransport)({channelId: channel.channelId, guildId: channel.guildId, adapterCreator: this.options.gatewayAdapter(channel.guildId), group: this.options.connectorKey});
      const transport = await awaitAbortable(transportPromise, abort.signal, (late) => this.disposeTransport(late));
      connection = transport.connection;
      const {player, outputEncoder} = transport;
      let call: LiveVoiceCall | undefined;
      const playback = new DiscordVoicePlayback({
        player,
        encoder: outputEncoder,
        onError: (error) => call?.noteOutputFailure(error),
      });
      call = new LiveVoiceCall({
        liveVoiceSessionId,
        sessionId: control.sessionId,
        agentKey: control.agentKey,
        voice: this.options.voice,
        createProvider: provider.createSession,
        output: playback,
        log: (event, payload) => this.options.log(event, {connectorKey: control.connectorKey, guildId: channel.guildId, channelId: channel.channelId, ...payload}),
        onTerminalFailure: (reason) => this.stopGuildSafely(channel.guildId, reason),
      });
      session = {
        connectorKey: control.connectorKey,
        guildId: channel.guildId,
        channelId: channel.channelId,
        sessionId: control.sessionId,
        agentKey: control.agentKey,
        liveVoiceSessionId,
        connection,
        call,
        playback,
        player,
        inputStreams: new Set(),
        lifecycleEpoch: epoch,
        health: {discordVoiceStateAt: Date.now(), playerState: player.state.status, captureQueuedMs: 0, lastPersistedAt: 0},
        model: provider.model,
        closing: false,
      };
      connection.subscribe(player);
      await call.start(abort.signal);
      if (abort.signal.aborted || slot.epoch !== epoch || this.stopped) throw abortError(abort.signal);
      // The connected row is the enqueue fence. Do not expose participant
      // audio until atomic turn/request creation can lock that durable state.
      await this.options.voice.upsertSession({...sessionRecord, state: "connected"});
      this.sessions.set(channel.guildId, session);
      this.startHealthReporter(session);
      this.attachPlayerLifecycle(session);
      this.attachReceiver(session);
      this.attachConnectionLifecycle(session);
      const activeSession = session;
      session.expiry = setTimeout(() => this.stopGuildSafely(activeSession.guildId, "session_expired"), this.options.sessionTtlMs ?? VOICE_SESSION_TTL_MS);
      session.expiry.unref?.();
      await this.reportHealth(session, true);
      this.options.log("voice_connected", {connectorKey: control.connectorKey, guildId: channel.guildId, channelId: channel.channelId, sessionId: control.sessionId, model: session.model});
      return this.result(session, "connected");
    } catch (error) {
      const failureCode = classifyFailure(error);
      if (session && this.sessions.get(channel.guildId) === session) await this.stopGuildNow(channel.guildId, failureCode);
      else {
        if (session) await this.disposeSessionResources(session, failureCode);
        else if (connection) destroyVoiceConnection(connection);
        await this.options.voice.markSessionDisconnected(liveVoiceSessionId, "error", failureCode);
      }
      throw new Error(controlError(failureCode, errorMessage(error)));
    }
  }

  private async leave(control: DiscordVoiceControlRecord): Promise<Record<string, unknown>> {
    const session = [...this.sessions.values()].find((candidate) => candidate.sessionId === control.sessionId && candidate.agentKey === control.agentKey && (!control.channelId || candidate.channelId === control.channelId));
    if (!session) throw new Error(controlError("invalid_channel", "No owned active Discord voice session matched."));
    if (control.voiceTurnId) {
      const turn = await this.options.voice.getTurn(control.voiceTurnId);
      if (!isActiveLiveVoiceTurn(turn) || turn.sessionId !== session.sessionId || turn.agentKey !== session.agentKey || turn.liveVoiceSessionId !== session.liveVoiceSessionId) {
        throw new Error(controlError("voice_turn_conflict", "The Discord voice turn is not active or does not belong to this voice session."));
      }
      await this.options.voice.completeTurn(turn.id, "Left the Discord voice channel.");
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
    let delivered: Awaited<ReturnType<LiveVoiceCall["deliver"]>>;
    try {
      delivered = await session.call.deliver({controlId: control.id, text: control.text, mode: control.mode, ...(control.voiceTurnId ? {liveVoiceTurnId: control.voiceTurnId} : {})});
    } catch (error) {
      const code = errorMessage(error) === "voice_turn_conflict" ? "voice_turn_conflict" : "provider_unavailable";
      throw new Error(controlError(code, code === "voice_turn_conflict" ? "The Discord voice turn is not active or is already complete." : "GPT-Live is not ready to accept voice context."));
    }
    void this.reportHealth(session, true);
    this.options.log("voice_context_sent", {connectorKey: session.connectorKey, guildId: session.guildId, channelId: session.channelId, mode: control.mode, delivery: delivered.delivery, ...(delivered.turn ? {voiceTurnId: delivered.turn.id} : {})});
    return {ok: true, state: "sent", connectorKey: session.connectorKey, guildId: session.guildId, channelId: session.channelId, sessionId: session.sessionId, voiceSessionId: session.liveVoiceSessionId, model: session.model, mode: control.mode, delivery: delivered.delivery, ...(delivered.turn ? {voiceTurnId: delivered.turn.id} : {})};
  }

  private result(session: ActiveVoiceSession, state: "connected" | "disconnected"): Record<string, unknown> {
    return {ok: true, state, connectorKey: session.connectorKey, guildId: session.guildId, channelId: session.channelId, sessionId: session.sessionId, voiceSessionId: session.liveVoiceSessionId, model: session.model, ...(state === "connected" ? {guidance: VOICE_JOIN_GUIDANCE} : {})};
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
    const now = Date.now();
    const infrastructure = this.options.getInfrastructureHealth?.() ?? {};
    const call = session.call.getSnapshot();
    const provider = call.provider ?? {
      state: call.connected ? "connected" as const : "connecting" as const,
      sidebandState: "connecting" as const,
      sidebandOpenedAt: null,
      sidebandAgeMs: null,
      lastPingAt: null,
      lastPongAt: null,
      pongAgeMs: null,
      lastCloseCode: null,
      lastCloseOpenForMs: null,
      malformedEvents: 0,
      unknownEvents: 0,
    };
    const connectionState = (session.connection as VoiceConnection & {state?: {status?: string}}).state?.status ?? "unknown";
    const providerState = call.recovering || (provider.state === "connected" && provider.sidebandState === "connecting")
      ? "recovering"
      : provider.state;
    const gatewayReady = !infrastructure.gateway || (infrastructure.gateway.state === "ready" && (infrastructure.gateway.heartbeatAckAgeMs ?? 0) <= 90_000);
    const health = deriveLiveVoiceHealth({
      connecting: !call.connected && !call.recovering,
      closing: call.closing,
      transportReady: connectionState === VoiceConnectionStatus.Ready && gatewayReady,
      providerState,
      listenerStatus: infrastructure.listener?.status,
      poolWaiting: infrastructure.pool?.waitingCount,
      audioDropped: call.outputDroppedMs > 0 || call.captureDroppedPackets > 0,
      playbackFailed: call.playbackFailed,
    });
    const media = provider.media;
    const snapshot: LiveVoiceDiagnosticSnapshot = {
      version: 1,
      observedAt: now,
      state: health.state,
      reasons: health.reasons,
      identity: {source: DISCORD_SOURCE, connectorKey: session.connectorKey, scopeKey: session.guildId, roomKey: session.channelId, liveVoiceSessionId: session.liveVoiceSessionId},
      provider: {
        ...provider,
        generation: call.providerGeneration,
        operationalState: providerState,
        rtpAgeMs: media?.lastRtpAt ? Math.max(0, now - media.lastRtpAt) : null,
        reconnectCount: call.providerReconnectCount,
      },
      playback: {
        state: call.output.state,
        phase: call.live.phase,
        responseEpoch: call.output.responseEpoch,
        queuedMs: call.output.queuedMs,
        droppedMs: call.outputDroppedMs,
        providerClears: call.providerOutputClears,
        underruns: call.playbackUnderruns,
        lastAudioAt: call.lastOutputAt ?? null,
      },
      capture: {
        state: call.captureId ? "capturing" : "idle",
        actorId: call.captureActorId ?? null,
        captureId: call.captureId ?? null,
        queuedMs: session.health.captureQueuedMs,
        droppedMs: call.captureDroppedMs + (media?.droppedInputMs ?? 0),
        droppedPackets: call.captureDroppedPackets,
        lastAudioAt: call.lastInputAt ?? null,
      },
      delegation: {
        providerDelegationId: call.providerDelegationId ?? null,
        liveVoiceTurnId: call.liveVoiceTurnId ?? null,
        deliveryControlId: call.deliveryControlId ?? null,
        status: call.delegationStatus ?? null,
        updatedAt: call.delegationUpdatedAt ?? null,
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
      transport: discordVoiceTransportDiagnostics({
        gateway: infrastructure.gateway,
        connectionState,
        playerState: session.health.playerState,
        playback: call.output.transport,
        stateAt: session.health.discordVoiceStateAt,
      }),
    };
    this.options.log("discord_voice_health", {transition, snapshot});
    const persistedKey = `${health.state}:${health.reasons.join(",")}`;
    if (persistedKey === session.health.lastPersistedKey && now - session.health.lastPersistedAt < HEALTH_PERSIST_INTERVAL_MS) return;
    session.health.lastPersistedKey = persistedKey;
    session.health.lastPersistedAt = now;
    await this.options.voice.updateSessionHealth({
      id: session.liveVoiceSessionId,
      health: health.state,
      reasons: health.reasons,
      observedAt: now,
      diagnostics: snapshot,
    });
  }

  private attachReceiver(session: ActiveVoiceSession): void {
    session.connection.receiver.speaking.on("start", (userId) => {
      if (userId === this.options.connectorKey) return;
      const decision = session.call.beginCapture(userId);
      if (decision.status !== "accepted") {
        if (decision.status !== "continued") this.options.log("voice_utterance_dropped", {connectorKey: session.connectorKey, guildId: session.guildId, channelId: session.channelId, speakerId: userId, reason: decision.status});
        return;
      }
      const captureId = decision.captureId;
      void this.reportHealth(session, true);
      let stream: VoiceInputStream;
      try {
        stream = session.connection.receiver.subscribe(userId, {end: {behavior: EndBehaviorType.AfterSilence, duration: CAPTURE_SILENCE_MS}});
      } catch (error) {
        session.call.endCapture(captureId);
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
          if (session.closing || !decoder) return;
          const pcm = discordPcmToLive(decoder.decode(packet, {maxFrameSize: 5_760}));
          if (pcm.length === 0) return;
          session.call.pushAudio(captureId, pcm);
        }
        catch (error) { this.options.log("voice_decode_failed", {connectorKey: session.connectorKey, guildId: session.guildId, speakerId: userId, message: errorMessage(error)}); }
      };
      const onData = (packet: Buffer) => {
        if (released || session.closing) return;
        const copy = Buffer.from(packet);
        if (decoder) { decode(copy); return; }
        while (pendingPackets.length > 0 && pendingBytes + copy.length > MAX_PENDING_INPUT_BYTES) {
          pendingBytes -= pendingPackets.shift()!.length;
          session.call.noteCaptureDrop(1, DISCORD_INPUT_PACKET_MS);
        }
        if (copy.length <= MAX_PENDING_INPUT_BYTES) { pendingPackets.push(copy); pendingBytes += copy.length; }
        else session.call.noteCaptureDrop(1, DISCORD_INPUT_PACKET_MS);
        session.health.captureQueuedMs = pendingPackets.length * DISCORD_INPUT_PACKET_MS;
      };
      const release = () => {
        if (released) return;
        released = true;
        clearTimeout(timer);
        stream.off("data", onData);
        session.inputStreams.delete(stream);
        session.call.endCapture(captureId);
        session.health.captureQueuedMs = 0;
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
        session.health.captureQueuedMs = 0;
        for (const packet of packets) decode(packet);
      }).catch((error: unknown) => stream.destroy(error instanceof Error ? error : new Error(String(error))));
    });
  }

  private attachPlayerLifecycle(session: ActiveVoiceSession): void {
    session.player.on("error", (error) => {
      session.call.noteOutputFailure(error);
      void this.reportHealth(session, true);
    });
    session.player.on("stateChange", (_oldState, newState) => {
      session.health.playerState = newState.status;
      if (newState.status === AudioPlayerStatus.Idle) {
        const underrun = session.playback.handlePlayerIdle();
        session.call.noteOutputIdle(underrun);
      }
      void this.reportHealth(session, true);
    });
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
    const normalReasons = new Set(["requested", "moved_channel", "control_timed_out", "worker_stopped", "session_expired"]);
    let persistenceError: unknown;
    try {
      // This update is the database fence used by atomic delegation enqueue.
      // Once it commits, no new turn/request pair can enter this closed call.
      await this.options.voice.markSessionDisconnected(
        session.liveVoiceSessionId,
        normalReasons.has(reason) ? "disconnected" : "error",
        reason,
      );
    } catch (error) {
      persistenceError = error;
    }
    await this.disposeSessionResources(session, reason);
    if (persistenceError) throw persistenceError;
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

  private async disposeSessionResources(session: ActiveVoiceSession, reason: string): Promise<void> {
    for (const stream of session.inputStreams) stream.destroy();
    session.inputStreams.clear();
    await session.call.close(reason);
    session.playback.close();
    destroyVoiceConnection(session.connection);
  }
}

export class DiscordVoiceControlWorker {
  private readonly drainLoop: DrainLoop;

  constructor(private readonly input: {connectorKey: string; controls: DiscordVoiceControlRepo; manager: DiscordVoiceSessionManager; log?: (event: string, payload: Record<string, unknown>) => void}) {
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
      const control = await this.input.controls.claimNextControl(this.input.connectorKey);
      if (!control) break;
      try {
        const result = await this.input.manager.handle(control);
        const terminal = await this.input.controls.completeControl(control.id, result as never);
        if (terminal.status !== "completed") await this.input.manager.rollbackSupersededControl(control, result);
      } catch (error) {
        const raw = errorMessage(error);
        await this.input.controls.failControl(control.id, raw.startsWith("{") ? raw : controlError("worker_failed", raw));
      }
    }
  }
}
