import {describe, expect, it} from "vitest";

import {deriveDiscordVoiceHealth} from "../src/integrations/channels/discord/voice-health.js";

describe("Discord voice health", () => {
  it("reports a fully ready room only when all known transports are healthy", () => {
    expect(deriveDiscordVoiceHealth({
      connecting: false,
      closing: false,
      discordVoiceReady: true,
      gateway: {state: "ready", readyAt: 1, sequence: 2, lastHeartbeatSentAt: 3, lastHeartbeatAckAt: 4, heartbeatAckAgeMs: 10, reconnectCount: 0},
      providerState: "connected",
      listenerStatus: "listening",
      poolWaiting: 0,
      audioDropped: false,
      playbackFailed: false,
    })).toEqual({state: "ready", reasons: []});
  });

  it("distinguishes recoverable transport churn from degraded audio and terminal playback failure", () => {
    expect(deriveDiscordVoiceHealth({connecting: false, closing: false, discordVoiceReady: true, providerState: "recovering", listenerStatus: "reconnecting", audioDropped: false, playbackFailed: false}))
      .toEqual({state: "recovering", reasons: ["provider_recovering", "notification_listener_reconnecting"]});
    expect(deriveDiscordVoiceHealth({connecting: false, closing: false, discordVoiceReady: true, providerState: "connected", poolWaiting: 1, audioDropped: true, playbackFailed: false}))
      .toEqual({state: "degraded", reasons: ["postgres_pool_waiting", "audio_dropped"]});
    expect(deriveDiscordVoiceHealth({connecting: false, closing: false, discordVoiceReady: true, providerState: "connected", audioDropped: false, playbackFailed: true}))
      .toEqual({state: "error", reasons: ["playback_failed"]});
  });
});
