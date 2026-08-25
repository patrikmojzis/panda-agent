import {describe, expect, it} from "vitest";

import {OpenAILiveRealtimeVoiceBridge} from "../../src/integrations/providers/openai-live/bridge.js";

const describeLive = process.env.PANDA_DISCORD_VOICE_LIVE_TEST === "true" ? describe : describe.skip;

describeLive("experimental GPT-Live ChatGPT backend", () => {
  it("connects media and sideband without codex app-server", async () => {
    const closeReasons: string[] = [];
    const bridge = new OpenAILiveRealtimeVoiceBridge({
      voice: "cove",
      onAudio: () => undefined,
      onDelegation: () => undefined,
      onOutputAudioCleared: () => undefined,
      onFailure: (failure) => closeReasons.push(failure.code),
      log: () => undefined,
    });

    try {
      await bridge.connect();
    } finally {
      bridge.close();
    }

    expect(closeReasons).toEqual([]);
  });
});
