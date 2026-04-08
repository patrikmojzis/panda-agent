import type { JsonValue } from "../../agent-core/types.js";

export interface OutboundRoute {
  source: string;
  connectorKey: string;
  externalConversationId: string;
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
