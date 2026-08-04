import type {Readable} from "node:stream";

import {AudioPlayerStatus} from "@discordjs/voice";
import {afterEach, describe, expect, it, vi} from "vitest";

import {DiscordVoicePlayback} from "../src/integrations/channels/discord/discord-voice-playback.js";

function harness(overrides: {now?: () => number; quarantineMs?: number; prerollFrames?: number} = {}) {
  let resource: {playStream: Readable} | undefined;
  const player = {
    state: {status: AudioPlayerStatus.Idle},
    play: vi.fn((next: {playStream: Readable}) => { resource = next; player.state.status = AudioPlayerStatus.Playing; }),
    stop: vi.fn(() => { player.state.status = AudioPlayerStatus.Idle; return true; }),
  };
  let encoded = 0;
  const encoder = {
    encode: vi.fn(() => Uint8Array.from([++encoded])),
    free: vi.fn(),
  };
  const playback = new DiscordVoicePlayback({
    player: player as never,
    encoder: encoder as never,
    onError: (error) => { throw error; },
    ...(overrides.now ? {now: overrides.now} : {}),
    ...(overrides.quarantineMs === undefined ? {} : {interruptQuarantineMs: overrides.quarantineMs}),
    ...(overrides.prerollFrames === undefined ? {} : {prerollFrames: overrides.prerollFrames}),
  });
  return {playback, player, encoder, resource: () => resource};
}

afterEach(() => vi.useRealTimers());

describe("DiscordVoicePlayback", () => {
  it("preserves one object-mode stream object per encoded Opus packet", () => {
    const {playback, player, encoder, resource} = harness({prerollFrames: 2});
    playback.pushPcm(Buffer.alloc(960 * 2));

    expect(encoder.encode).toHaveBeenCalledTimes(2);
    expect(player.play).toHaveBeenCalledOnce();
    const stream = resource()!.playStream;
    expect(stream.readableObjectMode).toBe(true);
    expect(stream.read()).toEqual(Buffer.from([1]));
    expect(stream.read()).toEqual(Buffer.from([2]));
  });

  it("never reuses an ended Discord audio resource", () => {
    const {playback, player, resource} = harness({prerollFrames: 2});
    playback.pushPcm(Buffer.alloc(960 * 2));
    const first = resource()!.playStream;
    first.emit("end");
    playback.pushPcm(Buffer.alloc(960 * 2));
    const second = resource()!.playStream;

    expect(player.play).toHaveBeenCalledTimes(2);
    expect(second).not.toBe(first);
  });

  it("carries arbitrary PCM chunk boundaries and pads one final partial frame", async () => {
    vi.useFakeTimers();
    const {playback, encoder, resource} = harness({prerollFrames: 99});
    playback.pushPcm(Buffer.alloc(1));
    playback.pushPcm(Buffer.alloc(958));
    expect(encoder.encode).not.toHaveBeenCalled();
    playback.pushPcm(Buffer.alloc(2));
    expect(encoder.encode).toHaveBeenCalledOnce();
    expect(playback.getSnapshot().residualBytes).toBe(1);

    playback.finishResponse();
    await vi.advanceTimersByTimeAsync(80);
    expect(encoder.encode).toHaveBeenCalledTimes(2);
    expect(playback.getSnapshot()).toMatchObject({state: "ending", residualBytes: 0});
    expect(resource()!.playStream.readableObjectMode).toBe(true);
  });

  it("waits for quiet after turn.done so late RTP remains in the same response", async () => {
    vi.useFakeTimers();
    const {playback, encoder} = harness({prerollFrames: 2});
    playback.pushPcm(Buffer.alloc(960 * 2));
    playback.finishResponse();
    await vi.advanceTimersByTimeAsync(60);
    playback.pushPcm(Buffer.alloc(960));
    await vi.advanceTimersByTimeAsync(79);
    expect(playback.getSnapshot().state).toBe("ending");
    expect(encoder.encode).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(playback.getSnapshot().state).toBe("ending");
  });

  it("clears staged audio on barge-in and quarantines in-flight stale chunks", () => {
    let now = 1_000;
    const {playback, player, encoder} = harness({now: () => now, quarantineMs: 150, prerollFrames: 2});
    playback.pushPcm(Buffer.alloc(960 * 2));
    playback.interrupt();
    expect(player.stop).toHaveBeenCalledWith(true);
    playback.pushPcm(Buffer.alloc(960));
    expect(playback.getSnapshot()).toMatchObject({state: "idle", quarantinedChunks: 1});
    now += 150;
    playback.pushPcm(Buffer.alloc(960));
    expect(encoder.encode).toHaveBeenCalledTimes(3);
    expect(playback.getSnapshot()).toMatchObject({state: "preroll", responseEpoch: 2});
  });

  it("bounds an overrun and starts the next response with a fresh resource", () => {
    const {playback, player, resource} = harness({prerollFrames: 1});
    playback.pushPcm(Buffer.alloc(960));
    const first = resource()!.playStream;

    playback.pushPcm(Buffer.alloc(960 * 252));
    expect(playback.getSnapshot()).toMatchObject({state: "idle", queuedPackets: 0, overruns: 1});
    expect(player.stop).toHaveBeenCalledWith(true);

    playback.pushPcm(Buffer.alloc(960));
    const second = resource()!.playStream;
    expect(player.play).toHaveBeenCalledTimes(2);
    expect(second).not.toBe(first);
  });

  it("closes idempotently and frees the Opus encoder once", () => {
    const {playback, encoder} = harness();
    playback.close();
    playback.close();
    expect(encoder.free).toHaveBeenCalledOnce();
    expect(playback.getSnapshot().state).toBe("closed");
  });
});
