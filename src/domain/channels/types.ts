import type {JsonValue} from "../../kernel/agent/types.js";

export interface OutboundRoute {
  source: string;
  connectorKey: string;
  externalConversationId: string;
}

export interface OutboundTarget extends OutboundRoute {
  externalActorId?: string;
  replyToMessageId?: string;
}

export interface ChannelTypingTarget extends OutboundRoute {
  externalActorId?: string;
}

export interface RememberedRoute extends OutboundRoute {
  externalActorId?: string;
  externalMessageId?: string;
  capturedAt: number;
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

export interface OutboundFileItem {
  type: "file";
  path: string;
  filename?: string;
  caption?: string;
  mimeType?: string;
}

export type OutboundItem =
  | OutboundTextItem
  | OutboundImageItem
  | OutboundFileItem;

export interface OutboundRequest {
  channel: string;
  target: OutboundTarget;
  items: readonly OutboundItem[];
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
