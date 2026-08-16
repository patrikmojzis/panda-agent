import type {JsonObject} from "../../lib/json.js";

export type LiveVoiceSessionState = "connecting" | "connected" | "disconnected" | "error";
export type LiveVoiceOperationalState = "connecting" | "ready" | "degraded" | "recovering" | "error";
export type LiveVoiceTurnStatus = "pending" | "queued" | "running" | "awaiting_final" | "final_sending" | "completed" | "failed";

export type LiveVoiceHealthReason =
  | "transport_not_ready"
  | "provider_connecting"
  | "provider_recovering"
  | "provider_unavailable"
  | "notification_listener_reconnecting"
  | "postgres_pool_waiting"
  | "audio_dropped"
  | "playback_failed";

export interface LiveVoiceSessionInput {
  id: string;
  source: string;
  connectorKey: string;
  scopeKey: string;
  roomKey: string;
  sessionId: string;
  agentKey: string;
  provider: string;
  model: string;
  state: LiveVoiceSessionState;
  transportContext?: JsonObject;
  lastError?: string;
  health?: LiveVoiceOperationalState;
  healthReasons?: readonly LiveVoiceHealthReason[];
  healthObservedAt?: number;
}

export interface LiveVoiceSessionRecord extends LiveVoiceSessionInput {
  healthReasons: readonly LiveVoiceHealthReason[];
  diagnostics?: JsonObject;
  startedAt: number;
  updatedAt: number;
}

export interface LiveVoiceTurnInput {
  id: string;
  liveVoiceSessionId: string;
  providerDelegationId: string;
  sourceUtteranceId: string;
  sessionId: string;
  agentKey: string;
  externalActorId?: string;
  identityId?: string;
  prompt: string;
}

export interface LiveVoiceTurnRecord extends LiveVoiceTurnInput {
  status: LiveVoiceTurnStatus;
  threadId?: string;
  runId?: string;
  resultText?: string;
  finalControlId?: string;
  finalText?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

/** Returns whether a durable live-voice turn can still accept progress or a final answer. */
export function isActiveLiveVoiceTurn(turn: Pick<LiveVoiceTurnRecord, "status">): boolean {
  return turn.status === "pending" || turn.status === "queued" || turn.status === "running" || turn.status === "awaiting_final";
}
