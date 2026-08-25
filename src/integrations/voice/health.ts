import type {JsonObject} from "../../lib/json.js";
import type {LiveVoiceHealthReason, LiveVoiceOperationalState} from "../../domain/live-voice/types.js";
import type {LiveVoiceProviderHealth} from "./provider.js";

export interface LiveVoiceInfrastructureHealth {
  listener?: {status: "listening" | "reconnecting" | "closed"; lastConnectedAt: number | null; lastErrorAt: number | null};
  pool?: {max: number; totalCount: number; idleCount: number; waitingCount: number};
}

export interface LiveVoiceDiagnosticSnapshot {
  version: 1;
  observedAt: number;
  state: LiveVoiceOperationalState;
  reasons: readonly LiveVoiceHealthReason[];
  identity: {source: string; connectorKey: string; scopeKey: string; roomKey: string; liveVoiceSessionId: string};
  provider: LiveVoiceProviderHealth & {generation: number; reconnectCount: number; rtpAgeMs: number | null; operationalState: string};
  playback: {state: string; phase: string; responseEpoch: number; queuedMs: number; droppedMs: number; providerClears: number; underruns: number; lastAudioAt: number | null};
  capture: {state: "idle" | "capturing"; actorId: string | null; captureId: string | null; queuedMs: number; droppedMs: number; droppedPackets: number; lastAudioAt: number | null};
  delegation: {providerDelegationId: string | null; liveVoiceTurnId: string | null; deliveryControlId: string | null; status: string | null; updatedAt: number | null};
  postgres: {listenerStatus: "listening" | "reconnecting" | "closed" | null; listenerLastConnectedAt: number | null; listenerLastErrorAt: number | null; poolMax: number | null; poolTotal: number | null; poolIdle: number | null; poolWaiting: number | null};
  transport: JsonObject;
}

const MAX_REASONS = 6;

/** Derives transport-neutral live-call health from normalized component facts. */
export function deriveLiveVoiceHealth(input: {
  connecting: boolean;
  closing: boolean;
  transportReady: boolean;
  providerState: string;
  listenerStatus?: "listening" | "reconnecting" | "closed";
  poolWaiting?: number;
  audioDropped: boolean;
  playbackFailed: boolean;
}): {state: LiveVoiceOperationalState; reasons: LiveVoiceHealthReason[]} {
  const reasons: LiveVoiceHealthReason[] = [];
  if (!input.transportReady) reasons.push("transport_not_ready");
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
  if (bounded.includes("provider_recovering") || bounded.includes("notification_listener_reconnecting") || bounded.includes("transport_not_ready")) return {state: "recovering", reasons: bounded};
  return bounded.length === 0 ? {state: "ready", reasons: []} : {state: "degraded", reasons: bounded};
}
