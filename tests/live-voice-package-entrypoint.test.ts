import {describe, expect, it} from "vitest";

import {
  LiveVoiceCall,
  hasAudiblePcm16,
} from "../src/integrations/live-voice/index.js";
import {
  DEFAULT_OPENAI_LIVE_VOICE,
  OPENAI_LIVE_VOICE_CATALOG,
  OPENAI_LIVE_VOICES,
  createOpenAILiveVoiceProvider,
  parseOpenAILiveVoice,
} from "../src/integrations/openai-live/index.js";

describe("live voice package entrypoint", () => {
  it("exposes the supported call, provider, and PCM surface", () => {
    expect(LiveVoiceCall).toBeTypeOf("function");
    expect(createOpenAILiveVoiceProvider).toBeTypeOf("function");
    expect(OPENAI_LIVE_VOICES).toEqual(["juniper", "maple", "spruce", "ember", "vale", "breeze", "arbor", "sol", "cove"]);
    expect(DEFAULT_OPENAI_LIVE_VOICE).toBe("cove");
    expect(OPENAI_LIVE_VOICE_CATALOG).toMatchObject({
      provider: "openai-live",
      model: "gpt-live-1-codex",
      sourceVersion: expect.stringContaining("2c4a95736bea64256a50f7b8506bd33c181cc85a"),
    });
    expect(parseOpenAILiveVoice(" JUNIPER ")).toBe("juniper");
    expect(hasAudiblePcm16(Buffer.alloc(960))).toBe(false);
  });
});
