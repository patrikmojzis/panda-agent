import type {MediaDescriptor} from "../channels/types.js";
import type {JsonValue} from "../../lib/json.js";

export type GatewayDeliveryMode = "queue" | "wake";
export type GatewaySourceStatus = "active" | "suspended";
export type GatewayEventStatus = "pending" | "processing" | "delivering" | "delivered" | "quarantined";
export type GatewayAttachmentStatus = "uploaded" | "bound" | "delivered" | "quarantined" | "scrubbed" | "expired";
export type GatewayAttachmentScanStatus = "not_scanned";

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

export type GatewayDeviceCapability =
  | "push_context"
  | "upload_attachments"
  | "claim_commands"
  | "screenshot.capture";

export interface GatewayDeviceRecord {
  sourceId: string;
  deviceId: string;
  label?: string;
  capabilities: readonly GatewayDeviceCapability[];
  enabled: boolean;
  disabledAt?: number;
  lastSeenAt?: number;
  createdAt: number;
  updatedAt: number;
}

export type GatewayDeviceCommandStatus = "queued" | "claimed" | "completed" | "failed" | "cancelled" | "timed_out" | "rejected";
export type GatewayDeviceCommandKind = "screenshot.capture";

export interface GatewayDeviceCommandRecord {
  id: string;
  sourceId: string;
  deviceId: string;
  kind: GatewayDeviceCommandKind;
  payload?: JsonValue;
  status: GatewayDeviceCommandStatus;
  createdAt: number;
  updatedAt: number;
  claimId?: string;
  claimedAt?: number;
  completedAt?: number;
  error?: string;
  result?: JsonValue;
  resultAttachmentId?: string;
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

export interface GatewayAttachmentRecord {
  id: string;
  sourceId: string;
  idempotencyKey: string;
  status: GatewayAttachmentStatus;
  scanStatus: GatewayAttachmentScanStatus;
  mimeType: string;
  sniffedMimeType?: string;
  filename?: string;
  sizeBytes: number;
  sha256: string;
  localPath: string;
  mediaSource: string;
  connectorKey: string;
  mediaMetadata?: JsonValue;
  createdAt: number;
  expiresAt: number;
  boundAt?: number;
  deliveredAt?: number;
  quarantinedAt?: number;
  scrubbedAt?: number;
}

export interface GatewayEventAttachmentRecord extends GatewayAttachmentRecord {
  eventId: string;
  position: number;
}

export interface GatewayStoredEventResult {
  event: GatewayEventRecord;
  inserted: boolean;
}

export interface GatewayStoredAttachmentResult {
  attachment: GatewayAttachmentRecord;
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

export interface GatewayAttachmentRefInput {
  id: string;
  sha256?: string;
}

export interface GatewayAttachmentUploadInput {
  sourceId: string;
  idempotencyKey: string;
  descriptor: MediaDescriptor;
  sha256: string;
  mimeType: string;
  sniffedMimeType?: string;
  filename?: string;
  expiresAt: number;
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
  attachments?: readonly GatewayAttachmentRefInput[];
}

export function gatewayAttachmentToMediaDescriptor(attachment: GatewayAttachmentRecord): MediaDescriptor {
  return {
    id: attachment.id,
    source: attachment.mediaSource,
    connectorKey: attachment.connectorKey,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    localPath: attachment.localPath,
    ...(attachment.filename ? {originalFilename: attachment.filename} : {}),
    ...(attachment.mediaMetadata !== undefined ? {metadata: attachment.mediaMetadata} : {}),
    createdAt: attachment.createdAt,
  };
}
