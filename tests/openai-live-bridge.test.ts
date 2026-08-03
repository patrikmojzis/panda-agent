import {EventEmitter} from "node:events";

import {describe, expect, it, vi} from "vitest";
import WebSocket from "ws";

import {OpenAILiveRealtimeVoiceBridge} from "../src/integrations/providers/openai-live/bridge.js";
import {OpenAILiveRtpReorderBuffer} from "../src/integrations/providers/openai-live/peer.js";

function deferred(): {promise: Promise<void>; resolve(): void} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return {promise, resolve};
}

class FakeSocket extends EventEmitter {
  readyState = WebSocket.CONNECTING;
  readonly sent: string[] = [];
  send(value: string): void { this.sent.push(value); }
  close(): void { this.readyState = WebSocket.CLOSED; }
}

describe("OpenAI GPT-Live bridge", () => {
  it("waits for sideband and WebRTC without requiring session.started, then clears local playback on barge-in", async () => {
    const mediaReady = deferred();
    const socket = new FakeSocket();
    const waitUntilConnected = vi.fn(async () => mediaReady.promise);
    const onClearAudio = vi.fn();
    const bridge = new OpenAILiveRealtimeVoiceBridge({
      onAudio: vi.fn(), onDelegation: vi.fn(), onClearAudio, onClose: vi.fn(), log: vi.fn(),
      resolveAuth: () => ({token: "secret", accountId: "acct-1"}),
      fetchImpl: vi.fn(async () => new Response("answer-sdp", {status: 201, headers: {Location: "/v1/live/rtc_test"}})),
      createPeer: vi.fn(async () => ({createOffer: async () => "offer-sdp", applyAnswer: async () => undefined, waitUntilConnected, sendAudio: vi.fn(), close: vi.fn()})),
      createSocket: () => {
        queueMicrotask(() => {
          socket.readyState = WebSocket.OPEN;
          socket.emit("open");
        });
        return socket as unknown as WebSocket;
      },
    });

    let connected = false;
    const connecting = bridge.connect().then(() => { connected = true; });
    await vi.waitFor(() => expect(waitUntilConnected).toHaveBeenCalled());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(connected).toBe(false);
    mediaReady.resolve();
    await connecting;

    socket.emit("message", Buffer.from(JSON.stringify({type: "response.output_item.added", item: {id: "item-1", type: "message", role: "assistant"}})), false);
    bridge.noteAudioPlayed(40);
    bridge.interrupt();
    expect(onClearAudio).toHaveBeenCalledOnce();
    expect(socket.sent).toEqual([]);
    bridge.close();
  });

  it("rolls back when an opened sideband closes before media is ready", async () => {
    const mediaReady = deferred();
    const socket = new FakeSocket();
    const closePeer = vi.fn();
    const bridge = new OpenAILiveRealtimeVoiceBridge({
      onAudio: vi.fn(), onDelegation: vi.fn(), onClearAudio: vi.fn(), onClose: vi.fn(), log: vi.fn(),
      resolveAuth: () => ({token: "secret", accountId: "acct-1"}),
      fetchImpl: vi.fn(async () => new Response("answer-sdp", {status: 201, headers: {Location: "/v1/live/rtc_test"}})),
      createPeer: vi.fn(async () => ({createOffer: async () => "offer-sdp", applyAnswer: async () => undefined, waitUntilConnected: async () => mediaReady.promise, sendAudio: vi.fn(), close: closePeer})),
      createSocket: () => {
        queueMicrotask(() => {
          socket.readyState = WebSocket.OPEN;
          socket.emit("open");
          queueMicrotask(() => socket.emit("close", 1006));
        });
        return socket as unknown as WebSocket;
      },
    });

    await expect(bridge.connect()).rejects.toThrow("sideband closed");
    expect(closePeer).toHaveBeenCalled();
  });

  it("reports the failing transport without exposing bearer credentials", async () => {
    const socket = new FakeSocket();
    const log = vi.fn();
    const onClose = vi.fn();
    let failMedia!: (error: Error) => void;
    const bridge = new OpenAILiveRealtimeVoiceBridge({
      onAudio: vi.fn(), onDelegation: vi.fn(), onClearAudio: vi.fn(), onClose, log,
      resolveAuth: () => ({token: "secret", accountId: "acct-1"}),
      fetchImpl: vi.fn(async () => new Response("answer-sdp", {status: 201, headers: {Location: "/v1/live/rtc_test"}})),
      createPeer: vi.fn(async (callbacks) => {
        failMedia = callbacks.onError;
        return {createOffer: async () => "offer-sdp", applyAnswer: async () => undefined, waitUntilConnected: async () => undefined, sendAudio: vi.fn(), close: vi.fn()};
      }),
      createSocket: () => {
        queueMicrotask(() => {
          socket.readyState = WebSocket.OPEN;
          socket.emit("open");
        });
        return socket as unknown as WebSocket;
      },
    });

    await bridge.connect();
    failMedia(new Error("Discord output failed with Bearer top-secret"));

    expect(log).toHaveBeenCalledWith("gpt_live_failed", {failureSource: "media", message: "Discord output failed with Bearer [redacted]"});
    expect(onClose).toHaveBeenCalledWith("provider_failed");
  });

  it("reorders packets, drops duplicates, handles wraparound, and emits bounded loss markers", () => {
    const reorder = new OpenAILiveRtpReorderBuffer<string>();
    expect(reorder.push(10, "a")).toEqual([{kind: "packet", packet: "a"}]);
    expect(reorder.push(12, "c")).toEqual([]);
    expect(reorder.push(11, "b")).toEqual([{kind: "packet", packet: "b"}, {kind: "packet", packet: "c"}]);
    expect(reorder.push(11, "duplicate")).toEqual([]);

    const loss = new OpenAILiveRtpReorderBuffer<string>();
    expect(loss.push(20, "a")).toEqual([{kind: "packet", packet: "a"}]);
    expect(loss.push(22, "c")).toEqual([]);
    expect(loss.flush()).toEqual([{kind: "loss"}, {kind: "packet", packet: "c"}]);

    const wrapped = new OpenAILiveRtpReorderBuffer<string>();
    expect(wrapped.push(65_535, "last")).toHaveLength(1);
    expect(wrapped.push(0, "first")).toEqual([{kind: "packet", packet: "first"}]);
  });
});
