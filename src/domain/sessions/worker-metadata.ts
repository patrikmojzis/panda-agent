import type {JsonObject, JsonValue} from "../../kernel/agent/types.js";
import {isRecord} from "../../lib/records.js";
import {trimToUndefined} from "../../lib/strings.js";

export interface WorkerSessionMetadata {
  role: string;
  parentSessionId?: string;
}

export function buildWorkerSessionMetadata(input: {
  metadata?: JsonObject;
  role?: string;
  parentSessionId?: string;
}): JsonObject {
  return {
    ...(input.metadata ?? {}),
    worker: {
      role: trimToUndefined(input.role) ?? "worker",
      ...(input.parentSessionId ? {parentSessionId: input.parentSessionId} : {}),
    },
  };
}

export function readWorkerSessionMetadata(metadata: JsonValue | undefined): WorkerSessionMetadata | null {
  if (!isRecord(metadata) || !isRecord(metadata.worker)) {
    return null;
  }

  const role = trimToUndefined(metadata.worker.role) ?? "worker";
  const parentSessionId = trimToUndefined(metadata.worker.parentSessionId);
  return {
    role,
    ...(parentSessionId ? {parentSessionId} : {}),
  };
}
