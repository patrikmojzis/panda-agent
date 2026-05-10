import type {JsonObject, JsonValue} from "../../kernel/agent/types.js";
import {isRecord} from "../../lib/records.js";
import {trimToUndefined} from "../../lib/strings.js";

export interface WorkerSessionMetadata {
  role: string;
  task?: string;
  context?: string;
  parentSessionId?: string;
}

export function buildWorkerSessionMetadata(input: {
  metadata?: JsonObject;
  role?: string;
  task?: string;
  context?: string;
  parentSessionId?: string;
}): JsonObject {
  const task = trimToUndefined(input.task);
  const context = trimToUndefined(input.context);
  const parentSessionId = trimToUndefined(input.parentSessionId);
  return {
    ...(input.metadata ?? {}),
    worker: {
      role: trimToUndefined(input.role) ?? "worker",
      ...(task ? {task} : {}),
      ...(context ? {context} : {}),
      ...(parentSessionId ? {parentSessionId} : {}),
    },
  };
}

function readMetadataRecord(metadata: JsonValue | undefined): Record<string, unknown> | null {
  if (isRecord(metadata)) {
    return metadata;
  }
  if (typeof metadata !== "string" || !metadata.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(metadata) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function readWorkerSessionMetadata(metadata: JsonValue | undefined): WorkerSessionMetadata | null {
  const record = readMetadataRecord(metadata);
  if (!record || !isRecord(record.worker)) {
    return null;
  }

  const role = trimToUndefined(record.worker.role) ?? "worker";
  const task = trimToUndefined(record.worker.task);
  const context = trimToUndefined(record.worker.context);
  const parentSessionId = trimToUndefined(record.worker.parentSessionId);
  return {
    role,
    ...(task ? {task} : {}),
    ...(context ? {context} : {}),
    ...(parentSessionId ? {parentSessionId} : {}),
  };
}
