import {randomInt} from "node:crypto";
import {isIP} from "node:net";
import ipaddr from "ipaddr.js";
import {Application, createDecoder, createEncoder, type OpusDecoderHandle, type OpusEncoderHandle} from "libopus-wasm";
import {RTCPeerConnection, RtpHeader, RtpPacket, dePacketizeRtpPackets, useOPUS, type MediaStreamTrack, type RTCRtpTransceiver} from "werift";

import {pcm16leToSamples, resamplePcm16, samplesToPcm16le} from "../../../voice/pcm.js";
import {RtpReorderBuffer, type RtpReorderOutput} from "../../../voice/rtp-reorder.js";

const OPUS_RATE = 48_000;
const RELAY_RATE = 24_000;
const FRAME_SAMPLES = 960;
const FRAME_BYTES = 960;
const FRAME_MS = 20;
const MAX_QUEUE_BYTES = RELAY_RATE * 2 * 5;
const REORDER_FLUSH_MS = 40;
const MAX_INBOUND_PACKET_BYTES = 4 * 1024;
const MAX_INBOUND_PACKETS_PER_SECOND = 200;
const MAX_INBOUND_BYTES_PER_SECOND = 512 * 1024;
const MAX_REMOTE_ICE_CANDIDATES = 32;
const MAX_REMOTE_MEDIA_SECTIONS = 4;

type RemoteCandidatePolicy = (host: string) => boolean;

/** Allows only canonical, globally routable IP literals as remote ICE targets. */
export function isSafeWhatsAppIceAddress(host: string): boolean {
  if (host.includes("%") || isIP(host) === 0) return false;
  try { return ipaddr.process(host).range() === "unicast"; }
  catch { return false; }
}

export function validateWhatsAppOfferSdp(offerSdp: string, allowRemoteCandidate: RemoteCandidatePolicy = isSafeWhatsAppIceAddress): void {
  let candidates = 0;
  let mediaSections = 0;
  for (const rawLine of offerSdp.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.startsWith("m=")) {
      mediaSections += 1;
      if (mediaSections > MAX_REMOTE_MEDIA_SECTIONS) throw new Error("WhatsApp SDP offer has too many media sections.");
    }
    if (!line.startsWith("a=candidate:")) continue;
    candidates += 1;
    if (candidates > MAX_REMOTE_ICE_CANDIDATES) throw new Error("WhatsApp SDP offer has too many ICE candidates.");
    const fields = line.split(/\s+/u);
    const host = fields[4];
    if (!host || fields[6] !== "typ" || !allowRemoteCandidate(host)) throw new Error("WhatsApp SDP offer contains an unsafe ICE candidate.");
  }
}

class PcmQueue {
  private chunks: Buffer[] = [];
  private bytes = 0;
  get length(): number { return this.bytes; }
  push(buffer: Buffer): number {
    let dropped = Math.max(0, buffer.length - MAX_QUEUE_BYTES);
    const bounded = dropped > 0 ? buffer.subarray(buffer.length - MAX_QUEUE_BYTES) : buffer;
    this.chunks.push(Buffer.from(bounded)); this.bytes += bounded.length;
    while (this.bytes > MAX_QUEUE_BYTES && this.chunks.length) { const chunk = this.chunks.shift()!; this.bytes -= chunk.length; dropped += chunk.length; }
    return dropped;
  }
  shift(size: number): Buffer {
    const output = Buffer.alloc(size);
    let offset = 0;
    while (offset < size && this.chunks.length) {
      const chunk = this.chunks[0]!;
      const take = Math.min(size - offset, chunk.length);
      chunk.copy(output, offset, 0, take); offset += take; this.bytes -= take;
      if (take === chunk.length) this.chunks.shift(); else this.chunks[0] = chunk.subarray(take);
    }
    return output;
  }
  clear(): void { this.chunks = []; this.bytes = 0; }
}

export interface WhatsAppCallPeerSnapshot {
  state: string;
  receivedPackets: number;
  sentPackets: number;
  lossMarkers: number;
  decodeFailures: number;
  queuedMs: number;
  droppedOutputMs: number;
  ssrcChanges: number;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

export interface WhatsAppCallPeerLike {
  answer(offerSdp: string, signal: AbortSignal): Promise<string>;
  waitUntilConnected(signal: AbortSignal): Promise<void>;
  startOutput(): void;
  pushPcm(audio: Buffer): number;
  clearOutput(): void;
  snapshot(): WhatsAppCallPeerSnapshot;
  close(): void;
}

function abortablePeerOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("WhatsApp WebRTC startup stopped."));
  return new Promise((resolve, reject) => {
    const onAbort = () => finish(undefined, signal.reason instanceof Error ? signal.reason : new Error("WhatsApp WebRTC startup stopped."));
    const finish = (value?: T, error?: unknown) => {
      signal.removeEventListener("abort", onAbort);
      error === undefined ? resolve(value as T) : reject(error);
    };
    signal.addEventListener("abort", onAbort, {once: true});
    void operation.then((value) => finish(value), (error: unknown) => finish(undefined, error));
  });
}

/** Terminates Meta's WebRTC audio leg and exposes only 24 kHz mono PCM. */
export class WhatsAppCallPeer implements WhatsAppCallPeerLike {
  static async create(input: {onAudio(pcm24kMono: Buffer): void; onFailure(error: Error): void; allowRemoteCandidate?: RemoteCandidatePolicy}): Promise<WhatsAppCallPeer> {
    const allowRemoteCandidate = input.allowRemoteCandidate ?? isSafeWhatsAppIceAddress;
    const peer = new RTCPeerConnection({
      codecs: {audio: [useOPUS({payloadType: 111})], video: []},
      iceFilterCandidatePair: (pair) => allowRemoteCandidate(pair.remoteCandidate.host),
    });
    const transceiver = peer.addTransceiver("audio", {direction: "sendrecv"});
    const [encoder, decoder] = await Promise.all([
      createEncoder({application: Application.Voip, channels: 1, sampleRate: OPUS_RATE, frameSize: FRAME_SAMPLES}),
      createDecoder({channels: 1, sampleRate: OPUS_RATE}),
    ]).catch(async (error) => { await peer.close().catch(() => undefined); throw error; });
    return new WhatsAppCallPeer({peer, transceiver, encoder, decoder, allowRemoteCandidate, ...input});
  }

  private readonly queue = new PcmQueue();
  private readonly reorder = new RtpReorderBuffer<RtpPacket>(4);
  private readonly tracks = new Set<string>();
  private state = "new";
  private connected = false;
  private closed = false;
  private connectionError?: Error;
  private sending = false;
  private codecsFreed = false;
  private inboundSsrc?: number;
  private sequence = randomInt(0x1_0000);
  private timestamp = randomInt(0x1_0000_0000);
  private timer?: NodeJS.Timeout;
  private flushTimer?: NodeJS.Timeout;
  private waiters = new Set<{resolve(): void; reject(error: Error): void}>();
  private receivedPackets = 0;
  private sentPackets = 0;
  private lossMarkers = 0;
  private decodeFailures = 0;
  private droppedOutputBytes = 0;
  private ssrcChanges = 0;
  private lastInboundAt?: number;
  private lastOutboundAt?: number;
  private inboundWindowAt = Date.now();
  private inboundWindowPackets = 0;
  private inboundWindowBytes = 0;
  private inboundRateFailed = false;

  private constructor(private readonly input: {peer: RTCPeerConnection; transceiver: RTCRtpTransceiver; encoder: OpusEncoderHandle; decoder: OpusDecoderHandle; allowRemoteCandidate: RemoteCandidatePolicy; onAudio(pcm24kMono: Buffer): void; onFailure(error: Error): void}) {
    input.peer.onTrack.subscribe((track) => this.attachTrack(track));
    input.peer.connectionStateChange.subscribe((state) => {
      if (this.closed) return;
      this.state = state;
      if (state === "connected") { this.connected = true; this.connectionError = undefined; this.settleWaiters(); }
      if (state === "disconnected") this.connected = false;
      if (state === "failed" || state === "closed") {
        this.connected = false;
        const error = new Error(`WhatsApp WebRTC connection ${state}.`);
        this.connectionError = error;
        this.settleWaiters(error); this.input.onFailure(error);
      }
    });
  }

  async answer(offerSdp: string, signal: AbortSignal): Promise<string> {
    validateWhatsAppOfferSdp(offerSdp, this.input.allowRemoteCandidate);
    await abortablePeerOperation(this.input.peer.setRemoteDescription({type: "offer", sdp: offerSdp}), signal);
    const answer = await abortablePeerOperation(this.input.peer.createAnswer(), signal);
    await abortablePeerOperation(this.input.peer.setLocalDescription(answer), signal);
    this.attachTrack(this.input.transceiver.receiver.track);
    const sdp = this.input.peer.localDescription?.sdp;
    if (!sdp?.trim()) throw new Error("WhatsApp peer produced no SDP answer.");
    return sdp;
  }

  waitUntilConnected(signal: AbortSignal): Promise<void> {
    if (this.connected) return Promise.resolve();
    if (this.connectionError) return Promise.reject(this.connectionError);
    if (this.closed) return Promise.reject(new Error("WhatsApp WebRTC connection is closed."));
    return new Promise((resolve, reject) => {
      const waiter = {resolve: () => { signal.removeEventListener("abort", onAbort); resolve(); }, reject: (error: Error) => { signal.removeEventListener("abort", onAbort); reject(error); }};
      const onAbort = () => { this.waiters.delete(waiter); waiter.reject(signal.reason instanceof Error ? signal.reason : new Error("WhatsApp WebRTC startup stopped.")); };
      this.waiters.add(waiter); signal.addEventListener("abort", onAbort, {once: true});
      if (signal.aborted) onAbort();
    });
  }

  startOutput(): void {
    if (this.closed) throw new Error("WhatsApp WebRTC connection is closed.");
    this.startPump();
  }

  pushPcm(audio: Buffer): number {
    if (this.closed) return 0;
    const dropped = this.queue.push(audio.subarray(0, audio.length - audio.length % 2));
    this.droppedOutputBytes += dropped;
    return dropped;
  }
  clearOutput(): void { this.queue.clear(); }

  snapshot(): WhatsAppCallPeerSnapshot {
    return {state: this.state, receivedPackets: this.receivedPackets, sentPackets: this.sentPackets, lossMarkers: this.lossMarkers, decodeFailures: this.decodeFailures, queuedMs: Math.round(this.queue.length / (RELAY_RATE * 2) * 1_000), droppedOutputMs: Math.round(this.droppedOutputBytes / (RELAY_RATE * 2) * 1_000), ssrcChanges: this.ssrcChanges, lastInboundAt: this.lastInboundAt ?? null, lastOutboundAt: this.lastOutboundAt ?? null};
  }

  close(): void {
    if (this.closed) return;
    this.closed = true; this.state = "closed"; this.connected = false;
    if (this.timer) clearInterval(this.timer); if (this.flushTimer) clearTimeout(this.flushTimer);
    this.settleWaiters(new Error("WhatsApp WebRTC connection is closed.")); this.queue.clear(); this.reorder.reset();
    if (!this.sending) this.freeCodecs();
    void this.input.peer.close().catch(() => undefined);
  }

  private attachTrack(track: MediaStreamTrack): void {
    if (track.kind !== "audio" || this.tracks.has(track.uuid)) return;
    this.tracks.add(track.uuid);
    track.onReceiveRtp.subscribe((packet) => {
      if (this.closed) return;
      const now = Date.now();
      this.lastInboundAt = now; this.receivedPackets += 1;
      if (!this.allowInboundPacket(packet.payload.length, now)) return;
      if (this.inboundSsrc !== undefined && this.inboundSsrc !== packet.header.ssrc) {
        this.ssrcChanges += 1;
        this.reorder.reset();
      }
      this.inboundSsrc = packet.header.ssrc;
      this.process(this.reorder.push(packet.header.sequenceNumber, packet));
      if (this.reorder.hasPending && !this.flushTimer) {
        this.flushTimer = setTimeout(() => { this.flushTimer = undefined; this.process(this.reorder.flush()); }, REORDER_FLUSH_MS);
        this.flushTimer.unref?.();
      }
    });
  }

  private allowInboundPacket(bytes: number, now: number): boolean {
    if (now - this.inboundWindowAt >= 1_000) {
      this.inboundWindowAt = now;
      this.inboundWindowPackets = 0;
      this.inboundWindowBytes = 0;
    }
    this.inboundWindowPackets += 1;
    this.inboundWindowBytes += bytes;
    const allowed = bytes <= MAX_INBOUND_PACKET_BYTES
      && this.inboundWindowPackets <= MAX_INBOUND_PACKETS_PER_SECOND
      && this.inboundWindowBytes <= MAX_INBOUND_BYTES_PER_SECOND;
    if (!allowed && !this.inboundRateFailed) {
      this.inboundRateFailed = true;
      this.input.onFailure(new Error("WhatsApp WebRTC inbound RTP exceeded the configured limit."));
    }
    return allowed;
  }

  private process(outputs: RtpReorderOutput<RtpPacket>[]): void {
    for (const output of outputs) {
      try {
        let decoded: Int16Array;
        if (output.kind === "loss") {
          this.lossMarkers += 1;
          decoded = this.input.decoder.decodePacketLoss(FRAME_SAMPLES);
        } else {
          try {
            decoded = this.input.decoder.decode(dePacketizeRtpPackets("opus", [output.packet]).data, {maxFrameSize: 5_760});
          } catch {
            this.decodeFailures += 1;
            decoded = this.input.decoder.decodePacketLoss(FRAME_SAMPLES);
          }
        }
        this.input.onAudio(samplesToPcm16le(resamplePcm16(decoded, OPUS_RATE, RELAY_RATE)));
      } catch (error) { this.decodeFailures += 1; this.input.onFailure(error instanceof Error ? error : new Error(String(error))); }
    }
  }

  private startPump(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.sendFrame(); }, FRAME_MS); this.timer.unref?.();
  }

  private async sendFrame(): Promise<void> {
    if (!this.connected || this.closed || this.sending) return;
    this.sending = true;
    try {
      const pcm24 = this.queue.shift(FRAME_BYTES);
      const pcm48 = resamplePcm16(pcm16leToSamples(pcm24), RELAY_RATE, OPUS_RATE);
      const encoded = this.input.encoder.encode(pcm48, {frameSize: FRAME_SAMPLES});
      const payloadType = this.input.transceiver.getPayloadType("audio/opus") ?? this.input.transceiver.sender.codec?.payloadType ?? 111;
      const packet = new RtpPacket(new RtpHeader({payloadType, sequenceNumber: this.sequence, timestamp: this.timestamp, ssrc: this.input.transceiver.sender.ssrc}), Buffer.from(encoded));
      this.sequence = (this.sequence + 1) & 0xffff; this.timestamp = (this.timestamp + FRAME_SAMPLES) >>> 0;
      await this.input.transceiver.sender.sendRtp(packet); this.sentPackets += 1; this.lastOutboundAt = Date.now();
    } catch (error) { if (!this.closed) this.input.onFailure(error instanceof Error ? error : new Error(String(error))); }
    finally {
      this.sending = false;
      if (this.closed) this.freeCodecs();
    }
  }

  private freeCodecs(): void {
    if (this.codecsFreed) return;
    this.codecsFreed = true;
    this.input.encoder.free(); this.input.decoder.free();
  }

  private settleWaiters(error?: Error): void {
    for (const waiter of this.waiters) error ? waiter.reject(error) : waiter.resolve();
    this.waiters.clear();
  }
}
