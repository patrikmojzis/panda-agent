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
import {createDecoder, createEncoder, Application, type OpusEncoderHandle} from "libopus-wasm";

import type {RuntimeRequestRepo} from "../../../domain/threads/requests/repo.js";
import type {DiscordChannelMetadata, DiscordWorkerRestClient} from "./api.js";
import {OpenAILiveRealtimeVoiceBridge, type RealtimeVoiceBridge} from "../../providers/openai-live/bridge.js";
import {resamplePcm16} from "../../providers/openai-live/peer.js";
import type {DiscordVoiceStore} from "./voice-postgres.js";
import {DISCORD_VOICE_MODEL, type DiscordVoiceControlRecord} from "./voice-types.js";

const MAX_UTTERANCE_MS = 60_000;
const MAX_UTTERANCES_PER_MINUTE = 30;
const VOICE_READY_TIMEOUT_MS = 15_000;
const VOICE_RECONNECT_GRACE_MS = 15_000;
const PROVIDER_RECONNECT_DELAYS_MS = [0, 500, 1_500] as const;

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
  outputPending: Buffer;
  player: ReturnType<typeof createAudioPlayer>;
  speakers: DiscordVoiceSpeakerArbiter;
  bridgeGeneration: number;
  failedBridgeGeneration?: number;
  providerRecovery?: Promise<void>;
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
  const message = errorMessage(error).toLowerCase();
  if (message.includes("oauth") || message.includes("401") || message.includes("token")) return "auth_unavailable";
  if (message.includes("timed out") || message.includes("within")) return "timeout";
  if (message.includes("permission") || message.includes("forbidden") || message.includes("403")) return "permission_denied";
  if (message.includes("channel")) return "invalid_channel";
  if (message.includes("limit")) return "provider_startup_failed";
  return "provider_startup_failed";
}

function controlError(failureCode: string, message: string): string {
  return JSON.stringify({failureCode, message: message.slice(0, 500)});
}

export class DiscordVoiceSpeakerArbiter {
  activeSpeakerId?: string;
  lastSpeakerId?: string;
  private acceptedAt: number[] = [];

  start(userId: string, connectorUserId: string, now = Date.now()): "accepted" | "self" | "overlap" | "rate_limit" {
    if (userId === connectorUserId) return "self";
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

async function openVoiceTransport(input: {channelId: string; guildId: string; adapterCreator: DiscordGatewayAdapterCreator; group: string}) {
  const connection = joinVoiceChannel({...input, selfDeaf: false, selfMute: false});
  await entersState(connection, VoiceConnectionStatus.Ready, VOICE_READY_TIMEOUT_MS);
  const output = new PassThrough();
  const player = createAudioPlayer();
  const outputEncoder = await createEncoder({application: Application.Voip, channels: 2, sampleRate: 48_000, frameSize: 960});
  return {connection, output, player, outputEncoder};
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
      const failureCode = classifyFailure(error) === "permission_denied" ? "permission_denied" : "invalid_channel";
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
        agentKey: control.agentKey, voiceSessionId, connection, output, outputEncoder, outputPending: Buffer.alloc(0), player,
        speakers: new DiscordVoiceSpeakerArbiter(), bridgeGeneration: 0, closing: false,
        bridge: undefined as unknown as RealtimeVoiceBridge,
      };
      session.bridge = this.createBridge(session, bridgeFactory);
      connection.subscribe(player);
      player.play(createAudioResource(output, {inputType: StreamType.Opus}));
      this.sessions.set(channel.guildId, session);
      this.attachReceiver(session);
      this.attachConnectionLifecycle(session);
      await session.bridge.connect();
      await this.options.store.upsertSession({connectorKey: control.connectorKey, guildId: channel.guildId, channelId: channel.channelId, sessionId: control.sessionId, agentKey: control.agentKey, voiceSessionId, state: "connected", model: DISCORD_VOICE_MODEL});
      this.options.log("voice_connected", {connectorKey: control.connectorKey, guildId: channel.guildId, channelId: channel.channelId, sessionId: control.sessionId, model: DISCORD_VOICE_MODEL});
      return this.result(session, "connected");
    } catch (error) {
      if (session) await this.stopGuild(channel.guildId, classifyFailure(error));
      else connection?.destroy();
      await this.options.store.markSessionDisconnected(control.connectorKey, channel.guildId, "error", classifyFailure(error));
      throw new Error(controlError(classifyFailure(error), errorMessage(error)));
    }
  }

  private async leave(control: DiscordVoiceControlRecord): Promise<Record<string, unknown>> {
    const session = [...this.sessions.values()].find((candidate) => candidate.sessionId === control.sessionId && (!control.channelId || candidate.channelId === control.channelId));
    if (!session) throw new Error(controlError("invalid_channel", "No owned active Discord voice session matched."));
    const result = this.result(session, "disconnected");
    await this.stopGuild(session.guildId, "requested");
    return result;
  }

  private result(session: ActiveVoiceSession, state: "connected" | "disconnected"): Record<string, unknown> {
    return {ok: true, state, connectorKey: session.connectorKey, guildId: session.guildId, channelId: session.channelId, sessionId: session.sessionId, voiceSessionId: session.voiceSessionId, model: DISCORD_VOICE_MODEL};
  }

  private attachReceiver(session: ActiveVoiceSession): void {
    session.connection.receiver.speaking.on("start", (userId) => {
      const decision = session.speakers.start(userId, this.options.connectorKey);
      if (decision !== "accepted") {
        if (decision !== "self") this.options.log("voice_utterance_dropped", {connectorKey: session.connectorKey, guildId: session.guildId, channelId: session.channelId, speakerId: userId, reason: decision});
        return;
      }
      session.bridge.interrupt();
      const stream = session.connection.receiver.subscribe(userId, {end: {behavior: EndBehaviorType.AfterSilence, duration: 300}});
      const timer = setTimeout(() => stream.destroy(new Error("Maximum Discord voice utterance exceeded.")), MAX_UTTERANCE_MS);
      timer.unref?.();
      void createDecoder({channels: 2, sampleRate: 48_000}).then((decoder) => {
        stream.on("data", (packet: Buffer) => {
          try { if (!session.closing) session.bridge.sendAudio(discordPcmToLive(decoder.decode(packet, {maxFrameSize: 5_760}))); }
          catch (error) { this.options.log("voice_decode_failed", {connectorKey: session.connectorKey, guildId: session.guildId, speakerId: userId, message: errorMessage(error)}); }
        });
        stream.once("close", () => decoder.free());
      }).catch((error: unknown) => stream.destroy(error instanceof Error ? error : new Error(String(error))));
      const release = () => { clearTimeout(timer); session.speakers.finish(userId); };
      stream.once("end", release); stream.once("close", release); stream.once("error", (error) => {
        this.options.log("voice_utterance_ended", {connectorKey: session.connectorKey, guildId: session.guildId, speakerId: userId, message: error.message});
      });
    });
  }

  private attachConnectionLifecycle(session: ActiveVoiceSession): void {
    if (typeof (session.connection as unknown as {on?: unknown}).on !== "function") return;
    session.connection.on("stateChange", (_oldState, newState) => {
      if (session.closing || newState.status !== VoiceConnectionStatus.Disconnected) return;
      void entersState(session.connection, VoiceConnectionStatus.Ready, VOICE_RECONNECT_GRACE_MS).catch(() => this.stopGuild(session.guildId, "discord_reconnect_failed"));
    });
  }

  private writeOutput(session: ActiveVoiceSession, audio: Buffer): void {
    if (session.closing) return;
    session.outputPending = Buffer.concat([session.outputPending, audio]);
    while (session.outputPending.length >= 960) {
      const frame = session.outputPending.subarray(0, 960);
      session.outputPending = session.outputPending.subarray(960);
      session.output.write(Buffer.from(session.outputEncoder.encode(livePcmToDiscord(frame), {frameSize: 960})));
      session.bridge.noteAudioPlayed(20);
    }
    if (session.player.state.status === AudioPlayerStatus.Idle) session.player.play(createAudioResource(session.output, {inputType: StreamType.Opus}));
  }

  private clearPlayback(session: ActiveVoiceSession): void {
    session.player.stop(true);
    session.output.end();
    session.output = new PassThrough();
    session.outputPending = Buffer.alloc(0);
    session.player.play(createAudioResource(session.output, {inputType: StreamType.Opus}));
  }

  private createBridge(session: ActiveVoiceSession, bridgeFactory = this.options.createBridge ?? ((options) => new OpenAILiveRealtimeVoiceBridge(options))): RealtimeVoiceBridge {
    const generation = ++session.bridgeGeneration;
    return bridgeFactory({
      env: this.options.env, voice: this.options.env?.PANDA_DISCORD_VOICE_VOICE ?? "cove",
      onAudio: (audio) => this.writeOutput(session, audio),
      onDelegation: (delegation) => this.delegate(session, delegation.id, delegation.prompt),
      onClearAudio: () => this.clearPlayback(session),
      onClose: (reason) => {
        if (session.closing || session.bridgeGeneration !== generation) return;
        if (reason === "provider_failed") {
          session.failedBridgeGeneration = generation;
          this.recoverProvider(session);
        }
        else void this.stopGuild(session.guildId, reason);
      },
      log: this.options.log,
    });
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
    this.clearPlayback(session);
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

  private async delegate(session: ActiveVoiceSession, delegationId: string, prompt: string): Promise<void> {
    const id = randomUUID();
    await this.options.store.createTurn({id, voiceSessionId: session.voiceSessionId, delegationId, connectorKey: session.connectorKey, guildId: session.guildId, channelId: session.channelId, sessionId: session.sessionId, agentKey: session.agentKey, externalActorId: session.speakers.lastSpeakerId, prompt});
    await this.options.requests.enqueueRequest({kind: "discord_voice_delegation", payload: {voiceTurnId: id}});
    this.options.log("voice_delegation_queued", {connectorKey: session.connectorKey, guildId: session.guildId, channelId: session.channelId, voiceTurnId: id});
  }

  async deliverTurnResult(turnId: string): Promise<void> {
    const turn = await this.options.store.getTurn(turnId);
    if (turn.status !== "completed" && turn.status !== "failed") return;
    const session = [...this.sessions.values()].find((candidate) => candidate.voiceSessionId === turn.voiceSessionId);
    if (!session) return;
    const text = turn.status === "completed" && turn.resultText
      ? turn.resultText
      : "I couldn't complete that request. Please try again.";
    const spoken = session.bridge.appendDelegationResult(turn.delegationId, text);
    this.options.log(spoken ? "voice_delegation_spoken" : "voice_delegation_superseded", {connectorKey: turn.connectorKey, guildId: turn.guildId, voiceTurnId: turn.id});
  }

  private async stopGuild(guildId: string, reason: string): Promise<void> {
    const session = this.sessions.get(guildId);
    if (!session || session.closing) return;
    session.closing = true;
    this.sessions.delete(guildId);
    session.bridge.close();
    session.player.stop(true);
    session.output.end();
    session.outputEncoder.free();
    session.connection.destroy();
    await this.options.store.markSessionDisconnected(session.connectorKey, session.guildId, reason === "provider_failed" || reason === "auth_unavailable" ? "error" : "disconnected", reason);
    this.options.log("voice_disconnected", {connectorKey: session.connectorKey, guildId: session.guildId, channelId: session.channelId, sessionId: session.sessionId, reason});
  }
}

export class DiscordVoiceControlWorker {
  private dispose?: () => Promise<void>;
  private draining = false;
  private stopped = true;

  constructor(private readonly input: {connectorKey: string; store: DiscordVoiceStore; manager: DiscordVoiceSessionManager; log(event: string, payload: Record<string, unknown>): void}) {}

  async start(): Promise<void> {
    this.stopped = false;
    await this.input.manager.start();
    this.dispose = await this.input.store.listen((notification) => {
      if (notification.connectorKey !== this.input.connectorKey) return;
      if (notification.kind === "control") void this.drain();
      else void this.input.manager.deliverTurnResult(notification.turnId).catch((error: unknown) => this.input.log("voice_turn_delivery_failed", {connectorKey: this.input.connectorKey, message: errorMessage(error)}));
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
