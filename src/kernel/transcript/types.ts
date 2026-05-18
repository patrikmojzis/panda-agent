import type {Message} from "@mariozechner/pi-ai";

import type {JsonObject, JsonValue} from "../../lib/json.js";

export type CompactAttemptOutcome =
  | "success"
  | "no_split"
  | "empty_input"
  | "tail_over_operating_window"
  | "empty_summary"
  | "summary_too_large";

export type CompactAttemptDiagnostics = JsonObject & {
  outcome: CompactAttemptOutcome;
  trigger: "manual" | "auto";
  model: string;
  providerName: string;
  modelId: string;
  thinking?: string;
  operatingWindow: number;
  compactTriggerTokens: number;
  activeTranscriptRecords: number;
  activeTranscriptTokens: number;
  summaryRecordCount?: number;
  preservedTailRecordCount?: number;
  compactedUpToSequence?: number;
  compactionInputChars?: number;
  preservedTailTokens?: number;
  summaryTokenBudget?: number;
  responseStopReason?: string;
  responseContentTypes?: string[];
  rawTextChars?: number;
  parsedSummaryChars?: number;
  error?: string;
};

export interface AutoCompactionRuntimeState {
  consecutiveFailures: number;
  lastFailureReason?: string;
  lastFailureAt?: number;
  cooldownUntil?: number;
  lastAttempt?: CompactAttemptDiagnostics;
}

export interface ThreadRuntimeState {
  autoCompaction?: AutoCompactionRuntimeState;
}

export interface InferenceProjectionRule {
  preserveRecentUserTurns?: number;
  olderThanMs?: number;
  preserveTailMessages?: number;
}

export interface InferenceProjection {
  dropThinking?: InferenceProjectionRule;
  dropToolCalls?: InferenceProjectionRule;
  dropImages?: InferenceProjectionRule;
  dropMessages?: InferenceProjectionRule;
}

export interface TranscriptThreadState {
  id: string;
  runtimeState?: ThreadRuntimeState;
}

export interface ThreadMessageMetadata {
  source: string;
  channelId?: string;
  externalMessageId?: string;
  actorId?: string;
  identityId?: string;
}

export type ThreadMessageOrigin = "input" | "runtime";

export interface ThreadMessageRecord extends ThreadMessageMetadata {
  id: string;
  threadId: string;
  sequence: number;
  origin: ThreadMessageOrigin;
  message: Message;
  metadata?: JsonValue;
  runId?: string;
  createdAt: number;
}

export interface ThreadRuntimeMessagePayload extends ThreadMessageMetadata {
  origin?: ThreadMessageOrigin;
  message: Message;
  metadata?: JsonValue;
  runId?: string;
  createdAt?: number;
}
