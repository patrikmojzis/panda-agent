import type {Message} from "@earendil-works/pi-ai";

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
  compactedThroughSequence?: number;
  compactionInputChars?: number;
  preservedTailTokens?: number;
  summaryTokenBudget?: number;
  responseStopReason?: string;
  responseContentTypes?: string[];
  rawTextChars?: number;
  parsedSummaryChars?: number;
  error?: string;
};

export type CompactBoundaryMetadata = JsonObject & {
  kind: "compact_boundary";
  compactedThroughSequence: number;
  preservedTailUserTurns: number;
  trigger: "manual" | "auto";
  tokensBefore: number | null;
  tokensAfter: number | null;
  diagnostics?: CompactAttemptDiagnostics;
  /** Opaque runtime-owned provenance restored when older inputs leave replay. */
  replayContext?: JsonObject;
};

export type CompactFailureNoticeMetadata = JsonObject & {
  kind: "compact_failure_notice";
  trigger: "auto";
  reason: string;
  consecutiveFailures: number;
  cooldownUntil: number | null;
  diagnostics?: CompactAttemptDiagnostics;
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
  inputId?: string;
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

export interface ThreadTranscriptSnapshot {
  checkpointId: string | null;
  records: readonly ThreadMessageRecord[];
}

export type ThreadTranscriptPageOptions =
  | {
    /** Read older history, returned in ascending replay order. */
    beforeSequence?: number;
    afterSequence?: never;
    limit?: number;
  }
  | {
    /** Seek only records appended after an already observed sequence. */
    afterSequence: number;
    beforeSequence?: never;
    limit?: number;
  };

export interface ThreadTranscriptPage {
  records: readonly ThreadMessageRecord[];
  nextBeforeSequence?: number;
  nextAfterSequence?: number;
}

export interface ThreadCompactionCommit {
  /** Stable durable-operation id; a replay returns the already committed checkpoint. */
  id?: string;
  expectedCheckpointId: string | null;
  message: Message;
  metadata: CompactBoundaryMetadata;
  runId?: string;
  createdAt?: number;
}
