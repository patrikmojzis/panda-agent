import type {JsonValue} from "../../kernel/agent/types.js";

export type GatewayDeliveryMode = "queue" | "wake";
export type GatewaySourceStatus = "active" | "suspended";
export type GatewayEventStatus = "pending" | "processing" | "delivering" | "delivered" | "quarantined";

export interface GatewaySourceRecord {
  sourceId: string;
  name: string;
  clientId: string;
  agentKey: string;
  identityId: string;
  sessionId?: string;
  status: GatewaySourceStatus;
  suspendedAt?: number;
  suspendReason?: string;
  createdAt: number;
  updatedAt: number;
}

export interface GatewaySourceSecretResult {
  source: GatewaySourceRecord;
  clientSecret: string;
}

export interface GatewayEventTypeRecord {
  sourceId: string;
  type: string;
  delivery: GatewayDeliveryMode;
  createdAt: number;
  updatedAt: number;
}

export interface GatewayAccessTokenRecord {
  token: string;
  source: GatewaySourceRecord;
  expiresAt: number;
}

export interface GatewayEventRecord {
  id: string;
  sourceId: string;
  type: string;
  deliveryRequested: GatewayDeliveryMode;
  deliveryEffective: GatewayDeliveryMode;
  occurredAt?: number;
  idempotencyKey: string;
  text: string;
  textBytes: number;
  textSha256: string;
  status: GatewayEventStatus;
  riskScore?: number;
  reason?: string;
  threadId?: string;
  metadata?: JsonValue;
  createdAt: number;
  claimId?: string;
  claimedAt?: number;
  processedAt?: number;
  deliveredAt?: number;
  textScrubbedAt?: number;
}

export interface GatewayStoredEventResult {
  event: GatewayEventRecord;
  inserted: boolean;
}

export interface GatewayStrikeRecord {
  id: string;
  sourceId: string;
  kind: string;
  reason: string;
  eventId?: string;
  metadata?: JsonValue;
  createdAt: number;
}

export interface CreateGatewaySourceInput {
  sourceId: string;
  name?: string;
  agentKey: string;
  identityId: string;
  sessionId?: string;
}

export interface GatewayEventInput {
  sourceId: string;
  type: string;
  deliveryRequested: GatewayDeliveryMode;
  deliveryEffective: GatewayDeliveryMode;
  occurredAt?: number;
  idempotencyKey: string;
  text: string;
  textBytes: number;
  textSha256: string;
}
