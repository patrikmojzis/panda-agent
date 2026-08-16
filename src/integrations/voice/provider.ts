import type {LiveVoiceHistoryItem} from "./live-voice-session.js";

export type LiveVoiceContextChannel = "commentary" | "speakable";
export type LiveVoiceProviderFailureSource = "media" | "sideband" | "session";

export interface LiveVoiceProviderFailure {
  source: LiveVoiceProviderFailureSource;
  code: "auth_unavailable" | "access_denied" | "session_expired" | "capacity" | "transport_failed";
  retryable: boolean;
  message: string;
  status?: number;
}

export interface LiveVoiceProviderHealth {
  state: "connecting" | "connected" | "failed" | "closed";
  sidebandState: "connecting" | "open" | "failed" | "closed";
  sidebandOpenedAt: number | null;
  sidebandAgeMs: number | null;
  lastPingAt: number | null;
  lastPongAt: number | null;
  pongAgeMs: number | null;
  lastCloseCode: number | null;
  lastCloseOpenForMs: number | null;
  malformedEvents: number;
  unknownEvents: number;
  media?: {
    state: string;
    lastRtpAt: number | null;
    receivedPackets: number;
    lossMarkers: number;
    plcFrames: number;
    decodeFailures: number;
    ssrcChanges: number;
    pendingInputMs: number;
    droppedInputMs: number;
  };
}

export interface LiveVoiceProviderSession {
  connect(signal?: AbortSignal): Promise<void>;
  sendAudio(pcm24kMono: Buffer): void;
  interrupt(): void;
  appendDelegationContext(delegationId: string, text: string, channel: LiveVoiceContextChannel): boolean;
  appendSessionContext(text: string, channel: LiveVoiceContextChannel): boolean;
  getHealthSnapshot?(): LiveVoiceProviderHealth;
  close(): void;
}

export interface LiveVoiceProviderCallbacks {
  initialItems: readonly LiveVoiceHistoryItem[];
  onAudio(audio: Buffer): void;
  onDelegation(delegation: {id: string; prompt: string}): Promise<void> | void;
  onClearAudio(): void;
  onTurnDone(input: {role: "user" | "assistant" | "unknown"; transcript?: string}): void;
  onFailure(failure: LiveVoiceProviderFailure): void;
}

/** Creates one provider session while keeping provider auth and wire options outside the call core. */
export type LiveVoiceProviderFactory = (callbacks: LiveVoiceProviderCallbacks) => LiveVoiceProviderSession;

/** Describes a reusable provider without exposing its wire/auth configuration to call transports. */
export interface LiveVoiceProviderDefinition {
  id: string;
  model: string;
  createSession: LiveVoiceProviderFactory;
}
