import type {JsonObject, JsonValue} from "../../lib/json.js";

export type DeliveryContext = JsonObject;

export interface OutboundRoute {
  source: string;
  connectorKey: string;
  externalConversationId: string;
}

export interface OutboundTarget extends OutboundRoute {
  externalActorId?: string;
  replyToMessageId?: string;
  deliveryContext?: DeliveryContext;
}

export interface ChannelTypingTarget extends OutboundRoute {
  externalActorId?: string;
  deliveryContext?: DeliveryContext;
}

export interface RememberedRoute extends OutboundRoute {
  externalActorId?: string;
  externalMessageId?: string;
  capturedAt: number;
  deliveryContext?: DeliveryContext;
}

export interface MediaDescriptor {
  id: string;
  source: string;
  connectorKey: string;
  mimeType: string;
  sizeBytes: number;
  localPath: string;
  originalFilename?: string;
  metadata?: JsonValue;
  createdAt: number;
}

export interface InboundEnvelope extends OutboundRoute {
  externalActorId: string;
  externalMessageId: string;
  text?: string;
  media: readonly MediaDescriptor[];
  raw?: JsonValue;
  metadata?: JsonValue;
}

export interface OutboundTextItem {
  type: "text";
  text: string;
}

export interface OutboundImageItem {
  type: "image";
  path: string;
  caption?: string;
}

export interface OutboundPathFileItem {
  type: "file";
  path: string;
  filename?: string;
  caption?: string;
  mimeType?: string;
}

export interface OutboundUploadFileItem {
  type: "file";
  uploadRef: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  caption?: string;
}

export type OutboundFileItem = OutboundPathFileItem | OutboundUploadFileItem;

export type OutboundItem =
  | OutboundTextItem
  | OutboundImageItem
  | OutboundFileItem;

export interface OutboundRequest {
  deliveryId?: string;
  threadId?: string;
  channel: string;
  target: OutboundTarget;
  items: readonly OutboundItem[];
  metadata?: JsonValue;
}

export type ChannelTypingPhase = "start" | "keepalive" | "stop";

export interface ChannelTypingRequest {
  channel: string;
  target: ChannelTypingTarget;
  phase: ChannelTypingPhase;
}

export interface OutboundSentItem {
  type: OutboundItem["type"];
  externalMessageId: string;
}

export interface OutboundResult {
  ok: true;
  channel: string;
  target: OutboundTarget;
  sent: readonly OutboundSentItem[];
}
