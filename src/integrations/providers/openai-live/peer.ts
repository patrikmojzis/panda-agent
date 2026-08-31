import {randomInt} from "node:crypto";

import {resamplePcm16} from "../../voice/pcm.js";
import {RtpReorderBuffer, type RtpReorderOutput} from "../../voice/rtp-reorder.js";

const PROVIDER_RATE = 48_000;
const RELAY_RATE = 24_000;
const CHANNELS = 2;
const FRAME_SAMPLES = 960;
const FRAME_MS = 20;
const RELAY_FRAME_BYTES = 960;
const MAX_PENDING_BYTES = RELAY_RATE * 2 * 5;
const RTP_REORDER_DEPTH = 4;
const RTP_REORDER_FLUSH_MS = 40;
const RTP_CLEAR_QUARANTINE_MS = 200;

type Werift = typeof import("werift");
type Libopus = typeof import("libopus-wasm");
type Peer = InstanceType<Werift["RTCPeerConnection"]>;
type Transceiver = ReturnType<Peer["addTransceiver"]>;
type Track = Parameters<Peer["onTrack"]["subscribe"]>[0] extends (track: infer T) => unknown ? T : never;
type RtpPacket = InstanceType<Werift["RtpPacket"]>;

export interface OpenAILiveAudioPeer {
  createOffer(): Promise<string>;
  applyAnswer(sdp: string): Promise<void>;
  waitUntilConnected(signal: AbortSignal): Promise<void>;
  sendAudio(pcm24kMono: Buffer): void;
  discardPendingOutput?(): void;
  getHealthSnapshot?(): OpenAILiveAudioPeerHealth;
  close(): void;
}

export interface OpenAILiveAudioPeerHealth {
  state: "connecting" | "connected" | "failed" | "closed";
  lastRtpAt: number | null;
  receivedPackets: number;
  lossMarkers: number;
  plcFrames: number;
  decodeFailures: number;
  ssrcChanges: number;
  pendingInputMs: number;
  droppedInputMs: number;
}

export interface OpenAILiveAudioCallbacks {onAudio(pcm24kMono: Buffer): void; onError(error: Error): void}

function errorOf(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }

export type OpenAILiveRtpOutput<T> = RtpReorderOutput<T>;
export class OpenAILiveRtpReorderBuffer<T> extends RtpReorderBuffer<T> {
  constructor() { super(RTP_REORDER_DEPTH); }
}

function bufferToSamples(buffer: Buffer): Int16Array {
  const samples = new Int16Array(Math.floor(buffer.length / 2));
  for (let i = 0; i < samples.length; i += 1) samples[i] = buffer.readInt16LE(i * 2);
  return samples;
}

function samplesToBuffer(samples: Int16Array): Buffer {
  const output = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) output.writeInt16LE(samples[i] ?? 0, i * 2);
  return output;
}

function relayToProvider(buffer: Buffer): Int16Array {
  const mono = resamplePcm16(bufferToSamples(buffer), RELAY_RATE, PROVIDER_RATE);
  const stereo = new Int16Array(mono.length * 2);
  for (let i = 0; i < mono.length; i += 1) stereo[i * 2] = stereo[i * 2 + 1] = mono[i] ?? 0;
  return stereo;
}

function providerToRelay(stereo: Int16Array): Buffer {
  const mono = new Int16Array(Math.floor(stereo.length / 2));
  for (let i = 0; i < mono.length; i += 1) mono[i] = Math.round(((stereo[i * 2] ?? 0) + (stereo[i * 2 + 1] ?? 0)) / 2);
  return samplesToBuffer(resamplePcm16(mono, PROVIDER_RATE, RELAY_RATE));
}

class RelayPcmQueue {
  private readonly chunks: Buffer[] = [];
  private headOffset = 0;
  private bytes = 0;

  constructor(private readonly maxBytes: number, private readonly frameBytes: number) {}

  get byteLength(): number { return this.bytes; }

  push(input: Buffer): number {
    if (input.length === 0) return 0;
    this.chunks.push(Buffer.from(input));
    this.bytes += input.length;
    const excess = Math.max(0, this.bytes - this.maxBytes);
    if (excess === 0) return 0;
    const dropped = Math.min(this.bytes, Math.ceil(excess / this.frameBytes) * this.frameBytes);
    this.discard(dropped);
    return dropped;
  }

  shiftPadded(size: number): Buffer {
    const output = Buffer.alloc(size);
    let written = 0;
    while (written < size && this.bytes > 0) {
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
    let remaining = Math.min(size, this.bytes);
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

export class WeriftOpenAILiveAudioPeer implements OpenAILiveAudioPeer {
  static async create(callbacks: OpenAILiveAudioCallbacks, signal?: AbortSignal): Promise<WeriftOpenAILiveAudioPeer> {
    const [werift, opus] = await Promise.all([import("werift"), import("libopus-wasm")]);
    signal?.throwIfAborted();
    const peer = new werift.RTCPeerConnection({codecs: {audio: [werift.useOPUS({payloadType: 111})], video: []}});
    const transceiver = peer.addTransceiver("audio", {direction: "sendrecv"});
    let encoder: Awaited<ReturnType<Libopus["createEncoder"]>> | undefined;
    let decoder: Awaited<ReturnType<Libopus["createDecoder"]>> | undefined;
    try {
      encoder = await opus.createEncoder({application: opus.Application.Voip, channels: CHANNELS, sampleRate: PROVIDER_RATE, frameSize: FRAME_SAMPLES});
      signal?.throwIfAborted();
      decoder = await opus.createDecoder({channels: CHANNELS, sampleRate: PROVIDER_RATE});
      signal?.throwIfAborted();
      return new WeriftOpenAILiveAudioPeer({callbacks, werift, peer, transceiver, encoder, decoder});
    } catch (error) {
      encoder?.free();
      decoder?.free();
      await peer.close().catch(() => undefined);
      throw error;
    }
  }

  private closed = false;
  private connected = false;
  private timer?: NodeJS.Timeout;
  private readonly pending = new RelayPcmQueue(MAX_PENDING_BYTES, RELAY_FRAME_BYTES);
  private sequence = randomInt(0x1_0000);
  private timestamp = randomInt(0x1_0000_0000);
  private readonly tracks = new Set<string>();
  private readonly connectionWaiters = new Set<{resolve(): void; reject(error: Error): void; signal: AbortSignal; onAbort(): void}>();
  private readonly inboundReorder = new OpenAILiveRtpReorderBuffer<RtpPacket>();
  private inboundSsrc?: number;
  private inboundFlushTimer?: NodeJS.Timeout;
  private connectionError?: Error;
  private mediaState: OpenAILiveAudioPeerHealth["state"] = "connecting";
  private lastRtpAt?: number;
  private receivedPackets = 0;
  private lossMarkers = 0;
  private plcFrames = 0;
  private decodeFailures = 0;
  private ssrcChanges = 0;
  private droppedInputBytes = 0;

  private constructor(private readonly state: {callbacks: OpenAILiveAudioCallbacks; werift: Werift; peer: Peer; transceiver: Transceiver; encoder: Awaited<ReturnType<Libopus["createEncoder"]>>; decoder: Awaited<ReturnType<Libopus["createDecoder"]>>}) {
    state.peer.onTrack.subscribe((track) => this.attachTrack(track));
    state.peer.connectionStateChange.subscribe((status) => {
      if (this.closed) return;
      if (status === "connected") {
        this.connected = true;
        this.mediaState = "connected";
        this.settleConnectionWaiters();
        this.startPump();
      }
      if (["failed", "disconnected", "closed"].includes(status)) {
        this.connected = false;
        this.mediaState = status === "closed" ? "closed" : "failed";
        this.connectionError = new Error(`GPT-Live WebRTC media connection ${status}.`);
        this.settleConnectionWaiters(this.connectionError);
        state.callbacks.onError(this.connectionError);
      }
    });
  }

  async createOffer(): Promise<string> {
    const offer = await this.state.peer.createOffer();
    await this.state.peer.setLocalDescription(offer);
    const sdp = this.state.peer.localDescription?.sdp;
    if (!sdp?.trim()) throw new Error("GPT-Live peer produced no SDP offer.");
    return sdp;
  }

  async applyAnswer(sdp: string): Promise<void> {
    await this.state.peer.setRemoteDescription({type: "answer", sdp});
    this.attachTrack(this.state.transceiver.receiver.track);
  }

  waitUntilConnected(signal: AbortSignal): Promise<void> {
    if (this.connected) return Promise.resolve();
    if (this.connectionError) return Promise.reject(this.connectionError);
    if (this.closed) return Promise.reject(new Error("GPT-Live WebRTC media connection is closed."));
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        signal,
        onAbort: () => {
          this.connectionWaiters.delete(waiter);
          reject(signal.reason instanceof Error ? signal.reason : new Error("GPT-Live WebRTC startup stopped."));
        },
      };
      this.connectionWaiters.add(waiter);
      signal.addEventListener("abort", waiter.onAbort, {once: true});
    });
  }

  sendAudio(audio: Buffer): void {
    if (this.closed || audio.length < 2) return;
    const evenAudio = audio.subarray(0, audio.length - audio.length % 2);
    this.droppedInputBytes += this.pending.push(evenAudio);
  }

  discardPendingOutput(): void {
    this.inboundReorder.discardPending(Date.now(), RTP_CLEAR_QUARANTINE_MS);
    this.clearInboundFlushTimer();
  }

  getHealthSnapshot(): OpenAILiveAudioPeerHealth {
    return {
      state: this.mediaState,
      lastRtpAt: this.lastRtpAt ?? null,
      receivedPackets: this.receivedPackets,
      lossMarkers: this.lossMarkers,
      plcFrames: this.plcFrames,
      decodeFailures: this.decodeFailures,
      ssrcChanges: this.ssrcChanges,
      pendingInputMs: Math.round(this.pending.byteLength / (RELAY_RATE * 2) * 1_000),
      droppedInputMs: Math.round(this.droppedInputBytes / (RELAY_RATE * 2) * 1_000),
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.mediaState = "closed";
    if (this.timer) clearInterval(this.timer);
    if (this.inboundFlushTimer) clearTimeout(this.inboundFlushTimer);
    this.settleConnectionWaiters(new Error("GPT-Live WebRTC media connection is closed."));
    this.inboundReorder.reset();
    this.pending.clear();
    this.state.encoder.free();
    this.state.decoder.free();
    void this.state.peer.close().catch(() => undefined);
  }

  private attachTrack(track: Track): void {
    if (track.kind !== "audio" || this.tracks.has(track.uuid)) return;
    this.tracks.add(track.uuid);
    track.onReceiveRtp.subscribe((packet) => {
      if (this.closed) return;
      this.lastRtpAt = Date.now();
      this.receivedPackets += 1;
      if (this.inboundSsrc !== undefined && this.inboundSsrc !== packet.header.ssrc) {
        this.ssrcChanges += 1;
        this.inboundReorder.reset();
        this.clearInboundFlushTimer();
      }
      this.inboundSsrc = packet.header.ssrc;
      this.processInbound(this.inboundReorder.push(packet.header.sequenceNumber, packet));
      this.refreshInboundFlushTimer();
    });
  }

  private processInbound(outputs: OpenAILiveRtpOutput<RtpPacket>[]): void {
    if (this.closed) return;
    for (const output of outputs) {
      try {
        if (output.kind === "loss") this.lossMarkers += 1;
        const decoded = output.kind === "loss"
          ? (this.plcFrames += 1, this.state.decoder.decodePacketLoss(FRAME_SAMPLES))
          : this.state.decoder.decode(this.state.werift.dePacketizeRtpPackets("opus", [output.packet]).data, {maxFrameSize: 5_760});
        this.state.callbacks.onAudio(providerToRelay(decoded));
      } catch (error) {
        this.decodeFailures += 1;
        try { this.plcFrames += 1; this.state.callbacks.onAudio(providerToRelay(this.state.decoder.decodePacketLoss(FRAME_SAMPLES))); }
        catch { this.state.callbacks.onError(errorOf(error)); }
      }
    }
  }

  private settleConnectionWaiters(error?: Error): void {
    for (const waiter of this.connectionWaiters) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      error ? waiter.reject(error) : waiter.resolve();
    }
    this.connectionWaiters.clear();
  }

  private startPump(): void {
    if (this.timer) return;
    this.sendFrame();
    this.timer = setInterval(() => this.sendFrame(), FRAME_MS);
    this.timer.unref?.();
  }

  private sendFrame(): void {
    if (!this.connected || this.closed) return;
    const frame = this.pending.shiftPadded(RELAY_FRAME_BYTES);
    try {
      const encoded = this.state.encoder.encode(relayToProvider(frame), {frameSize: FRAME_SAMPLES});
      const packet = new this.state.werift.RtpPacket(new this.state.werift.RtpHeader({payloadType: 111, sequenceNumber: this.sequence, timestamp: this.timestamp}), Buffer.from(encoded));
      this.sequence = (this.sequence + 1) & 0xffff;
      this.timestamp = (this.timestamp + FRAME_SAMPLES) >>> 0;
      void this.state.transceiver.sender.sendRtp(packet).catch((error: unknown) => this.state.callbacks.onError(errorOf(error)));
    } catch (error) { this.state.callbacks.onError(errorOf(error)); }
  }

  private refreshInboundFlushTimer(): void {
    if (!this.inboundReorder.hasPending) {
      this.clearInboundFlushTimer();
      return;
    }
    if (this.inboundFlushTimer) return;
    this.inboundFlushTimer = setTimeout(() => {
      this.inboundFlushTimer = undefined;
      this.processInbound(this.inboundReorder.flush());
      this.refreshInboundFlushTimer();
    }, RTP_REORDER_FLUSH_MS);
    this.inboundFlushTimer.unref?.();
  }

  private clearInboundFlushTimer(): void {
    if (this.inboundFlushTimer) clearTimeout(this.inboundFlushTimer);
    this.inboundFlushTimer = undefined;
  }
}
