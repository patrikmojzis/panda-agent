import {describe, expect, it} from "vitest";

import {deriveLiveVoiceHealth} from "../src/integrations/voice/health.js";
import {discordVoiceTransportDiagnostics} from "../src/integrations/channels/discord/voice-transport-health.js";

describe("live voice diagnostics", () => {
  it("derives generic health without leaking Discord concepts", () => {
    expect(deriveLiveVoiceHealth({connecting: false, closing: false, transportReady: true, providerState: "connected", audioDropped: false, playbackFailed: false}))
      .toEqual({state: "ready", reasons: []});
    expect(deriveLiveVoiceHealth({connecting: false, closing: false, transportReady: false, providerState: "connected", audioDropped: false, playbackFailed: false}))
      .toEqual({state: "recovering", reasons: ["transport_not_ready"]});
    expect(deriveLiveVoiceHealth({connecting: false, closing: false, transportReady: true, providerState: "recovering", listenerStatus: "reconnecting", poolWaiting: 1, audioDropped: true, playbackFailed: false}))
      .toEqual({state: "recovering", reasons: ["provider_recovering", "notification_listener_reconnecting", "postgres_pool_waiting", "audio_dropped"]});
    expect(deriveLiveVoiceHealth({connecting: false, closing: false, transportReady: true, providerState: "connected", audioDropped: false, playbackFailed: true}))
      .toEqual({state: "error", reasons: ["playback_failed"]});
  });

  it("keeps Gateway and Discord voice facts inside transport diagnostics", () => {
    expect(discordVoiceTransportDiagnostics({
      connectionState: "ready",
      playerState: "idle",
      playback: {providerSilenceDroppedMs: 100},
      stateAt: 10,
      gateway: {state: "ready", readyAt: 1, sequence: 2, lastHeartbeatSentAt: 3, lastHeartbeatAckAt: 4, heartbeatAckAgeMs: 5, reconnectCount: 0},
    })).toEqual({
      gateway: {state: "ready", readyAt: 1, sequence: 2, lastHeartbeatSentAt: 3, lastHeartbeatAckAt: 4, heartbeatAckAgeMs: 5, reconnectCount: 0},
      voice: {state: "ready", stateAt: 10, dave: "unknown"},
      player: {state: "idle", providerSilenceDroppedMs: 100},
    });
  });
});
