import type {Readable} from "node:stream";

import {AudioPlayerStatus} from "@discordjs/voice";
import {afterEach, describe, expect, it, vi} from "vitest";

import {DiscordVoicePlayback} from "../src/integrations/channels/discord/discord-voice-playback.js";

function pcm(bytes: number): Buffer { return Buffer.alloc(bytes, 1); }

function harness(overrides: {prerollFrames?: number; endQuietMs?: number} = {}) {
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
    ...(overrides.prerollFrames === undefined ? {} : {prerollFrames: overrides.prerollFrames}),
    ...(overrides.endQuietMs === undefined ? {} : {endQuietMs: overrides.endQuietMs}),
  });
  return {playback, player, encoder, resource: () => resource};
}

afterEach(() => vi.useRealTimers());

describe("DiscordVoicePlayback", () => {
  it("preserves one object-mode stream object per encoded Opus packet", () => {
    const {playback, player, encoder, resource} = harness({prerollFrames: 2});
    playback.pushPcm(pcm(960 * 2));

    expect(encoder.encode).toHaveBeenCalledTimes(2);
    expect(player.play).toHaveBeenCalledOnce();
    const stream = resource()!.playStream;
    expect(stream.readableObjectMode).toBe(true);
    expect(stream.read()).toEqual(Buffer.from([1]));
    expect(stream.read()).toEqual(Buffer.from([2]));
  });

  it("never reuses an ended Discord audio resource", () => {
    const {playback, player, resource} = harness({prerollFrames: 2});
    playback.pushPcm(pcm(960 * 2));
    const first = resource()!.playStream;
    first.emit("close");
    playback.pushPcm(pcm(960 * 2));
    const second = resource()!.playStream;

    expect(player.play).toHaveBeenCalledTimes(2);
    expect(second).not.toBe(first);
  });

  it("starts late media on a fresh resource after the Discord player drains", () => {
    const {playback, player, resource} = harness({prerollFrames: 1});
    playback.pushPcm(pcm(960));
    const first = resource()!.playStream;
    player.state.status = AudioPlayerStatus.Idle;
    playback.handlePlayerIdle();

    playback.pushPcm(pcm(960));
    const second = resource()!.playStream;

    expect(first.destroyed).toBe(true);
    expect(player.play).toHaveBeenCalledTimes(2);
    expect(second).not.toBe(first);
  });

  it("carries arbitrary PCM chunk boundaries and pads one final partial frame", async () => {
    vi.useFakeTimers();
    const {playback, encoder, resource} = harness({prerollFrames: 99});
    playback.pushPcm(pcm(1));
    playback.pushPcm(pcm(958));
    expect(encoder.encode).not.toHaveBeenCalled();
    playback.pushPcm(pcm(2));
    expect(encoder.encode).toHaveBeenCalledOnce();
    expect(playback.getSnapshot().residualBytes).toBe(1);

    await vi.advanceTimersByTimeAsync(300);
    expect(encoder.encode).toHaveBeenCalledTimes(2);
    expect(playback.getSnapshot()).toMatchObject({state: "ending", residualBytes: 0});
    expect(resource()!.playStream.readableObjectMode).toBe(true);
  });

  it("never ends the writable resource when transcript completion precedes late RTP", async () => {
    vi.useFakeTimers();
    const {playback, encoder, resource} = harness({prerollFrames: 2});
    playback.pushPcm(pcm(960 * 2));
    await vi.advanceTimersByTimeAsync(300);
    expect(playback.getSnapshot().state).toBe("ending");
    expect(resource()!.playStream.readableEnded).toBe(false);
    playback.pushPcm(pcm(960));
    expect(encoder.encode).toHaveBeenCalledTimes(3);
    expect(playback.getSnapshot()).toMatchObject({state: "ending", responseEpoch: 1});
  });

  it("clears staged audio on barge-in and accepts the next authorized response", () => {
    const {playback, player, encoder} = harness({prerollFrames: 2});
    playback.pushPcm(pcm(960 * 2));
    playback.interrupt();
    expect(player.stop).toHaveBeenCalledWith(true);
    playback.pushPcm(pcm(960 * 2));
    expect(encoder.encode).toHaveBeenCalledTimes(4);
    expect(playback.getSnapshot()).toMatchObject({state: "streaming", responseEpoch: 2, interrupts: 1});
  });

  it("bounds an overrun and starts the next response with a fresh resource", () => {
    const {playback, player, resource} = harness({prerollFrames: 1});
    playback.pushPcm(pcm(960));
    const first = resource()!.playStream;

    playback.pushPcm(pcm(960 * 252));
    expect(playback.getSnapshot()).toMatchObject({state: "idle", queuedPackets: 0, overruns: 1});
    expect(player.stop).toHaveBeenCalledWith(true);

    playback.pushPcm(pcm(960));
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

  it("does not activate Discord playback for leading digital silence", () => {
    const {playback, player, encoder} = harness({prerollFrames: 1});
    playback.pushPcm(Buffer.alloc(960 * 3));
    expect(player.play).not.toHaveBeenCalled();
    expect(encoder.encode).not.toHaveBeenCalled();
    expect(playback.getSnapshot()).toMatchObject({state: "idle", silentLeadingChunks: 1});
  });

  it("does not create an empty speaking resource when media has already drained", async () => {
    vi.useFakeTimers();
    const {playback, player} = harness({prerollFrames: 1});
    playback.pushPcm(pcm(960));
    expect(player.play).toHaveBeenCalledOnce();
    player.state.status = AudioPlayerStatus.Idle;
    playback.handlePlayerIdle();
    await vi.advanceTimersByTimeAsync(300);
    expect(player.play).toHaveBeenCalledOnce();
    expect(playback.getSnapshot().state).toBe("idle");
  });
});
