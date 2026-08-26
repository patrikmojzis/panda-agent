import {describe, expect, it} from "vitest";

import {
  LiveVoiceCall,
  hasAudiblePcm16,
} from "../src/integrations/live-voice/index.js";
import {createOpenAILiveVoiceProvider} from "../src/integrations/openai-live/index.js";

describe("live voice package entrypoint", () => {
  it("exposes the supported call, provider, and PCM surface", () => {
    expect(LiveVoiceCall).toBeTypeOf("function");
    expect(createOpenAILiveVoiceProvider).toBeTypeOf("function");
    expect(hasAudiblePcm16(Buffer.alloc(960))).toBe(false);
  });
});
