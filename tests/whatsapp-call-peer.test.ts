import {Application, createEncoder} from "libopus-wasm";
import {RTCPeerConnection, RtpHeader, RtpPacket, useOPUS} from "werift";
import {afterEach, describe, expect, it, vi} from "vitest";

import {isSafeWhatsAppIceAddress, validateWhatsAppOfferSdp, WhatsAppCallPeer} from "../src/integrations/channels/whatsapp/calls/peer.js";

describe("WhatsAppCallPeer", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => Promise.resolve(cleanup())));
  });

  it("negotiates a real Werift peer and exchanges Opus in both directions", async () => {
    const caller = new RTCPeerConnection({codecs: {audio: [useOPUS({payloadType: 109})], video: []}});
    cleanups.push(() => caller.close());
    const callerAudio = caller.addTransceiver("audio", {direction: "sendrecv"});
    const received: Buffer[] = [];
    const failures: Error[] = [];
    const panda = await WhatsAppCallPeer.create({
      onAudio: (pcm) => received.push(pcm),
      onFailure: (error) => failures.push(error),
      allowRemoteCandidate: () => true,
    });
    cleanups.push(() => panda.close());

    const offer = await caller.createOffer();
    await caller.setLocalDescription(offer);
    const answer = await panda.answer(caller.localDescription!.sdp, AbortSignal.timeout(5_000));
    await caller.setRemoteDescription({type: "answer", sdp: answer});
    await panda.waitUntilConnected(AbortSignal.timeout(5_000));
    panda.startOutput();

    const encoder = await createEncoder({application: Application.Voip, channels: 1, sampleRate: 48_000, frameSize: 960});
    cleanups.push(() => encoder.free());
    const samples = new Int16Array(960);
    for (let index = 0; index < samples.length; index += 1) samples[index] = Math.round(Math.sin(index / 12) * 4_000);
    const payloadType = callerAudio.getPayloadType("audio/opus") ?? 111;
    const opusPayload = Buffer.from(encoder.encode(samples, {frameSize: 960}));
    await callerAudio.sender.sendRtp(new RtpPacket(
      new RtpHeader({payloadType, sequenceNumber: 1, timestamp: 960, ssrc: callerAudio.sender.ssrc}),
      opusPayload,
    ));

    panda.pushPcm(Buffer.alloc(960, 1));
    await vi.waitFor(() => {
      expect(received.length).toBeGreaterThan(0);
      expect(panda.snapshot().sentPackets).toBeGreaterThan(0);
    }, {timeout: 5_000});
    expect(received[0]?.length).toBeGreaterThan(0);
    expect(failures).toEqual([]);

    await Promise.all(Array.from({length: 240}, (_, index) => callerAudio.sender.sendRtp(new RtpPacket(
      new RtpHeader({payloadType, sequenceNumber: index + 2, timestamp: (index + 2) * 960, ssrc: callerAudio.sender.ssrc}),
      opusPayload,
    ))));
    await vi.waitFor(() => expect(failures).toEqual([expect.objectContaining({message: "WhatsApp WebRTC inbound RTP exceeded the configured limit."})]));
  });

  it("allows only globally routable literal ICE addresses", () => {
    expect(isSafeWhatsAppIceAddress("157.240.1.1")).toBe(true);
    expect(isSafeWhatsAppIceAddress("2a03:2880:f003:c07:face:b00c::2")).toBe(true);
    for (const blocked of ["localhost", "127.0.0.1", "10.0.0.1", "100.64.0.1", "169.254.1.1", "224.0.0.1", "::1", "fc00::1", "fe80::1", "::ffff:10.0.0.1", "fe80::1%en0"]) {
      expect(isSafeWhatsAppIceAddress(blocked), blocked).toBe(false);
    }
  });

  it("rejects unsafe and excessive remote candidates before negotiation", () => {
    const offer = (host: string) => `v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=candidate:1 1 UDP 1 ${host} 3478 typ srflx\r\n`;
    expect(() => validateWhatsAppOfferSdp(offer("10.0.0.1"))).toThrow("unsafe ICE candidate");
    expect(() => validateWhatsAppOfferSdp(offer("media.example.com"))).toThrow("unsafe ICE candidate");
    expect(() => validateWhatsAppOfferSdp(offer("157.240.1.1"))).not.toThrow();
    expect(() => validateWhatsAppOfferSdp(`v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n${Array.from({length: 33}, (_, index) => `a=candidate:${index} 1 UDP 1 157.240.1.1 3478 typ relay`).join("\r\n")}`)).toThrow("too many ICE candidates");
  });
});
