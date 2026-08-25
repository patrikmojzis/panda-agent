import {EventEmitter} from "node:events";

import {describe, expect, it, vi} from "vitest";
import WebSocket from "ws";

import {OpenAILiveRealtimeVoiceBridge} from "../src/integrations/providers/openai-live/bridge.js";
import {OpenAILiveRtpReorderBuffer} from "../src/integrations/providers/openai-live/peer.js";
import {resamplePcm16} from "../src/integrations/voice/pcm.js";

function deferred(): {promise: Promise<void>; resolve(): void} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return {promise, resolve};
}

class FakeSocket extends EventEmitter {
  readyState = WebSocket.CONNECTING;
  readonly sent: string[] = [];
  send(value: string, callback?: (error?: Error) => void): void { this.sent.push(value); callback?.(); }
  close(): void { this.readyState = WebSocket.CLOSED; }
}

describe("OpenAI GPT-Live bridge", () => {
  it("waits for sideband and WebRTC, then applies provider-authoritative output clearing", async () => {
    const mediaReady = deferred();
    const socket = new FakeSocket();
    const waitUntilConnected = vi.fn(async () => mediaReady.promise);
    const discardPendingOutput = vi.fn();
    const onOutputAudioCleared = vi.fn();
    const onFailure = vi.fn();
    const bridge = new OpenAILiveRealtimeVoiceBridge({
      onAudio: vi.fn(), onDelegation: vi.fn(), onOutputAudioCleared, onFailure, log: vi.fn(),
      resolveAuth: () => ({token: "secret", accountId: "acct-1"}),
      fetchImpl: vi.fn(async () => new Response("answer-sdp", {status: 201, headers: {Location: "/v1/live/rtc_test"}})),
      createPeer: vi.fn(async () => ({createOffer: async () => "offer-sdp", applyAnswer: async () => undefined, waitUntilConnected, sendAudio: vi.fn(), discardPendingOutput, close: vi.fn()})),
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

    socket.emit("message", Buffer.from(JSON.stringify({type: "output_audio_buffer.cleared"})), false);
    expect(onOutputAudioCleared).toHaveBeenCalledOnce();
    expect(discardPendingOutput).toHaveBeenCalledOnce();
    expect(socket.sent).toEqual([]);
    bridge.close();
    expect(socket.sent).toEqual([JSON.stringify({type: "session.close"})]);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("retains sideband events emitted immediately after open", async () => {
    const socket = new FakeSocket();
    const onDelegation = vi.fn();
    const bridge = new OpenAILiveRealtimeVoiceBridge({
      onAudio: vi.fn(), onDelegation, onOutputAudioCleared: vi.fn(), onFailure: vi.fn(), log: vi.fn(),
      resolveAuth: () => ({token: "secret", accountId: "acct-1"}),
      fetchImpl: vi.fn(async () => new Response("answer-sdp", {status: 201, headers: {Location: "/v1/live/rtc_test"}})),
      createPeer: vi.fn(async () => ({createOffer: async () => "offer-sdp", applyAnswer: async () => undefined, waitUntilConnected: async () => undefined, sendAudio: vi.fn(), close: vi.fn()})),
      createSocket: () => {
        queueMicrotask(() => {
          socket.readyState = WebSocket.OPEN;
          socket.emit("open");
          const delegation = Buffer.from(JSON.stringify({type: "delegation.created", item: {type: "delegation", target: "client", id: "delegation-1", content: [{type: "input_text", text: "check status"}]}}));
          socket.emit("message", delegation, false);
          socket.emit("message", delegation, false);
        });
        return socket as unknown as WebSocket;
      },
    });

    await bridge.connect();
    expect(onDelegation).toHaveBeenCalledOnce();
    expect(onDelegation).toHaveBeenCalledWith({id: "delegation-1", prompt: "check status"});
    await expect(bridge.appendDelegationContext("delegation-1", "still checking", "commentary")).resolves.toBe(true);
    await expect(bridge.appendDelegationContext("delegation-1", "healthy", "speakable")).resolves.toBe(true);
    await expect(bridge.appendDelegationContext("delegation-1", "duplicate", "speakable")).resolves.toBe(false);
    expect(socket.sent.slice(-2).map((message) => JSON.parse(message))).toEqual([
      expect.objectContaining({type: "delegation.context.append", delegation_item_id: "delegation-1", channel: "commentary"}),
      expect.objectContaining({type: "delegation.context.append", delegation_item_id: "delegation-1", channel: "speakable"}),
    ]);
    await expect(bridge.appendSessionContext("proactive update", "speakable")).resolves.toBe(true);
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({type: "session.context.append", channel: "speakable"});
    bridge.close();
  });

  it("reattaches the sideband to the same call and preserves a pending delegation", async () => {
    const first = new FakeSocket();
    const second = new FakeSocket();
    const sockets = [first, second];
    const closePeer = vi.fn();
    const onFailure = vi.fn();
    const resolveAuth = vi.fn()
      .mockReturnValueOnce({token: "secret-1", accountId: "acct-1"})
      .mockReturnValueOnce({token: "secret-2", accountId: "acct-1"});
    const createSocket = vi.fn((url: string) => {
      expect(url).toContain("/v1/live/rtc_test");
      const socket = sockets.shift();
      if (!socket) throw new Error("unexpected socket");
      queueMicrotask(() => {
        socket.readyState = WebSocket.OPEN;
        socket.emit("open");
      });
      return socket as unknown as WebSocket;
    });
    const bridge = new OpenAILiveRealtimeVoiceBridge({
      onAudio: vi.fn(), onDelegation: vi.fn(), onOutputAudioCleared: vi.fn(), onFailure, log: vi.fn(),
      resolveAuth,
      fetchImpl: vi.fn(async () => new Response("answer-sdp", {status: 201, headers: {Location: "/v1/live/rtc_test"}})),
      createPeer: vi.fn(async () => ({
        createOffer: async () => "offer-sdp", applyAnswer: async () => undefined,
        waitUntilConnected: async () => undefined, sendAudio: vi.fn(), close: closePeer,
      })),
      createSocket,
    });

    await bridge.connect();
    first.emit("message", Buffer.from(JSON.stringify({
      type: "delegation.created",
      item: {type: "delegation", target: "client", id: "delegation-1", content: [{type: "input_text", text: "check status"}]},
    })), false);
    first.readyState = WebSocket.CLOSED;
    first.emit("close", 1006, Buffer.alloc(0));

    await expect(bridge.appendDelegationContext("delegation-1", "Recovered answer.", "speakable")).resolves.toBe(true);
    expect(JSON.parse(second.sent.at(-1)!)).toMatchObject({
      type: "delegation.context.append",
      delegation_item_id: "delegation-1",
      channel: "speakable",
    });
    expect(createSocket).toHaveBeenCalledTimes(2);
    expect(resolveAuth).toHaveBeenCalledTimes(2);
    expect(closePeer).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
    bridge.close();
  });

  it("retries the exact sideband frame when the WebSocket send callback fails", async () => {
    vi.useFakeTimers();
    const first = new FakeSocket();
    const second = new FakeSocket();
    const sockets = [first, second];
    first.send = (value: string, callback?: (error?: Error) => void) => {
      first.sent.push(value);
      callback?.(new Error("write failed"));
    };
    const bridge = new OpenAILiveRealtimeVoiceBridge({
      onAudio: vi.fn(), onDelegation: vi.fn(), onOutputAudioCleared: vi.fn(), onFailure: vi.fn(), log: vi.fn(),
      resolveAuth: () => ({token: "secret", accountId: "acct-1"}),
      fetchImpl: vi.fn(async () => new Response("answer-sdp", {status: 201, headers: {Location: "/v1/live/rtc_test"}})),
      createPeer: vi.fn(async () => ({
        createOffer: async () => "offer-sdp", applyAnswer: async () => undefined,
        waitUntilConnected: async () => undefined, sendAudio: vi.fn(), close: vi.fn(),
      })),
      createSocket: () => {
        const socket = sockets.shift();
        if (!socket) throw new Error("unexpected socket");
        queueMicrotask(() => {
          socket.readyState = WebSocket.OPEN;
          socket.emit("open");
        });
        return socket as unknown as WebSocket;
      },
    });

    await bridge.connect();
    const appending = bridge.appendSessionContext("deliver once", "speakable");
    await vi.advanceTimersByTimeAsync(200);
    await expect(appending).resolves.toBe(true);
    expect(first.sent).toHaveLength(1);
    expect(second.sent).toEqual(first.sent);
    bridge.close();
  });

  it("bounds a sideband reconnect whose socket never opens", async () => {
    vi.useFakeTimers();
    const first = new FakeSocket();
    const stalled = Array.from({length: 8}, () => new FakeSocket());
    const sockets = [first, ...stalled];
    const onFailure = vi.fn();
    const bridge = new OpenAILiveRealtimeVoiceBridge({
      connectTimeoutMs: 5,
      onAudio: vi.fn(), onDelegation: vi.fn(), onOutputAudioCleared: vi.fn(), onFailure, log: vi.fn(),
      resolveAuth: () => ({token: "secret", accountId: "acct-1"}),
      fetchImpl: vi.fn(async () => new Response("answer-sdp", {status: 201, headers: {Location: "/v1/live/rtc_test"}})),
      createPeer: vi.fn(async () => ({
        createOffer: async () => "offer-sdp", applyAnswer: async () => undefined,
        waitUntilConnected: async () => undefined, sendAudio: vi.fn(), close: vi.fn(),
      })),
      createSocket: () => {
        const socket = sockets.shift();
        if (!socket) throw new Error("unexpected socket");
        if (socket === first) queueMicrotask(() => { socket.readyState = WebSocket.OPEN; socket.emit("open"); });
        return socket as unknown as WebSocket;
      },
    });

    await bridge.connect();
    first.readyState = WebSocket.CLOSED;
    first.emit("close", 1006, Buffer.alloc(0));
    await vi.advanceTimersByTimeAsync(30_000);

    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({source: "sideband", code: "transport_failed", retryable: true}));
    expect(sockets).toHaveLength(0);
  });

  it("treats an ended call during sideband reattachment as terminal session expiry", async () => {
    const first = new FakeSocket();
    const second = new FakeSocket();
    const sockets = [first, second];
    const onFailure = vi.fn();
    const closePeer = vi.fn();
    const bridge = new OpenAILiveRealtimeVoiceBridge({
      onAudio: vi.fn(), onDelegation: vi.fn(), onOutputAudioCleared: vi.fn(), onFailure, log: vi.fn(),
      resolveAuth: () => ({token: "secret", accountId: "acct-1"}),
      fetchImpl: vi.fn(async () => new Response("answer-sdp", {status: 201, headers: {Location: "/v1/live/rtc_test"}})),
      createPeer: vi.fn(async () => ({
        createOffer: async () => "offer-sdp", applyAnswer: async () => undefined,
        waitUntilConnected: async () => undefined, sendAudio: vi.fn(), close: closePeer,
      })),
      createSocket: () => {
        const socket = sockets.shift();
        if (!socket) throw new Error("unexpected socket");
        queueMicrotask(() => {
          if (socket === first) {
            socket.readyState = WebSocket.OPEN;
            socket.emit("open");
          } else {
            socket.emit("unexpected-response", {}, {statusCode: 410});
          }
        });
        return socket as unknown as WebSocket;
      },
    });

    await bridge.connect();
    first.readyState = WebSocket.CLOSED;
    first.emit("close", 1006, Buffer.alloc(0));

    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({
      source: "session",
      code: "session_expired",
      retryable: false,
      status: 410,
    })));
    expect(closePeer).toHaveBeenCalledOnce();
  });

  it("forwards completed turn text only through the transient callback without logging it", async () => {
    const socket = new FakeSocket();
    const onTurnDone = vi.fn();
    const log = vi.fn();
    const bridge = new OpenAILiveRealtimeVoiceBridge({
      onAudio: vi.fn(), onDelegation: vi.fn(), onOutputAudioCleared: vi.fn(), onFailure: vi.fn(), onTurnDone, log,
      resolveAuth: () => ({token: "secret", accountId: "acct-1"}),
      fetchImpl: vi.fn(async () => new Response("answer-sdp", {status: 201, headers: {Location: "/v1/live/rtc_test"}})),
      createPeer: vi.fn(async () => ({createOffer: async () => "offer-sdp", applyAnswer: async () => undefined, waitUntilConnected: async () => undefined, sendAudio: vi.fn(), close: vi.fn()})),
      createSocket: () => {
        queueMicrotask(() => {
          socket.readyState = WebSocket.OPEN;
          socket.emit("open");
          socket.emit("message", Buffer.from(JSON.stringify({type: "turn.done", turn: {role: "assistant", transcript: "private casual answer"}})), false);
        });
        return socket as unknown as WebSocket;
      },
    });

    await bridge.connect();
    expect(onTurnDone).toHaveBeenCalledWith({role: "assistant", transcript: "private casual answer"});
    expect(JSON.stringify(log.mock.calls)).not.toContain("private casual answer");
    bridge.close();
  });

  it("rolls back when an opened sideband closes before media is ready", async () => {
    const mediaReady = deferred();
    const socket = new FakeSocket();
    const closePeer = vi.fn();
    const bridge = new OpenAILiveRealtimeVoiceBridge({
      onAudio: vi.fn(), onDelegation: vi.fn(), onOutputAudioCleared: vi.fn(), onFailure: vi.fn(), log: vi.fn(),
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

  it("enforces the overall startup timeout across unabortable peer operations", async () => {
    const closePeer = vi.fn();
    const bridge = new OpenAILiveRealtimeVoiceBridge({
      connectTimeoutMs: 5,
      onAudio: vi.fn(), onDelegation: vi.fn(), onOutputAudioCleared: vi.fn(), onFailure: vi.fn(), log: vi.fn(),
      createPeer: vi.fn(async () => ({
        createOffer: () => new Promise<string>(() => undefined),
        applyAnswer: async () => undefined, waitUntilConnected: async () => undefined, sendAudio: vi.fn(), close: closePeer,
      })),
    });

    await expect(bridge.connect()).rejects.toThrow(/timeout|aborted/i);
    expect(closePeer).toHaveBeenCalledOnce();
  });

  it("closes a peer that resolves after startup already timed out", async () => {
    const closePeer = vi.fn();
    let resolvePeer!: (peer: {
      createOffer(): Promise<string>;
      applyAnswer(): Promise<void>;
      waitUntilConnected(): Promise<void>;
      sendAudio(): void;
      close(): void;
    }) => void;
    const bridge = new OpenAILiveRealtimeVoiceBridge({
      connectTimeoutMs: 5,
      onAudio: vi.fn(), onDelegation: vi.fn(), onOutputAudioCleared: vi.fn(), onFailure: vi.fn(), log: vi.fn(),
      createPeer: vi.fn(() => new Promise((resolve) => { resolvePeer = resolve; })),
    });

    await expect(bridge.connect()).rejects.toThrow(/timeout|aborted/i);
    resolvePeer({
      createOffer: async () => "offer-sdp", applyAnswer: async () => undefined,
      waitUntilConnected: async () => undefined, sendAudio: vi.fn(), close: closePeer,
    });
    await vi.waitFor(() => expect(closePeer).toHaveBeenCalledOnce());
  });

  it("honors an external room cancellation during startup without reporting provider failure", async () => {
    const onFailure = vi.fn();
    const controller = new AbortController();
    const bridge = new OpenAILiveRealtimeVoiceBridge({
      onAudio: vi.fn(), onDelegation: vi.fn(), onOutputAudioCleared: vi.fn(), onFailure, log: vi.fn(),
      createPeer: vi.fn(() => new Promise(() => undefined)),
    });

    const connecting = bridge.connect(controller.signal);
    controller.abort(new Error("room closed"));
    await expect(connecting).rejects.toThrow("room closed");
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("reports the failing transport without exposing bearer credentials", async () => {
    const socket = new FakeSocket();
    const log = vi.fn();
    const onFailure = vi.fn();
    let failMedia!: (error: Error) => void;
    const bridge = new OpenAILiveRealtimeVoiceBridge({
      onAudio: vi.fn(), onDelegation: vi.fn(), onOutputAudioCleared: vi.fn(), onFailure, log,
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
    failMedia(new Error("duplicate failure"));

    expect(log).toHaveBeenCalledWith("gpt_live_failed", {failureSource: "media", message: "Discord output failed with Bearer [redacted]"});
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({source: "media", code: "transport_failed", retryable: true}));
    expect(onFailure).toHaveBeenCalledOnce();
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

    const cleared = new OpenAILiveRtpReorderBuffer<string>();
    expect(cleared.push(30, "played")).toEqual([{kind: "packet", packet: "played"}]);
    expect(cleared.push(32, "queued-old")).toEqual([]);
    cleared.discardPending();
    expect(cleared.push(31, "late-old")).toEqual([]);
    expect(cleared.push(32, "late-queued-old")).toEqual([]);
    expect(cleared.push(33, "new")).toEqual([{kind: "packet", packet: "new"}]);

    const quarantined = new OpenAILiveRtpReorderBuffer<string>();
    expect(quarantined.push(40, "played", 1_000)).toEqual([{kind: "packet", packet: "played"}]);
    quarantined.discardPending(1_010, 200);
    expect(quarantined.push(41, "unseen-late-old", 1_100)).toEqual([]);
    expect(quarantined.push(42, "another-late-old", 1_150)).toEqual([]);
    expect(quarantined.push(41, "late-duplicate", 1_220)).toEqual([]);
    expect(quarantined.push(43, "new", 1_220)).toEqual([{kind: "packet", packet: "new"}]);

    const wrapped = new OpenAILiveRtpReorderBuffer<string>();
    expect(wrapped.push(65_535, "last")).toHaveLength(1);
    expect(wrapped.push(0, "first")).toEqual([{kind: "packet", packet: "first"}]);
    expect(resamplePcm16(new Int16Array(), 48_000, 24_000)).toHaveLength(0);
  });
});
