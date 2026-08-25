import type {JsonValue} from "../../lib/json.js";
import type {
  CompactBoundaryMetadata,
  CompactFailureNoticeMetadata,
  ThreadMessageRecord,
} from "./types.js";

export function hasCompactBoundaryKind(value: JsonValue | undefined): boolean {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && value.kind === "compact_boundary";
}

function isCompactBoundaryMetadata(value: JsonValue | undefined): value is CompactBoundaryMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return record.kind === "compact_boundary"
    && typeof record.compactedThroughSequence === "number"
    && Number.isSafeInteger(record.compactedThroughSequence)
    && record.compactedThroughSequence >= 0
    && typeof record.preservedTailUserTurns === "number"
    && Number.isSafeInteger(record.preservedTailUserTurns)
    && record.preservedTailUserTurns >= 0
    && (record.trigger === "manual" || record.trigger === "auto");
}

function isCompactFailureNoticeMetadata(value: JsonValue | undefined): value is CompactFailureNoticeMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return record.kind === "compact_failure_notice"
    && record.trigger === "auto"
    && typeof record.reason === "string"
    && typeof record.consecutiveFailures === "number";
}

export function isCompactBoundaryRecord(
  record: ThreadMessageRecord,
): record is ThreadMessageRecord & {metadata: CompactBoundaryMetadata} {
  return record.source === "compact" && isCompactBoundaryMetadata(record.metadata);
}

export function isCompactFailureNoticeRecord(
  record: ThreadMessageRecord,
): record is ThreadMessageRecord & {metadata: CompactFailureNoticeMetadata} {
  return record.source === "compact" && isCompactFailureNoticeMetadata(record.metadata);
}

/** Returns the one checkpoint and ordinary tail that define current model replay. */
export function projectTranscriptForRun(
  transcript: readonly ThreadMessageRecord[],
): readonly ThreadMessageRecord[] {
  const modelVisibleTranscript = transcript.filter((record) => !isCompactFailureNoticeRecord(record));

  for (let index = modelVisibleTranscript.length - 1; index >= 0; index -= 1) {
    const record = modelVisibleTranscript[index];
    if (!record || !isCompactBoundaryRecord(record)) {
      continue;
    }

    const checkpoint = record;
    const tail = modelVisibleTranscript.filter((candidate) => {
      // Checkpoints are persisted after their preserved tail but replayed before
      // it. A scalar cutoff therefore cannot supersede older checkpoints by
      // itself; the newest checkpoint replaces every prior checkpoint outright.
      return !isCompactBoundaryRecord(candidate)
        && candidate.sequence > checkpoint.metadata.compactedThroughSequence;
    });

    return [checkpoint, ...tail];
  }

  return modelVisibleTranscript;
}
