import {Readable} from "node:stream";

import {AudioPlayerStatus, StreamType, createAudioResource, type createAudioPlayer} from "@discordjs/voice";
import type {OpusEncoderHandle} from "libopus-wasm";

import {hasAudiblePcm16, resamplePcm16} from "../../voice/pcm.js";

const LIVE_FRAME_BYTES = 960;
const DISCORD_FRAME_SAMPLES = 960;
const DEFAULT_PREROLL_FRAMES = 4;
const DEFAULT_END_QUIET_MS = 300;
const MAX_QUEUED_PACKETS = 250;

/** Bounded 20 ms Discord player misses tolerated while GPT-Live RTP catches up. */
export const DISCORD_VOICE_MAX_MISSED_FRAMES = 16;

export type DiscordVoicePlaybackState = "idle" | "preroll" | "streaming" | "ending" | "closed";

export interface DiscordVoicePlaybackSnapshot {
  state: DiscordVoicePlaybackState;
  responseEpoch: number;
  residualBytes: number;
  queuedPackets: number;
  queuedMs: number;
  interrupts: number;
  silentLeadingChunks: number;
  overruns: number;
}

interface DiscordVoicePlaybackOptions {
  player: ReturnType<typeof createAudioPlayer>;
  encoder: OpusEncoderHandle;
  onError(error: Error): void;
  onStateChange?(): void;
  prerollFrames?: number;
  endQuietMs?: number;
}

function errorOf(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }

function bufferToSamples(buffer: Buffer): Int16Array {
  const output = new Int16Array(Math.floor(buffer.length / 2));
  for (let index = 0; index < output.length; index += 1) output[index] = buffer.readInt16LE(index * 2);
  return output;
}

function livePcmToDiscord(pcm: Buffer): Int16Array {
  const mono = resamplePcm16(bufferToSamples(pcm), 24_000, 48_000);
  const stereo = new Int16Array(mono.length * 2);
  for (let index = 0; index < mono.length; index += 1) stereo[index * 2] = stereo[index * 2 + 1] = mono[index] ?? 0;
  return stereo;
}

/** Packet-aware GPT-Live PCM to Discord Opus playback with response boundaries. */
export class DiscordVoicePlayback {
  private state: DiscordVoicePlaybackState = "idle";
  private responseEpoch = 0;
  private residual = Buffer.alloc(0);
  private packets: Buffer[] = [];
  private source?: Readable;
  private sourceEpoch?: number;
  private sealed = false;
  private endTimer?: NodeJS.Timeout;
  private interrupts = 0;
  private silentLeadingChunks = 0;
  private overruns = 0;
  private encoderFreed = false;

  constructor(private readonly options: DiscordVoicePlaybackOptions) {}

  pushPcm(input: Buffer): void {
    if (this.state === "closed" || input.length === 0) return;
    if (this.state === "idle" && input.length >= 2 && !hasAudiblePcm16(input)) {
      this.silentLeadingChunks += 1;
      this.changed();
      return;
    }
    if (this.state === "idle") this.beginResponse();
    if (this.sealed) this.sealed = false;
    this.scheduleSeal();
    const pcm = this.residual.length > 0 ? Buffer.concat([this.residual, input]) : Buffer.from(input);
    let offset = 0;
    try {
      while (pcm.length - offset >= LIVE_FRAME_BYTES) {
        this.enqueuePacket(this.encodeFrame(pcm.subarray(offset, offset + LIVE_FRAME_BYTES)));
        offset += LIVE_FRAME_BYTES;
        if (this.state === "idle") return;
      }
      this.residual = Buffer.from(pcm.subarray(offset));
      if (!this.source && this.packets.length >= (this.options.prerollFrames ?? DEFAULT_PREROLL_FRAMES)) this.startPlayback();
      this.drainPackets();
      this.changed();
    } catch (error) {
      this.options.onError(errorOf(error));
    }
  }

  interrupt(): void {
    if (this.state === "closed") return;
    this.interrupts += 1;
    this.resetResponse(true);
    this.changed();
  }

  handlePlayerIdle(): void {
    if (this.state === "closed") return;
    const source = this.source;
    this.source = undefined;
    this.sourceEpoch = undefined;
    if (source && !source.destroyed) source.destroy();
    if (this.packets.length > 0) {
      this.startPlayback();
      return;
    }
    if (this.sealed) this.finishResponseEpoch();
    this.changed();
  }

  reset(): void {
    if (this.state === "closed") return;
    this.resetResponse(true);
    this.changed();
  }

  getSnapshot(): DiscordVoicePlaybackSnapshot {
    return {
      state: this.state,
      responseEpoch: this.responseEpoch,
      residualBytes: this.residual.length,
      queuedPackets: this.packets.length,
      queuedMs: this.packets.length * 20,
      interrupts: this.interrupts,
      silentLeadingChunks: this.silentLeadingChunks,
      overruns: this.overruns,
    };
  }

  close(): void {
    if (this.state === "closed") return;
    this.resetResponse(true);
    this.state = "closed";
    if (!this.encoderFreed) {
      this.encoderFreed = true;
      this.options.encoder.free();
    }
    this.changed();
  }

  private beginResponse(): void {
    this.responseEpoch += 1;
    this.state = "preroll";
    this.residual = Buffer.alloc(0);
    this.sealed = false;
  }

  private encodeFrame(frame: Buffer): Buffer {
    return Buffer.from(this.options.encoder.encode(livePcmToDiscord(frame), {frameSize: DISCORD_FRAME_SAMPLES}));
  }

  private enqueuePacket(packet: Buffer): void {
    if (this.packets.length >= MAX_QUEUED_PACKETS) {
      this.overruns += 1;
      this.resetResponse(true);
      return;
    }
    this.packets.push(packet);
  }

  private startPlayback(): void {
    if (this.source?.destroyed || this.source?.readableEnded) {
      this.source = undefined;
      this.sourceEpoch = undefined;
    }
    if (this.source || this.packets.length === 0 || this.state === "idle" || this.state === "closed") return;
    const epoch = this.responseEpoch;
    const source = new Readable({
      objectMode: true,
      highWaterMark: 1,
      read: () => this.drainPackets(),
    });
    this.source = source;
    this.sourceEpoch = epoch;
    source.once("end", () => this.finishSource(epoch, source));
    source.once("close", () => this.finishSource(epoch, source));
    source.once("error", (error) => {
      this.finishSource(epoch, source);
      this.options.onError(error);
    });
    this.options.player.play(createAudioResource(source, {inputType: StreamType.Opus}));
    if (this.state !== "ending") this.state = "streaming";
    this.drainPackets();
  }

  private drainPackets(): void {
    const source = this.source;
    if (!source || source.destroyed || source.readableEnded) {
      if (source) this.finishSource(this.sourceEpoch ?? -1, source);
      return;
    }
    while (this.packets.length > 0) {
      if (!source.push(this.packets.shift()!)) break;
    }
  }

  private scheduleSeal(): void {
    if (this.endTimer) clearTimeout(this.endTimer);
    this.endTimer = setTimeout(() => {
      this.endTimer = undefined;
      this.sealResponse();
    }, this.options.endQuietMs ?? DEFAULT_END_QUIET_MS);
    this.endTimer.unref?.();
  }

  private sealResponse(): void {
    if (this.state === "idle" || this.state === "closed" || this.sealed) return;
    try {
      if (this.residual.length > 0) {
        const finalFrame = Buffer.alloc(LIVE_FRAME_BYTES);
        this.residual.copy(finalFrame);
        this.residual = Buffer.alloc(0);
        this.enqueuePacket(this.encodeFrame(finalFrame));
      }
      this.sealed = true;
      this.state = "ending";
      if (this.packets.length > 0) this.startPlayback();
      this.drainPackets();
      if (!this.source && this.packets.length === 0) this.finishResponseEpoch();
      this.changed();
    } catch (error) {
      this.options.onError(errorOf(error));
    }
  }

  private finishSource(epoch: number, source: Readable): void {
    if (this.sourceEpoch !== epoch || this.source !== source) return;
    this.source = undefined;
    this.sourceEpoch = undefined;
    if (this.packets.length > 0) this.startPlayback();
    else if (this.sealed) this.finishResponseEpoch();
    this.changed();
  }

  private finishResponseEpoch(): void {
    this.residual = Buffer.alloc(0);
    this.packets = [];
    this.sealed = false;
    if (this.state !== "closed") this.state = "idle";
  }

  private resetResponse(stopPlayer: boolean): void {
    if (this.endTimer) clearTimeout(this.endTimer);
    this.endTimer = undefined;
    const source = this.source;
    this.source = undefined;
    this.sourceEpoch = undefined;
    this.residual = Buffer.alloc(0);
    this.packets = [];
    this.sealed = false;
    source?.destroy();
    if (stopPlayer && this.options.player.state.status !== AudioPlayerStatus.Idle) this.options.player.stop(true);
    if (this.state !== "closed") this.state = "idle";
  }

  private changed(): void { this.options.onStateChange?.(); }
}
