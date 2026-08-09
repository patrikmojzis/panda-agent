import {describe, expect, it} from "vitest";

import {hasAudiblePcm16, resamplePcm16} from "../src/integrations/voice/pcm.js";

describe("live voice PCM", () => {
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
