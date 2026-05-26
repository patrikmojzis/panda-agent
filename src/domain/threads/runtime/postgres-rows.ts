import type {Message} from "@mariozechner/pi-ai";

import {isJsonValue, type JsonObject, type JsonValue} from "../../../lib/json.js";
import {optionalNonEmptyString, requireNonEmptyString} from "../../../lib/strings.js";
import {optionalTimestampMillis, requireTimestampMillis} from "../../../lib/postgres-values.js";
import type {
    ThreadInputDeliveryMode,
    ThreadMessageOrigin,
    ThreadInputRecord,
    ThreadMessageRecord,
    ThreadRecord,
    ThreadRunRecord,
    ThreadRunStatus,
    ThreadToolJobKind,
    ThreadToolJobRecord,
    ThreadToolJobStatus,
} from "./types.js";

const messageOrigins = ["input", "runtime"] as const satisfies readonly ThreadMessageOrigin[];
const inputDeliveryModes = ["wake", "queue"] as const satisfies readonly ThreadInputDeliveryMode[];
const runStatuses = ["running", "completed", "failed"] as const satisfies readonly ThreadRunStatus[];
const toolJobKinds = ["bash", "image_generate", "spawn_subagent", "web_research"] as const satisfies readonly ThreadToolJobKind[];
const toolJobStatuses = ["running", "completed", "failed", "cancelled", "lost"] as const satisfies readonly ThreadToolJobStatus[];

export interface RunningToolJobLossRow {
  id: string;
  threadId: string;
  startedAt: number;
}

function parseRequiredString(value: unknown, label: string): string {
  return requireNonEmptyString(value, `Thread runtime ${label} must not be empty.`);
}

function parseOptionalString(value: unknown): string | undefined {
  return optionalNonEmptyString(value, "Thread runtime optional string must not be empty.");
}

function parseRequiredBigintNumber(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return value;
  }

  if (typeof value === "string" && /^-?[0-9]+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) {
      return parsed;
    }
  }

  throw new Error(`Thread runtime ${label} must be a safe integer.`);
}

function parseOptionalBigintNumber(value: unknown, label: string): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  return parseRequiredBigintNumber(value, label);
}

function parseJsonValue(value: unknown, label: string): JsonValue {
  if (!isJsonValue(value)) {
    throw new Error(`Thread runtime ${label} must be JSON-serializable.`);
  }

  return value;
}

function parseOptionalJsonValue(value: unknown, label: string): JsonValue | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  return parseJsonValue(value, label);
}

function parseJsonObject(value: unknown, label: string): JsonObject {
  if (!isJsonValue(value) || typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Thread runtime ${label} must be a JSON object.`);
  }

  return value;
}

function parseOptionalJsonObject(value: unknown, label: string): JsonObject | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  return parseJsonObject(value, label);
}

function isMessageRole(value: unknown): value is Message["role"] {
  return value === "user" || value === "assistant" || value === "toolResult";
}

function isPersistedMessage(value: unknown): value is Message {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  // Provider message payloads can drift; the durable invariant Panda needs at
  // this boundary is that replay can route the message by role.
  return isMessageRole((value as {role?: unknown}).role);
}

function parseMessage(value: unknown, label: string): Message {
  const message = parseJsonObject(value, label);
  if (!isPersistedMessage(message)) {
    throw new Error(`Thread runtime ${label} has unsupported role ${String(message.role)}.`);
  }

  return message;
}

function parseOrigin(value: unknown): ThreadMessageOrigin {
  if (typeof value !== "string" || !messageOrigins.includes(value as ThreadMessageOrigin)) {
    throw new Error(`Unsupported thread message origin ${String(value)}`);
  }

  return value as ThreadMessageOrigin;
}

function parseDeliveryMode(value: unknown): ThreadInputDeliveryMode {
  if (typeof value !== "string" || !inputDeliveryModes.includes(value as ThreadInputDeliveryMode)) {
    throw new Error(`Unsupported thread input delivery mode ${String(value)}`);
  }

  return value as ThreadInputDeliveryMode;
}

function parseRunStatus(value: unknown): ThreadRunStatus {
  if (typeof value !== "string" || !runStatuses.includes(value as ThreadRunStatus)) {
    throw new Error(`Unsupported thread run status ${String(value)}`);
  }

  return value as ThreadRunStatus;
}

function parseToolJobKind(value: unknown): ThreadToolJobKind {
  if (typeof value !== "string" || !toolJobKinds.includes(value as ThreadToolJobKind)) {
    throw new Error(`Unsupported thread tool job kind ${String(value)}`);
  }

  return value as ThreadToolJobKind;
}

function parseToolJobStatus(value: unknown): ThreadToolJobStatus {
  if (typeof value !== "string" || !toolJobStatuses.includes(value as ThreadToolJobStatus)) {
    throw new Error(`Unsupported thread tool job status ${String(value)}`);
  }

  return value as ThreadToolJobStatus;
}

function parseToolJobSummary(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value !== "string") {
    throw new Error("Thread runtime tool job summary must be a string.");
  }

  return value;
}

export function parseThreadRow(row: Record<string, unknown>): ThreadRecord {
  return {
    id: parseRequiredString(row.id, "thread id"),
    sessionId: parseRequiredString(row.session_id, "session id"),
    runtimeState: parseOptionalJsonObject(row.runtime_state, "runtime state") as ThreadRecord["runtimeState"],
    createdAt: requireTimestampMillis(row.created_at, "Thread runtime created_at must be a valid timestamp."),
    updatedAt: requireTimestampMillis(row.updated_at, "Thread runtime updated_at must be a valid timestamp."),
  };
}

export function parseMessageRow(row: Record<string, unknown>): ThreadMessageRecord {
  return {
    id: parseRequiredString(row.id, "message id"),
    threadId: parseRequiredString(row.thread_id, "thread id"),
    sequence: parseRequiredBigintNumber(row.sequence, "message sequence"),
    origin: parseOrigin(row.origin),
    message: parseMessage(row.message, "message"),
    metadata: parseOptionalJsonValue(row.metadata, "message metadata"),
    source: parseRequiredString(row.source, "message source"),
    channelId: parseOptionalString(row.channel_id),
    externalMessageId: parseOptionalString(row.external_message_id),
    actorId: parseOptionalString(row.actor_id),
    identityId: parseOptionalString(row.identity_id),
    runId: parseOptionalString(row.run_id),
    createdAt: requireTimestampMillis(row.created_at, "Thread runtime message created_at must be a valid timestamp."),
  };
}

export function parseInputRow(row: Record<string, unknown>): ThreadInputRecord {
  return {
    id: parseRequiredString(row.id, "input id"),
    threadId: parseRequiredString(row.thread_id, "thread id"),
    order: parseRequiredBigintNumber(row.input_order, "input order"),
    deliveryMode: parseDeliveryMode(row.delivery_mode),
    message: parseMessage(row.message, "input message"),
    metadata: parseOptionalJsonValue(row.metadata, "input metadata"),
    source: parseRequiredString(row.source, "input source"),
    channelId: parseOptionalString(row.channel_id),
    externalMessageId: parseOptionalString(row.external_message_id),
    actorId: parseOptionalString(row.actor_id),
    identityId: parseOptionalString(row.identity_id),
    createdAt: requireTimestampMillis(row.created_at, "Thread runtime input created_at must be a valid timestamp."),
    appliedAt: optionalTimestampMillis(row.applied_at, "Thread runtime input applied_at must be a valid timestamp."),
  };
}

export function parseInputThreadIdRow(row: Record<string, unknown>): string {
  return parseRequiredString(row.thread_id, "input thread id");
}

export function parseRunRow(row: Record<string, unknown>): ThreadRunRecord {
  return {
    id: parseRequiredString(row.id, "run id"),
    threadId: parseRequiredString(row.thread_id, "thread id"),
    status: parseRunStatus(row.status),
    startedAt: requireTimestampMillis(row.started_at, "Thread runtime run started_at must be a valid timestamp."),
    finishedAt: optionalTimestampMillis(row.finished_at, "Thread runtime run finished_at must be a valid timestamp."),
    error: parseOptionalString(row.error),
    abortRequestedAt: optionalTimestampMillis(row.abort_requested_at, "Thread runtime run abort_requested_at must be a valid timestamp."),
    abortReason: parseOptionalString(row.abort_reason),
  };
}

export function parseToolJobRow(row: Record<string, unknown>): ThreadToolJobRecord {
  return {
    id: parseRequiredString(row.id, "tool job id"),
    threadId: parseRequiredString(row.thread_id, "thread id"),
    runId: parseOptionalString(row.run_id),
    kind: parseToolJobKind(row.kind),
    status: parseToolJobStatus(row.status),
    summary: parseToolJobSummary(row.summary),
    startedAt: requireTimestampMillis(row.started_at, "Thread runtime tool job started_at must be a valid timestamp."),
    finishedAt: optionalTimestampMillis(row.finished_at, "Thread runtime tool job finished_at must be a valid timestamp."),
    durationMs: parseOptionalBigintNumber(row.duration_ms, "tool job duration"),
    result: parseOptionalJsonObject(row.result, "tool job result"),
    error: parseOptionalString(row.error),
    statusReason: parseOptionalString(row.status_reason),
    progress: parseOptionalJsonObject(row.progress, "tool job progress"),
  };
}

export function parseRunningToolJobLossRow(row: Record<string, unknown>): RunningToolJobLossRow {
  return {
    id: parseRequiredString(row.id, "tool job id"),
    threadId: parseRequiredString(row.thread_id, "thread id"),
    startedAt: requireTimestampMillis(row.started_at, "Thread runtime tool job started_at must be a valid timestamp."),
  };
}
