import type {JsonObject} from "../../../lib/json.js";
import type {LiveVoiceInfrastructureHealth} from "../../voice/health.js";

export interface DiscordVoiceGatewayHealth {
  state: "closed" | "opening" | "identifying" | "ready" | "resuming";
  readyAt: number | null;
  sequence: number | null;
  lastHeartbeatSentAt: number | null;
  lastHeartbeatAckAt: number | null;
  heartbeatAckAgeMs: number | null;
  reconnectCount: number;
}

export interface DiscordVoiceInfrastructureHealth extends LiveVoiceInfrastructureHealth {
  gateway?: DiscordVoiceGatewayHealth;
}

/** Renders Discord-only Gateway and voice transport facts for generic diagnostics. */
export function discordVoiceTransportDiagnostics(input: {
  gateway?: DiscordVoiceGatewayHealth;
  connectionState: string;
  playerState: string;
  playback?: JsonObject;
  stateAt: number;
}): JsonObject {
  const gateway: JsonObject | null = input.gateway ? {
    state: input.gateway.state,
    readyAt: input.gateway.readyAt,
    sequence: input.gateway.sequence,
    lastHeartbeatSentAt: input.gateway.lastHeartbeatSentAt,
    lastHeartbeatAckAt: input.gateway.lastHeartbeatAckAt,
    heartbeatAckAgeMs: input.gateway.heartbeatAckAgeMs,
    reconnectCount: input.gateway.reconnectCount,
  } : null;
  return {
    gateway,
    voice: {state: input.connectionState, stateAt: input.stateAt, dave: "unknown"},
    player: {state: input.playerState, ...input.playback},
  };
}
