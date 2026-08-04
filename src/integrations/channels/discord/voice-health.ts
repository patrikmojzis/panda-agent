export type DiscordVoiceOperationalState = "connecting" | "ready" | "degraded" | "recovering" | "error";

export type DiscordVoiceHealthReason =
  | "gateway_not_ready"
  | "gateway_heartbeat_stale"
  | "discord_voice_not_ready"
  | "provider_connecting"
  | "provider_recovering"
  | "provider_unavailable"
  | "notification_listener_reconnecting"
  | "postgres_pool_waiting"
  | "audio_dropped"
  | "playback_failed";

export interface DiscordVoiceGatewayHealth {
  state: "closed" | "opening" | "identifying" | "ready" | "resuming";
  readyAt: number | null;
  sequence: number | null;
  lastHeartbeatSentAt: number | null;
  lastHeartbeatAckAt: number | null;
  heartbeatAckAgeMs: number | null;
  reconnectCount: number;
}

export interface DiscordVoiceInfrastructureHealth {
  gateway?: DiscordVoiceGatewayHealth;
  listener?: {
    status: "listening" | "reconnecting" | "closed";
    lastConnectedAt: number | null;
    lastErrorAt: number | null;
  };
  pool?: {max: number; totalCount: number; idleCount: number; waitingCount: number};
}

export interface DiscordVoiceDiagnosticSnapshot {
  version: 1;
  observedAt: number;
  state: DiscordVoiceOperationalState;
  reasons: readonly DiscordVoiceHealthReason[];
  identity: {connectorKey: string; guildId: string; channelId: string; voiceSessionId: string};
  gateway: DiscordVoiceGatewayHealth | null;
  discordVoice: {state: string; stateAt: number; dave: "active" | "inactive" | "unknown"};
  provider: {
    generation: number;
    state: string;
    sidebandState: string;
    sidebandOpenedAt: number | null;
    sidebandAgeMs: number | null;
    lastPingAt: number | null;
    lastPongAt: number | null;
    pongAgeMs: number | null;
    lastRtpAt: number | null;
    rtpAgeMs: number | null;
    reconnectCount: number;
    lastCloseCode: number | null;
    lastCloseOpenForMs: number | null;
    malformedEvents: number;
    unknownEvents: number;
  };
  playback: {
    state: string;
    responseEpoch: number;
    queuedMs: number;
    droppedMs: number;
    underruns: number;
    lastAudioAt: number | null;
  };
  capture: {
    state: "idle" | "capturing";
    speakerId: string | null;
    utteranceId: string | null;
    queuedMs: number;
    droppedMs: number;
    droppedPackets: number;
    lastAudioAt: number | null;
  };
  delegation: {
    delegationId: string | null;
    voiceTurnId: string | null;
    runId: string | null;
    deliveryControlId: string | null;
    status: string | null;
    updatedAt: number | null;
  };
  postgres: {
    listenerStatus: "listening" | "reconnecting" | "closed" | null;
    listenerLastConnectedAt: number | null;
    listenerLastErrorAt: number | null;
    poolMax: number | null;
    poolTotal: number | null;
    poolIdle: number | null;
    poolWaiting: number | null;
  };
}

const MAX_REASONS = 6;

/** Derives a bounded operator-facing health state from live voice transport facts. */
export function deriveDiscordVoiceHealth(input: {
  connecting: boolean;
  closing: boolean;
  discordVoiceReady: boolean;
  gateway?: DiscordVoiceGatewayHealth;
  providerState: string;
  listenerStatus?: "listening" | "reconnecting" | "closed";
  poolWaiting?: number;
  audioDropped: boolean;
  playbackFailed: boolean;
}): {state: DiscordVoiceOperationalState; reasons: DiscordVoiceHealthReason[]} {
  const reasons: DiscordVoiceHealthReason[] = [];
  if (input.gateway && input.gateway.state !== "ready") reasons.push("gateway_not_ready");
  if (input.gateway?.heartbeatAckAgeMs !== null && input.gateway?.heartbeatAckAgeMs !== undefined && input.gateway.heartbeatAckAgeMs > 90_000) reasons.push("gateway_heartbeat_stale");
  if (!input.discordVoiceReady) reasons.push("discord_voice_not_ready");
  if (input.providerState === "recovering") reasons.push("provider_recovering");
  else if (input.providerState === "connecting") reasons.push("provider_connecting");
  else if (input.providerState !== "connected") reasons.push("provider_unavailable");
  if (input.listenerStatus && input.listenerStatus !== "listening") reasons.push("notification_listener_reconnecting");
  if ((input.poolWaiting ?? 0) > 0) reasons.push("postgres_pool_waiting");
  if (input.audioDropped) reasons.push("audio_dropped");
  if (input.playbackFailed) reasons.push("playback_failed");

  const bounded = [...new Set(reasons)].slice(0, MAX_REASONS);
  if (input.closing || bounded.includes("provider_unavailable") || bounded.includes("playback_failed")) return {state: "error", reasons: bounded};
  if (input.connecting) return {state: "connecting", reasons: bounded};
  if (bounded.includes("provider_recovering") || bounded.includes("notification_listener_reconnecting") || bounded.includes("gateway_not_ready")) return {state: "recovering", reasons: bounded};
  return bounded.length === 0 ? {state: "ready", reasons: []} : {state: "degraded", reasons: bounded};
}
