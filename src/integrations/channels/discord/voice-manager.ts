import {PassThrough} from "node:stream";
import {randomUUID} from "node:crypto";

import {
  AudioPlayerStatus,
  EndBehaviorType,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  type DiscordGatewayAdapterCreator,
  type VoiceConnection,
} from "@discordjs/voice";
import {createDecoder, createEncoder, Application, type OpusDecoderHandle, type OpusEncoderHandle} from "libopus-wasm";

import type {RuntimeRequestRepo} from "../../../domain/threads/requests/repo.js";
import type {DiscordChannelMetadata, DiscordWorkerRestClient} from "./api.js";
import {OpenAILiveRealtimeVoiceBridge, type RealtimeVoiceBridge} from "../../providers/openai-live/bridge.js";
import {resamplePcm16} from "../../providers/openai-live/peer.js";
import type {DiscordVoiceStore} from "./voice-postgres.js";
import {DISCORD_VOICE_MODEL, type DiscordVoiceControlRecord, type DiscordVoiceTurnRecord} from "./voice-types.js";

const MAX_UTTERANCE_MS = 60_000;
const MAX_UTTERANCES_PER_MINUTE = 30;
const VOICE_READY_TIMEOUT_MS = 15_000;
const VOICE_RECONNECT_GRACE_MS = 15_000;
const VOICE_SESSION_TTL_MS = 30 * 60_000;
const PROVIDER_RECONNECT_DELAYS_MS = [0, 500, 1_500] as const;
const MAX_PENDING_INPUT_BYTES = 64 * 1024;
const MAX_PENDING_OUTPUT_BYTES = 24_000 * 2 * 5;
const VOICE_JOIN_GUIDANCE = "Voice is live. Speak at any time with `panda discord voice send --text <message>`. For longer delegated work, send brief `--mode progress` updates and finish with `--mode final`.";

type VoiceInputStream = ReturnType<VoiceConnection["receiver"]["subscribe"]>;

interface ActiveVoiceTurnBinding {
  voiceTurnId: string;
  promptKey: string;
  delegationId: string;
  bridgeGeneration: number;
  creating: boolean;
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
  output: PassThrough;
  outputEncoder: OpusEncoderHandle;
  outputPending: DiscordVoicePcmQueue;
  outputBackpressured: boolean;
  outputDroppedBytes: number;
  lastOutputDropLogAt: number;
  player: ReturnType<typeof createAudioPlayer>;
  speakers: DiscordVoiceSpeakerArbiter;
  inputStreams: Set<VoiceInputStream>;
  turnBindingsByPrompt: Map<string, ActiveVoiceTurnBinding>;
  turnBindingsById: Map<string, ActiveVoiceTurnBinding>;
  bridgeGeneration: number;
  failedBridgeGeneration?: number;
  providerRecovery?: Promise<void>;
  expiry?: NodeJS.Timeout;
  closing: boolean;
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
  createBridge?: (options: ConstructorParameters<typeof OpenAILiveRealtimeVoiceBridge>[0]) => RealtimeVoiceBridge;
  createInputDecoder?: typeof createDecoder;
  sessionTtlMs?: number;
  openVoiceTransport?: (input: {channelId: string; guildId: string; adapterCreator: DiscordGatewayAdapterCreator; group: string}) => Promise<{
    connection: VoiceConnection;
    output: PassThrough;
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

export class DiscordVoiceSpeakerArbiter {
  activeSpeakerId?: string;
  lastSpeakerId?: string;
  private acceptedAt: number[] = [];

  start(userId: string, connectorUserId: string, now = Date.now()): "accepted" | "continued" | "self" | "overlap" | "rate_limit" {
    if (userId === connectorUserId) return "self";
    if (this.activeSpeakerId === userId) return "continued";
    if (this.activeSpeakerId) return "overlap";
    this.acceptedAt = this.acceptedAt.filter((value) => value > now - 60_000);
    if (this.acceptedAt.length >= MAX_UTTERANCES_PER_MINUTE) return "rate_limit";
    this.acceptedAt.push(now);
    this.activeSpeakerId = userId;
    this.lastSpeakerId = userId;
    return "accepted";
  }

  finish(userId: string): void {
    if (this.activeSpeakerId === userId) this.activeSpeakerId = undefined;
  }
}

function activeVoiceTurn(turn: DiscordVoiceTurnRecord): boolean {
  return turn.status === "pending" || turn.status === "queued" || turn.status === "running";
}

function voicePromptKey(prompt: string): string {
  return prompt.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
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

function bufferToSamples(buffer: Buffer): Int16Array {
  const output = new Int16Array(Math.floor(buffer.length / 2));
  for (let index = 0; index < output.length; index += 1) output[index] = buffer.readInt16LE(index * 2);
  return output;
}

function discordPcmToLive(decoded: Int16Array): Buffer {
  const mono = new Int16Array(Math.floor(decoded.length / 2));
  for (let i = 0; i < mono.length; i += 1) mono[i] = Math.round(((decoded[i * 2] ?? 0) + (decoded[i * 2 + 1] ?? 0)) / 2);
  return samplesToBuffer(resamplePcm16(mono, 48_000, 24_000));
}

function livePcmToDiscord(pcm: Buffer): Int16Array {
  const mono = resamplePcm16(bufferToSamples(pcm), 24_000, 48_000);
  const stereo = new Int16Array(mono.length * 2);
  for (let i = 0; i < mono.length; i += 1) stereo[i * 2] = stereo[i * 2 + 1] = mono[i] ?? 0;
  return stereo;
}

function destroyVoiceConnection(connection: VoiceConnection): void {
  const status = (connection as VoiceConnection & {state?: {status?: string}}).state?.status;
  if (status !== VoiceConnectionStatus.Destroyed) connection.destroy();
}

async function openVoiceTransport(input: {channelId: string; guildId: string; adapterCreator: DiscordGatewayAdapterCreator; group: string}) {
  const connection = joinVoiceChannel({...input, selfDeaf: false, selfMute: false});
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, VOICE_READY_TIMEOUT_MS);
    const output = new PassThrough();
    const player = createAudioPlayer();
    const outputEncoder = await createEncoder({application: Application.Voip, channels: 2, sampleRate: 48_000, frameSize: 960});
    return {connection, output, player, outputEncoder};
  } catch (error) {
    destroyVoiceConnection(connection);
    throw error;
  }
}

export class DiscordVoiceSessionManager {
  private readonly sessions = new Map<string, ActiveVoiceSession>();
  private stopped = false;

  constructor(private readonly options: DiscordVoiceManagerOptions) {}

  async start(): Promise<void> {
    this.stopped = false;
    await this.options.store.markConnectorSessionsDisconnected(this.options.connectorKey, "worker_restarted");
    await this.options.store.failRunningControls(this.options.connectorKey, controlError("worker_unavailable", "Discord voice worker restarted."));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all([...this.sessions.keys()].map((guildId) => this.stopGuild(guildId, "worker_stopped")));
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
    const current = this.sessions.get(channel.guildId);
    if (current) {
      if (current.sessionId !== control.sessionId) throw new Error(controlError("session_conflict", "Another Panda session owns voice in this guild."));
      if (current.channelId === channel.channelId) return this.result(current, "connected");
      await this.stopGuild(channel.guildId, "moved_channel");
    }

    const voiceSessionId = randomUUID();
    await this.options.store.upsertSession({connectorKey: control.connectorKey, guildId: channel.guildId, channelId: channel.channelId, sessionId: control.sessionId, agentKey: control.agentKey, voiceSessionId, state: "connecting", model: DISCORD_VOICE_MODEL});
    let connection: VoiceConnection | undefined;
    let session: ActiveVoiceSession | undefined;
    try {
      const transport = await (this.options.openVoiceTransport ?? openVoiceTransport)({channelId: channel.channelId, guildId: channel.guildId, adapterCreator: this.options.gatewayAdapter(channel.guildId), group: this.options.connectorKey});
      connection = transport.connection;
      const {output, player, outputEncoder} = transport;
      const bridgeFactory = this.options.createBridge ?? ((options) => new OpenAILiveRealtimeVoiceBridge(options));
      session = {
        connectorKey: control.connectorKey, guildId: channel.guildId, channelId: channel.channelId, sessionId: control.sessionId,
        agentKey: control.agentKey, voiceSessionId, connection, output, outputEncoder, outputPending: new DiscordVoicePcmQueue(MAX_PENDING_OUTPUT_BYTES), player,
        outputBackpressured: false, outputDroppedBytes: 0, lastOutputDropLogAt: 0,
        speakers: new DiscordVoiceSpeakerArbiter(), inputStreams: new Set(), turnBindingsByPrompt: new Map(), turnBindingsById: new Map(),
        bridgeGeneration: 0, closing: false,
        bridge: undefined as unknown as RealtimeVoiceBridge,
      };
      session.bridge = this.createBridge(session, bridgeFactory);
      connection.subscribe(player);
      this.sessions.set(channel.guildId, session);
      this.attachPlayerLifecycle(session);
      this.attachReceiver(session);
      this.attachConnectionLifecycle(session);
      const activeSession = session;
      session.expiry = setTimeout(() => this.stopGuildSafely(activeSession.guildId, "session_expired"), this.options.sessionTtlMs ?? VOICE_SESSION_TTL_MS);
      session.expiry.unref?.();
      await session.bridge.connect();
      await this.options.store.upsertSession({connectorKey: control.connectorKey, guildId: channel.guildId, channelId: channel.channelId, sessionId: control.sessionId, agentKey: control.agentKey, voiceSessionId, state: "connected", model: DISCORD_VOICE_MODEL});
      this.options.log("voice_connected", {connectorKey: control.connectorKey, guildId: channel.guildId, channelId: channel.channelId, sessionId: control.sessionId, model: DISCORD_VOICE_MODEL});
      return this.result(session, "connected");
    } catch (error) {
      const failureCode = classifyFailure(error);
      if (session) await this.stopGuild(channel.guildId, failureCode);
      else {
        if (connection) destroyVoiceConnection(connection);
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

    const channel = control.mode === "progress" ? "commentary" : "speakable";
    let delivery: "delegation" | "session" = "session";
    let turn: Awaited<ReturnType<DiscordVoiceStore["getTurn"]>> | undefined;
    let sent = false;
    if (control.voiceTurnId) {
      turn = await this.options.store.getTurn(control.voiceTurnId);
      if (!activeVoiceTurn(turn) || turn.sessionId !== session.sessionId || turn.agentKey !== session.agentKey || turn.voiceSessionId !== session.voiceSessionId) {
        throw new Error(controlError("voice_turn_conflict", "The Discord voice turn is not active or does not belong to this voice session."));
      }
      const binding = session.turnBindingsById.get(turn.id);
      if (binding?.bridgeGeneration === session.bridgeGeneration) sent = session.bridge.appendDelegationContext(binding.delegationId, control.text, channel);
      if (sent) delivery = "delegation";
    }
    if (!sent) sent = session.bridge.appendSessionContext(control.text, channel);
    if (!sent) throw new Error(controlError("provider_unavailable", "GPT-Live is not ready to accept voice context."));
    if (turn && control.mode === "final") {
      await this.options.store.completeTurn(turn.id, control.text);
      this.releaseTurnBinding(session, turn.id);
    }
    this.options.log("voice_context_sent", {connectorKey: session.connectorKey, guildId: session.guildId, channelId: session.channelId, mode: control.mode, delivery, ...(turn ? {voiceTurnId: turn.id} : {})});
    return {ok: true, state: "sent", connectorKey: session.connectorKey, guildId: session.guildId, channelId: session.channelId, sessionId: session.sessionId, voiceSessionId: session.voiceSessionId, model: DISCORD_VOICE_MODEL, mode: control.mode, delivery, ...(turn ? {voiceTurnId: turn.id} : {})};
  }

  private result(session: ActiveVoiceSession, state: "connected" | "disconnected"): Record<string, unknown> {
    return {ok: true, state, connectorKey: session.connectorKey, guildId: session.guildId, channelId: session.channelId, sessionId: session.sessionId, voiceSessionId: session.voiceSessionId, model: DISCORD_VOICE_MODEL, ...(state === "connected" ? {guidance: VOICE_JOIN_GUIDANCE} : {})};
  }

  private attachReceiver(session: ActiveVoiceSession): void {
    session.connection.receiver.speaking.on("start", (userId) => {
      const decision = session.speakers.start(userId, this.options.connectorKey);
      if (decision !== "accepted") {
        if (decision !== "self" && decision !== "continued") this.options.log("voice_utterance_dropped", {connectorKey: session.connectorKey, guildId: session.guildId, channelId: session.channelId, speakerId: userId, reason: decision});
        return;
      }
      session.bridge.interrupt();
      let stream: VoiceInputStream;
      try {
        stream = session.connection.receiver.subscribe(userId, {end: {behavior: EndBehaviorType.AfterSilence, duration: 300}});
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
        try { if (!session.closing && decoder) session.bridge.sendAudio(discordPcmToLive(decoder.decode(packet, {maxFrameSize: 5_760}))); }
        catch (error) { this.options.log("voice_decode_failed", {connectorKey: session.connectorKey, guildId: session.guildId, speakerId: userId, message: errorMessage(error)}); }
      };
      const onData = (packet: Buffer) => {
        if (released || session.closing) return;
        const copy = Buffer.from(packet);
        if (decoder) { decode(copy); return; }
        while (pendingPackets.length > 0 && pendingBytes + copy.length > MAX_PENDING_INPUT_BYTES) pendingBytes -= pendingPackets.shift()!.length;
        if (copy.length <= MAX_PENDING_INPUT_BYTES) { pendingPackets.push(copy); pendingBytes += copy.length; }
      };
      const release = () => {
        if (released) return;
        released = true;
        clearTimeout(timer);
        stream.off("data", onData);
        session.inputStreams.delete(stream);
        session.speakers.finish(userId);
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
  }

  private handlePlaybackFailure(session: ActiveVoiceSession, error: unknown): void {
    if (session.closing) return;
    this.options.log("voice_playback_failed", {connectorKey: session.connectorKey, guildId: session.guildId, channelId: session.channelId, message: safeFailureMessage(error)});
    this.stopGuildSafely(session.guildId, "discord_audio_failed");
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
      if (newState.status === VoiceConnectionStatus.Destroyed) {
        this.stopGuildSafely(session.guildId, "discord_connection_destroyed");
        return;
      }
      if (newState.status === VoiceConnectionStatus.Disconnected) {
        void entersState(session.connection, VoiceConnectionStatus.Ready, VOICE_RECONNECT_GRACE_MS).catch(() => this.stopGuildSafely(session.guildId, "discord_reconnect_failed"));
      }
    });
  }

  private writeOutput(session: ActiveVoiceSession, audio: Buffer): void {
    if (session.closing) return;
    const droppedBytes = session.outputPending.push(audio);
    if (droppedBytes > 0) this.recordOutputDrop(session, droppedBytes);
    if (session.outputBackpressured) {
      if (!this.outputEnded(session.output)) return;
      session.outputBackpressured = false;
    }
    while (session.outputPending.byteLength >= 960) {
      const frame = session.outputPending.shift(960)!;
      const output = this.ensurePlayableOutput(session);
      if (!output.write(Buffer.from(session.outputEncoder.encode(livePcmToDiscord(frame), {frameSize: 960})))) {
        session.outputBackpressured = true;
        output.once("drain", () => {
          if (!session.closing && session.output === output) {
            session.outputBackpressured = false;
            this.writeOutput(session, Buffer.alloc(0));
          }
        });
        break;
      }
    }
  }

  private recordOutputDrop(session: ActiveVoiceSession, bytes: number): void {
    session.outputDroppedBytes += bytes;
    const now = Date.now();
    if (now - session.lastOutputDropLogAt < 1_000) return;
    this.options.log("voice_output_audio_dropped", {connectorKey: session.connectorKey, guildId: session.guildId, channelId: session.channelId, bytes: session.outputDroppedBytes, reason: "backpressure_limit"});
    session.outputDroppedBytes = 0;
    session.lastOutputDropLogAt = now;
  }

  private ensurePlayableOutput(session: ActiveVoiceSession): PassThrough {
    const replaceOutput = this.outputEnded(session.output);
    if (replaceOutput) session.output = new PassThrough();
    if (replaceOutput || session.player.state.status === AudioPlayerStatus.Idle) {
      session.player.play(createAudioResource(session.output, {inputType: StreamType.Opus}));
    }
    return session.output;
  }

  private outputEnded(output: PassThrough): boolean {
    return output.destroyed || output.readableEnded || output.writableEnded;
  }

  private clearPlayback(session: ActiveVoiceSession): void {
    if (session.closing) return;
    session.player.stop(true);
    session.output.destroy();
    session.output = new PassThrough();
    session.outputPending.clear();
    session.outputBackpressured = false;
  }

  private createBridge(session: ActiveVoiceSession, bridgeFactory = this.options.createBridge ?? ((options) => new OpenAILiveRealtimeVoiceBridge(options))): RealtimeVoiceBridge {
    const generation = ++session.bridgeGeneration;
    return bridgeFactory({
      env: this.options.env, voice: this.options.env?.PANDA_DISCORD_VOICE_VOICE ?? "cove",
      onAudio: (audio) => {
        if (!this.isCurrentBridge(session, generation)) return;
        try { this.writeOutput(session, audio); } catch (error) { this.handlePlaybackFailure(session, error); }
      },
      onDelegation: (delegation) => this.isCurrentBridge(session, generation) ? this.delegate(session, generation, delegation.id, delegation.prompt) : undefined,
      onClearAudio: () => {
        if (!this.isCurrentBridge(session, generation)) return;
        try { this.clearPlayback(session); } catch (error) { this.handlePlaybackFailure(session, error); }
      },
      onClose: (reason) => {
        if (!this.isCurrentBridge(session, generation)) return;
        if (reason === "provider_failed") {
          session.failedBridgeGeneration = generation;
          this.recoverProvider(session);
        }
        else this.stopGuildSafely(session.guildId, reason);
      },
      log: this.options.log,
    });
  }

  private isCurrentBridge(session: ActiveVoiceSession, generation: number): boolean {
    return !session.closing && session.bridgeGeneration === generation && this.sessions.get(session.guildId) === session;
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
    for (const [index, delayMs] of PROVIDER_RECONNECT_DELAYS_MS.entries()) {
      if (delayMs > 0) await new Promise<void>((resolve) => { const timer = setTimeout(resolve, delayMs); timer.unref?.(); });
      if (session.closing || this.sessions.get(session.guildId) !== session) return;
      const bridge = this.createBridge(session);
      session.bridge = bridge;
      try {
        await bridge.connect();
        if (session.closing || this.sessions.get(session.guildId) !== session) { bridge.close(); return; }
        if (session.failedBridgeGeneration === session.bridgeGeneration) continue;
        session.failedBridgeGeneration = undefined;
        this.options.log("voice_provider_reconnected", {connectorKey: session.connectorKey, guildId: session.guildId, channelId: session.channelId, attempt: index + 1});
        return;
      } catch (error) {
        const failureCode = classifyFailure(error);
        this.options.log("voice_provider_reconnect_failed", {connectorKey: session.connectorKey, guildId: session.guildId, channelId: session.channelId, attempt: index + 1, failureCode, message: safeFailureMessage(error)});
        if (failureCode === "auth_unavailable") { await this.stopGuild(session.guildId, failureCode); return; }
      }
    }
    await this.stopGuild(session.guildId, "provider_failed");
  }

  private async delegate(session: ActiveVoiceSession, bridgeGeneration: number, delegationId: string, prompt: string): Promise<void> {
    const promptKey = voicePromptKey(prompt);
    const existing = session.turnBindingsByPrompt.get(promptKey);
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
    const binding: ActiveVoiceTurnBinding = {voiceTurnId: id, promptKey, delegationId, bridgeGeneration, creating: true};
    session.turnBindingsByPrompt.set(promptKey, binding);
    session.turnBindingsById.set(id, binding);
    let turnCreated = false;
    try {
      await this.options.store.createTurn({id, voiceSessionId: session.voiceSessionId, delegationId, connectorKey: session.connectorKey, guildId: session.guildId, channelId: session.channelId, sessionId: session.sessionId, agentKey: session.agentKey, externalActorId: session.speakers.lastSpeakerId, prompt});
      turnCreated = true;
      binding.creating = false;
      await this.options.requests.enqueueRequest({kind: "discord_voice_delegation", payload: {voiceTurnId: id}});
    } catch (error) {
      this.releaseTurnBinding(session, id);
      if (turnCreated) await this.options.store.failTurn(id, "Failed to enqueue the Discord voice delegation.").catch(() => undefined);
      throw error;
    }
    this.options.log("voice_delegation_queued", {connectorKey: session.connectorKey, guildId: session.guildId, channelId: session.channelId, voiceTurnId: id});
  }

  private releaseTurnBinding(session: ActiveVoiceSession, voiceTurnId: string): void {
    const binding = session.turnBindingsById.get(voiceTurnId);
    if (!binding) return;
    session.turnBindingsById.delete(voiceTurnId);
    if (session.turnBindingsByPrompt.get(binding.promptKey) === binding) session.turnBindingsByPrompt.delete(binding.promptKey);
  }

  private stopGuildSafely(guildId: string, reason: string): void {
    void this.stopGuild(guildId, reason).catch((error: unknown) => {
      this.options.log("voice_disconnect_failed", {connectorKey: this.options.connectorKey, guildId, reason, message: safeFailureMessage(error)});
    });
  }

  private async stopGuild(guildId: string, reason: string): Promise<void> {
    const session = this.sessions.get(guildId);
    if (!session || session.closing) return;
    session.closing = true;
    this.sessions.delete(guildId);
    if (session.expiry) clearTimeout(session.expiry);
    session.bridge.close();
    for (const stream of session.inputStreams) stream.destroy();
    session.inputStreams.clear();
    session.player.stop(true);
    session.output.destroy();
    session.outputEncoder.free();
    destroyVoiceConnection(session.connection);
    const normalReasons = new Set(["requested", "moved_channel", "control_timed_out", "worker_stopped", "session_expired"]);
    await this.options.store.markSessionDisconnected(session.connectorKey, session.guildId, normalReasons.has(reason) ? "disconnected" : "error", reason);
    this.options.log("voice_disconnected", {connectorKey: session.connectorKey, guildId: session.guildId, channelId: session.channelId, sessionId: session.sessionId, reason});
  }
}

export class DiscordVoiceControlWorker {
  private dispose?: () => Promise<void>;
  private draining = false;
  private stopped = true;

  constructor(private readonly input: {connectorKey: string; store: DiscordVoiceStore; manager: DiscordVoiceSessionManager}) {}

  async start(): Promise<void> {
    this.stopped = false;
    await this.input.manager.start();
    this.dispose = await this.input.store.listen((notification) => {
      if (notification.connectorKey !== this.input.connectorKey) return;
      void this.drain();
    });
    await this.drain();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.dispose?.(); this.dispose = undefined;
    await this.input.manager.stop();
  }

  async drain(): Promise<void> {
    if (this.draining || this.stopped) return;
    this.draining = true;
    try {
      while (!this.stopped) {
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
    } finally { this.draining = false; }
  }
}
