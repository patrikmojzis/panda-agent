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

export function readWorkerSessionMetadata(metadata: JsonValue | undefined): WorkerSessionMetadata | null {
  if (!isRecord(metadata) || !isRecord(metadata.worker)) {
    return null;
  }

  const role = trimToUndefined(metadata.worker.role) ?? "worker";
  const task = trimToUndefined(metadata.worker.task);
  const context = trimToUndefined(metadata.worker.context);
  const parentSessionId = trimToUndefined(metadata.worker.parentSessionId);
  return {
    role,
    ...(task ? {task} : {}),
    ...(context ? {context} : {}),
    ...(parentSessionId ? {parentSessionId} : {}),
  };
}
