import type {Message} from "@earendil-works/pi-ai";

import {isJsonValue, type JsonObject, type JsonValue} from "../../../lib/json.js";
import {optionalNonEmptyString, requireNonEmptyString} from "../../../lib/strings.js";
import {optionalTimestampMillis, requireTimestampMillis} from "../../../lib/postgres-values.js";
import type {
    ThreadInputDeliveryMode,
    ThreadInputStatus,
    ThreadPendingInputRecord,
    ThreadMessageOrigin,
    ThreadInputRecord,
    ThreadMessageRecord,
    ThreadRecord,
    ThreadRunRecord,
    ThreadRunOwner,
    ThreadRunStatus,
    ThreadToolJobKind,
    ThreadToolJobRecord,
    ThreadToolJobStatus,
} from "./types.js";

const messageOrigins = ["input", "runtime"] as const satisfies readonly ThreadMessageOrigin[];
const inputDeliveryModes = ["wake", "queue"] as const satisfies readonly ThreadInputDeliveryMode[];
const runStatuses = ["running", "completed", "failed"] as const satisfies readonly ThreadRunStatus[];
const toolJobKinds = ["bash", "command", "image_generate", "spawn_subagent", "web_research"] as const satisfies readonly ThreadToolJobKind[];
const toolJobStatuses = ["running", "completed", "failed", "cancelled", "lost"] as const satisfies readonly ThreadToolJobStatus[];

function parseRequiredString(value: unknown, label: string): string {
  return requireNonEmptyString(value, `Thread runtime ${label} must not be empty.`);
}

function parseOptionalString(value: unknown): string | undefined {
  return optionalNonEmptyString(value, "Thread runtime optional string must not be empty.");
}

function parseString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`Thread runtime ${label} must be a string.`);
  }
  return value;
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

function parseMessageMetadata(row: Record<string, unknown>, source: string): JsonValue | undefined {
  const metadata = parseOptionalJsonValue(row.metadata, "message metadata");
  const compactedThroughSequence = parseOptionalBigintNumber(
    row.compacted_through_sequence,
    "compacted-through sequence",
  );
  if (compactedThroughSequence === undefined) {
    if (
      metadata
      && typeof metadata === "object"
      && !Array.isArray(metadata)
      && metadata.kind === "compact_boundary"
    ) {
      throw new Error("Thread runtime compact boundary is missing its typed checkpoint sequence.");
    }
    return metadata;
  }

  if (
    source !== "compact"
    || !metadata
    || typeof metadata !== "object"
    || Array.isArray(metadata)
    || metadata.kind !== "compact_boundary"
  ) {
    throw new Error("Thread runtime typed checkpoint must belong to a compact boundary message.");
  }
  if ("compactedThroughSequence" in metadata || "compactedUpToSequence" in metadata) {
    throw new Error("Thread runtime compact checkpoint sequence must not be duplicated in metadata.");
  }

  return {
    ...metadata,
    compactedThroughSequence,
  };
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
    replacesThreadId: parseOptionalString(row.replaces_thread_id),
    runtimeState: parseOptionalJsonObject(row.runtime_state, "runtime state") as ThreadRecord["runtimeState"],
    createdAt: requireTimestampMillis(row.created_at, "Thread runtime created_at must be a valid timestamp."),
    updatedAt: requireTimestampMillis(row.updated_at, "Thread runtime updated_at must be a valid timestamp."),
  };
}

export function parseMessageRow(row: Record<string, unknown>): ThreadMessageRecord {
  const source = parseRequiredString(row.source, "message source");
  return {
    id: parseRequiredString(row.id, "message id"),
    threadId: parseRequiredString(row.thread_id, "thread id"),
    sequence: parseRequiredBigintNumber(row.sequence, "message sequence"),
    origin: parseOrigin(row.origin),
    inputId: parseOptionalString(row.input_id),
    message: parseMessage(row.message, "message"),
    metadata: parseMessageMetadata(row, source),
    source,
    channelId: parseOptionalString(row.channel_id),
    externalMessageId: parseOptionalString(row.external_message_id),
    actorId: parseOptionalString(row.actor_id),
    identityId: parseOptionalString(row.identity_id),
    runId: parseOptionalString(row.run_id),
    createdAt: requireTimestampMillis(row.created_at, "Thread runtime message created_at must be a valid timestamp."),
  };
}

export function parseInputRow(row: Record<string, unknown>): ThreadInputRecord {
  const appliedAt = optionalTimestampMillis(row.applied_at, "Thread runtime input applied_at must be a valid timestamp.");
  const discardedAt = optionalTimestampMillis(
    row.discarded_at,
    "Thread runtime input discarded_at must be a valid timestamp.",
  );
  if (appliedAt !== undefined && discardedAt !== undefined) {
    throw new Error("Thread runtime input cannot be both applied and discarded.");
  }
  const status: ThreadInputStatus = appliedAt !== undefined
    ? "applied"
    : discardedAt !== undefined
      ? "discarded"
      : "pending";
  const appliedRunId = parseOptionalString(row.applied_run_id);
  if (status !== "applied" && appliedRunId !== undefined) {
    throw new Error("Thread runtime unapplied input cannot reference an applied run.");
  }

  return {
    id: parseRequiredString(row.id, "input id"),
    threadId: parseRequiredString(row.thread_id, "thread id"),
    order: parseRequiredBigintNumber(row.input_order, "input order"),
    deliveryMode: parseDeliveryMode(row.delivery_mode),
    status,
    connectorKey: parseString(row.connector_key, "input connector key"),
    source: parseRequiredString(row.source, "input source"),
    channelId: parseOptionalString(row.channel_id),
    externalMessageId: parseOptionalString(row.external_message_id),
    actorId: parseOptionalString(row.actor_id),
    identityId: parseOptionalString(row.identity_id),
    createdAt: requireTimestampMillis(row.created_at, "Thread runtime input created_at must be a valid timestamp."),
    appliedAt,
    appliedRunId,
    discardedAt,
  };
}

export function parsePendingInputRow(row: Record<string, unknown>): ThreadPendingInputRecord {
  const input = parseInputRow(row);
  if (input.status !== "pending") {
    throw new Error(`Thread runtime input ${input.id} is not pending.`);
  }
  return {
    ...input,
    status: "pending",
    message: parseMessage(row.message, "input message"),
    metadata: parseOptionalJsonValue(row.metadata, "input metadata"),
  };
}

export function parseInputThreadIdRow(row: Record<string, unknown>): string {
  return parseRequiredString(row.thread_id, "input thread id");
}

export function parseRunRow(row: Record<string, unknown>): ThreadRunRecord {
  const ownerValues = [row.owner_source, row.owner_key, row.owner_holder_id];
  const hasOwner = ownerValues.some((value) => value !== null && value !== undefined);
  const owner: ThreadRunOwner | undefined = hasOwner
    ? {
      source: parseRequiredString(row.owner_source, "run owner source"),
      connectorKey: parseRequiredString(row.owner_key, "run owner key"),
      holderId: parseRequiredString(row.owner_holder_id, "run owner holder id"),
    }
    : undefined;
  return {
    id: parseRequiredString(row.id, "run id"),
    threadId: parseRequiredString(row.thread_id, "thread id"),
    ...(owner ? {owner} : {}),
    status: parseRunStatus(row.status),
    startedAt: requireTimestampMillis(row.started_at, "Thread runtime run started_at must be a valid timestamp."),
    admittedThroughInputOrder: parseOptionalBigintNumber(
      row.admitted_through_input_order,
      "run admitted input order",
    ),
    finishedAt: optionalTimestampMillis(row.finished_at, "Thread runtime run finished_at must be a valid timestamp."),
    error: parseOptionalString(row.error),
    abortRequestedAt: optionalTimestampMillis(row.abort_requested_at, "Thread runtime run abort_requested_at must be a valid timestamp."),
    abortReason: parseOptionalString(row.abort_reason),
  };
}

export function parseToolJobRow(row: Record<string, unknown>): ThreadToolJobRecord {
  const ownerSource = parseOptionalString(row.owner_source);
  const ownerKey = parseOptionalString(row.owner_key);
  const ownerHolderId = parseOptionalString(row.owner_holder_id);
  const owner = ownerSource && ownerKey && ownerHolderId
    ? {source: ownerSource, connectorKey: ownerKey, holderId: ownerHolderId}
    : undefined;
  return {
    id: parseRequiredString(row.id, "tool job id"),
    threadId: parseRequiredString(row.thread_id, "thread id"),
    runId: parseOptionalString(row.run_id),
    ...(owner ? {owner} : {}),
    parentToolCallId: parseOptionalString(row.parent_tool_call_id),
    commandOrdinal: parseOptionalBigintNumber(row.command_ordinal, "command ordinal"),
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
