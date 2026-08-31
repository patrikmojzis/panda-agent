import type {JsonObject} from "../../../../lib/json.js";

export const WHATSAPP_META_ACCESS_TOKEN_SECRET = "meta_access_token";
export const WHATSAPP_META_APP_SECRET = "meta_app_secret";
export const WHATSAPP_META_VERIFY_TOKEN_SECRET = "meta_verify_token";

export interface WhatsAppMetaCallingConfig {
  mode: "meta_cloud";
  calling: {
    enabled: true;
    phoneNumberId: string;
    wabaId: string;
    graphVersion: string;
  };
}

export interface WhatsAppCallEvent {
  callId: string;
  phoneNumberId: string;
  event: "connect" | "terminate";
  from?: string;
  fromUserId?: string;
  timestamp: string;
  offerSdp?: string;
}

export type WhatsAppCallControlOperation = "send" | "hangup";
export type WhatsAppCallSendMode = "progress" | "final";
export type WhatsAppCallControlStatus = "pending" | "running" | "completed" | "failed";

export interface WhatsAppCallControlInput {
  connectorKey: string;
  operation: WhatsAppCallControlOperation;
  sessionId: string;
  agentKey: string;
  callId: string;
  text?: string;
  mode?: WhatsAppCallSendMode;
  voiceTurnId?: string;
  idempotencyKey?: string;
}

export interface WhatsAppCallControlRecord extends WhatsAppCallControlInput {
  id: string;
  status: WhatsAppCallControlStatus;
  result?: JsonObject;
  error?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface WhatsAppCallNotification {
  kind: "control";
  connectorKey: string;
  controlId: string;
}
