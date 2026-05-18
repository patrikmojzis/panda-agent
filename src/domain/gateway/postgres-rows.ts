import {readOptionalJsonValue, type JsonValue} from "../../lib/json.js";
import {requireNonNegativeInteger} from "../../lib/numbers.js";
import {optionalTimestampMillis, requireTimestampMillis} from "../../lib/postgres-values.js";
import {requireTrimmedString} from "../../lib/strings.js";
import type {
  GatewayDeliveryMode,
  GatewayEventRecord,
  GatewayEventStatus,
  GatewayEventTypeRecord,
  GatewaySourceRecord,
  GatewaySourceStatus,
  GatewayStrikeRecord,
} from "./types.js";

export function requireGatewayTrimmedString(label: string, value: unknown): string {
  return requireTrimmedString(value, `${label} must be a string.`, `${label} must not be empty.`);
}

export function normalizeGatewaySourceId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(normalized)) {
    throw new Error("Gateway source id must use lowercase letters, numbers, hyphens, or underscores.");
  }
  return normalized;
}

export function normalizeGatewayEventType(value: string): string {
  const normalized = value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,119}$/.test(normalized)) {
    throw new Error("Gateway event type must use letters, numbers, dots, colons, underscores, or hyphens.");
  }
  return normalized;
}

function parseRequiredString(label: string, value: unknown): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }

  return value;
}

function parseOptionalTrimmed(label: string, value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : requireGatewayTrimmedString(label, value);
}

function parseRiskScore(value: unknown): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Gateway event risk score must be a finite number.");
  }

  return value;
}

function parseSourceStatus(value: unknown): GatewaySourceStatus {
  if (value === "active" || value === "suspended") {
    return value;
  }

  throw new Error(`Unsupported gateway source status ${String(value)}.`);
}

export function parseGatewayDeliveryMode(value: unknown): GatewayDeliveryMode {
  if (value === "queue" || value === "wake") {
    return value;
  }

  throw new Error(`Unsupported gateway delivery mode ${String(value)}.`);
}

function parseEventStatus(value: unknown): GatewayEventStatus {
  if (
    value === "pending"
    || value === "processing"
    || value === "delivering"
    || value === "delivered"
    || value === "quarantined"
  ) {
    return value;
  }

  throw new Error(`Unsupported gateway event status ${String(value)}.`);
}

export function parseOptionalGatewayMetadata(label: string, value: unknown): JsonValue | undefined {
  return readOptionalJsonValue(value, label);
}

export function parseNonNegativeBigintCounter(label: string, value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }

  if (typeof value === "string" && /^[0-9]+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) {
      return parsed;
    }
  }

  throw new Error(`${label} must be a non-negative integer.`);
}

export function parseGatewaySourceRow(row: Record<string, unknown>): GatewaySourceRecord {
  return {
    sourceId: normalizeGatewaySourceId(requireGatewayTrimmedString("Gateway source id", row.source_id)),
    name: requireGatewayTrimmedString("Gateway source name", row.name),
    clientId: requireGatewayTrimmedString("Gateway client id", row.client_id),
    agentKey: requireGatewayTrimmedString("Gateway agent key", row.agent_key),
    identityId: requireGatewayTrimmedString("Gateway identity id", row.identity_id),
    sessionId: parseOptionalTrimmed("Gateway session id", row.session_id),
    status: parseSourceStatus(row.status),
    suspendedAt: optionalTimestampMillis(row.suspended_at, "Gateway source suspended_at must be a finite timestamp."),
    suspendReason: parseOptionalTrimmed("Gateway suspend reason", row.suspend_reason),
    createdAt: requireTimestampMillis(row.created_at, "Gateway source created_at must be a finite timestamp."),
    updatedAt: requireTimestampMillis(row.updated_at, "Gateway source updated_at must be a finite timestamp."),
  };
}

export function parseGatewayEventTypeRow(row: Record<string, unknown>): GatewayEventTypeRecord {
  return {
    sourceId: normalizeGatewaySourceId(requireGatewayTrimmedString("Gateway source id", row.source_id)),
    type: normalizeGatewayEventType(requireGatewayTrimmedString("Gateway event type", row.event_type)),
    delivery: parseGatewayDeliveryMode(row.delivery),
    createdAt: requireTimestampMillis(row.created_at, "Gateway event type created_at must be a finite timestamp."),
    updatedAt: requireTimestampMillis(row.updated_at, "Gateway event type updated_at must be a finite timestamp."),
  };
}

export function parseGatewayEventRow(row: Record<string, unknown>): GatewayEventRecord {
  return {
    id: requireGatewayTrimmedString("Gateway event id", row.id),
    sourceId: normalizeGatewaySourceId(requireGatewayTrimmedString("Gateway source id", row.source_id)),
    type: normalizeGatewayEventType(requireGatewayTrimmedString("Gateway event type", row.event_type)),
    deliveryRequested: parseGatewayDeliveryMode(row.delivery_requested),
    deliveryEffective: parseGatewayDeliveryMode(row.delivery_effective),
    occurredAt: optionalTimestampMillis(row.occurred_at, "Gateway event occurred_at must be a finite timestamp."),
    idempotencyKey: requireGatewayTrimmedString("Gateway idempotency key", row.idempotency_key),
    text: parseRequiredString("Gateway event text", row.text),
    textBytes: requireNonNegativeInteger(row.text_bytes, "Gateway event text bytes"),
    textSha256: requireGatewayTrimmedString("Gateway event text hash", row.text_sha256),
    status: parseEventStatus(row.status),
    riskScore: parseRiskScore(row.risk_score),
    reason: parseOptionalTrimmed("Gateway event reason", row.reason),
    threadId: parseOptionalTrimmed("Gateway event thread id", row.thread_id),
    metadata: parseOptionalGatewayMetadata("Gateway event metadata", row.metadata),
    createdAt: requireTimestampMillis(row.created_at, "Gateway event created_at must be a finite timestamp."),
    claimId: parseOptionalTrimmed("Gateway event claim id", row.claim_id),
    claimedAt: optionalTimestampMillis(row.claimed_at, "Gateway event claimed_at must be a finite timestamp."),
    processedAt: optionalTimestampMillis(row.processed_at, "Gateway event processed_at must be a finite timestamp."),
    deliveredAt: optionalTimestampMillis(row.delivered_at, "Gateway event delivered_at must be a finite timestamp."),
    textScrubbedAt: optionalTimestampMillis(row.text_scrubbed_at, "Gateway event text_scrubbed_at must be a finite timestamp."),
  };
}

export function parseGatewayStrikeRow(row: Record<string, unknown>): GatewayStrikeRecord {
  return {
    id: requireGatewayTrimmedString("Gateway strike id", row.id),
    sourceId: normalizeGatewaySourceId(requireGatewayTrimmedString("Gateway source id", row.source_id)),
    kind: requireGatewayTrimmedString("Gateway strike kind", row.kind),
    reason: requireGatewayTrimmedString("Gateway strike reason", row.reason),
    eventId: parseOptionalTrimmed("Gateway strike event id", row.event_id),
    metadata: parseOptionalGatewayMetadata("Gateway strike metadata", row.metadata),
    createdAt: requireTimestampMillis(row.created_at, "Gateway strike created_at must be a finite timestamp."),
  };
}
