import {randomInt} from "node:crypto";

const PROVIDER_RATE = 48_000;
const RELAY_RATE = 24_000;
const CHANNELS = 2;
const FRAME_SAMPLES = 960;
const FRAME_MS = 20;
const RELAY_FRAME_BYTES = 960;
const MAX_PENDING_BYTES = RELAY_RATE * 2 * 5;
const RTP_SEQUENCE_MOD = 0x1_0000;
const RTP_SEQUENCE_HALF = 0x8000;
const RTP_REORDER_DEPTH = 4;
const RTP_REORDER_FLUSH_MS = 40;

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
  close(): void;
}

export interface OpenAILiveAudioCallbacks {onAudio(pcm24kMono: Buffer): void; onError(error: Error): void}

function errorOf(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }

export type OpenAILiveRtpOutput<T> = {kind: "packet"; packet: T} | {kind: "loss"};

/** Bounded RTP sequence reorder buffer with packet-loss markers for Opus PLC. */
export class OpenAILiveRtpReorderBuffer<T> {
  private expected?: number;
  private readonly pending = new Map<number, T>();

  get hasPending(): boolean { return this.pending.size > 0; }

  push(sequence: number, packet: T): OpenAILiveRtpOutput<T>[] {
    const normalized = sequence & 0xffff;
    this.expected ??= normalized;
    const distance = this.distance(normalized);
    if (distance >= RTP_SEQUENCE_HALF || this.pending.has(normalized)) return [];
    this.pending.set(normalized, packet);
    const ready = this.drainReady();
    if (this.pending.size >= RTP_REORDER_DEPTH) ready.push(...this.flush());
    return ready;
  }

  flush(): OpenAILiveRtpOutput<T>[] {
    if (this.expected === undefined || this.pending.size === 0) return [];
    const nearest = [...this.pending.keys()].reduce((best, sequence) => Math.min(best, this.distance(sequence)), RTP_SEQUENCE_MOD);
    const output: OpenAILiveRtpOutput<T>[] = [];
    for (let index = 0; index < Math.min(nearest, RTP_REORDER_DEPTH); index += 1) {
      output.push({kind: "loss"});
      this.expected = (this.expected + 1) & 0xffff;
    }
    if (nearest > RTP_REORDER_DEPTH) this.expected = [...this.pending.keys()].reduce((best, sequence) => this.distance(sequence) < this.distance(best) ? sequence : best);
    output.push(...this.drainReady());
    return output;
  }

  reset(): void {
    this.expected = undefined;
    this.pending.clear();
  }

  private distance(sequence: number): number {
    return (sequence - (this.expected ?? sequence) + RTP_SEQUENCE_MOD) % RTP_SEQUENCE_MOD;
  }

  private drainReady(): OpenAILiveRtpOutput<T>[] {
    const output: OpenAILiveRtpOutput<T>[] = [];
    while (this.expected !== undefined && this.pending.has(this.expected)) {
      const packet = this.pending.get(this.expected)!;
      this.pending.delete(this.expected);
      output.push({kind: "packet", packet});
      this.expected = (this.expected + 1) & 0xffff;
    }
    return output;
  }
}

/** Linear PCM16 resampler used only at the Discord/GPT-Live transport boundary. */
export function resamplePcm16(input: Int16Array, sourceRate: number, targetRate: number): Int16Array {
  if (input.length === 0) return new Int16Array();
  if (sourceRate === targetRate) return new Int16Array(input);
  const length = Math.max(1, Math.round(input.length * targetRate / sourceRate));
  const output = new Int16Array(length);
  for (let index = 0; index < length; index += 1) {
    const position = index * sourceRate / targetRate;
    const left = Math.min(input.length - 1, Math.floor(position));
    const right = Math.min(input.length - 1, left + 1);
    const fraction = position - left;
    output[index] = Math.round((input[left] ?? 0) * (1 - fraction) + (input[right] ?? 0) * fraction);
  }
  return output;
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
  private pending = Buffer.alloc(0);
  private sequence = randomInt(0x1_0000);
  private timestamp = randomInt(0x1_0000_0000);
  private readonly tracks = new Set<string>();
  private readonly connectionWaiters = new Set<{resolve(): void; reject(error: Error): void; signal: AbortSignal; onAbort(): void}>();
  private readonly inboundReorder = new OpenAILiveRtpReorderBuffer<RtpPacket>();
  private inboundSsrc?: number;
  private inboundFlushTimer?: NodeJS.Timeout;
  private connectionError?: Error;

  private constructor(private readonly state: {callbacks: OpenAILiveAudioCallbacks; werift: Werift; peer: Peer; transceiver: Transceiver; encoder: Awaited<ReturnType<Libopus["createEncoder"]>>; decoder: Awaited<ReturnType<Libopus["createDecoder"]>>}) {
    state.peer.onTrack.subscribe((track) => this.attachTrack(track));
    state.peer.connectionStateChange.subscribe((status) => {
      if (this.closed) return;
      if (status === "connected") {
        this.connected = true;
        this.settleConnectionWaiters();
        this.startPump();
      }
      if (["failed", "disconnected", "closed"].includes(status)) {
        this.connected = false;
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
    this.pending = Buffer.concat([this.pending, Buffer.from(evenAudio)]);
    if (this.pending.length > MAX_PENDING_BYTES) this.pending = this.pending.subarray(this.pending.length - MAX_PENDING_BYTES);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.inboundFlushTimer) clearTimeout(this.inboundFlushTimer);
    this.settleConnectionWaiters(new Error("GPT-Live WebRTC media connection is closed."));
    this.inboundReorder.reset();
    this.pending = Buffer.alloc(0);
    this.state.encoder.free();
    this.state.decoder.free();
    void this.state.peer.close().catch(() => undefined);
  }

  private attachTrack(track: Track): void {
    if (track.kind !== "audio" || this.tracks.has(track.uuid)) return;
    this.tracks.add(track.uuid);
    track.onReceiveRtp.subscribe((packet) => {
      if (this.closed) return;
      if (this.inboundSsrc !== undefined && this.inboundSsrc !== packet.header.ssrc) this.inboundReorder.reset();
      this.inboundSsrc = packet.header.ssrc;
      this.processInbound(this.inboundReorder.push(packet.header.sequenceNumber, packet));
      if (this.inboundReorder.hasPending && !this.inboundFlushTimer) {
        this.inboundFlushTimer = setTimeout(() => {
          this.inboundFlushTimer = undefined;
          this.processInbound(this.inboundReorder.flush());
        }, RTP_REORDER_FLUSH_MS);
        this.inboundFlushTimer.unref?.();
      }
    });
  }

  private processInbound(outputs: OpenAILiveRtpOutput<RtpPacket>[]): void {
    if (this.closed) return;
    for (const output of outputs) {
      try {
        const decoded = output.kind === "loss"
          ? this.state.decoder.decodePacketLoss(FRAME_SAMPLES)
          : this.state.decoder.decode(this.state.werift.dePacketizeRtpPackets("opus", [output.packet]).data, {maxFrameSize: 5_760});
        this.state.callbacks.onAudio(providerToRelay(decoded));
      } catch (error) {
        try { this.state.callbacks.onAudio(providerToRelay(this.state.decoder.decodePacketLoss(FRAME_SAMPLES))); }
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
    const frame = Buffer.alloc(RELAY_FRAME_BYTES);
    const bytes = Math.min(frame.length, this.pending.length);
    this.pending.copy(frame, 0, 0, bytes);
    this.pending = this.pending.subarray(bytes);
    try {
      const encoded = this.state.encoder.encode(relayToProvider(frame), {frameSize: FRAME_SAMPLES});
      const packet = new this.state.werift.RtpPacket(new this.state.werift.RtpHeader({payloadType: 111, sequenceNumber: this.sequence, timestamp: this.timestamp}), Buffer.from(encoded));
      this.sequence = (this.sequence + 1) & 0xffff;
      this.timestamp = (this.timestamp + FRAME_SAMPLES) >>> 0;
      void this.state.transceiver.sender.sendRtp(packet).catch((error: unknown) => this.state.callbacks.onError(errorOf(error)));
    } catch (error) { this.state.callbacks.onError(errorOf(error)); }
  }
}
