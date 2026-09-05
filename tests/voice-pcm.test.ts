import {describe, expect, it} from "vitest";

import {hasAudiblePcm16, pcm16leToSamples, resamplePcm16, samplesToPcm16le} from "../src/integrations/voice/pcm.js";

describe("live voice PCM", () => {
  it("decodes signed little-endian samples from a byte view and ignores an incomplete sample", () => {
    const bytes = Buffer.from([99, 0, 128, 255, 255, 0, 0, 52, 18, 255, 127, 88, 99]);
    const input = bytes.subarray(1, -1);
    const samples = pcm16leToSamples(input);
    expect([...samples]).toEqual([-32768, -1, 0, 4660, 32767]);
    input.fill(0);
    expect([...samples]).toEqual([-32768, -1, 0, 4660, 32767]);
    samples.fill(1);
    expect([...input]).toEqual(Array(11).fill(0));
    expect(pcm16leToSamples(Buffer.alloc(0))).toHaveLength(0);
  });

  it("encodes a signed sample view into independent little-endian bytes", () => {
    const backing = Int16Array.from([99, -32768, -1, 0, 4660, 32767, 99]);
    const input = backing.subarray(1, -1);
    const bytes = samplesToPcm16le(input);
    expect([...bytes]).toEqual([0, 128, 255, 255, 0, 0, 52, 18, 255, 127]);
    input.fill(0);
    expect([...bytes]).toEqual([0, 128, 255, 255, 0, 0, 52, 18, 255, 127]);
    bytes.fill(1);
    expect([...input]).toEqual([0, 0, 0, 0, 0]);
    expect(samplesToPcm16le(new Int16Array())).toHaveLength(0);
  });

  it("distinguishes bounded signal from digital silence", () => {
    expect(hasAudiblePcm16(Buffer.alloc(960))).toBe(false);
    const quiet = Buffer.alloc(960);
    quiet.writeInt16LE(8, 100);
    expect(hasAudiblePcm16(quiet)).toBe(false);
    quiet.writeInt16LE(-9, 100);
    expect(hasAudiblePcm16(quiet)).toBe(true);
  });

  it("resamples without aliasing the caller's sample storage", () => {
    const input = Int16Array.from([0, 1_000, 2_000, 3_000]);
    const copied = resamplePcm16(input, 24_000, 24_000);
    expect(copied).toEqual(input);
    expect(copied).not.toBe(input);
    expect(resamplePcm16(input, 24_000, 48_000)).toHaveLength(8);
  });
});
