import {isJsonObject, type JsonObject} from "../../lib/json.js";
import {isRecord} from "../../lib/records.js";

export interface EmailSendRecipientPayload {
  address: string;
  name?: string;
}

export interface EmailSendAttachmentPayload {
  path: string;
  filename?: string;
  mimeType?: string;
}

export interface EmailSendPayload {
  kind: "email_send";
  agentKey: string;
  accountKey: string;
  fromAddress: string;
  fromName?: string;
  to: EmailSendRecipientPayload[];
  cc: EmailSendRecipientPayload[];
  subject: string;
  text: string;
  html?: string;
  attachments: EmailSendAttachmentPayload[];
  replyToEmailId?: string;
  inReplyTo?: string;
  references?: string;
  threadKey: string;
}

function isEmailSendRecipientPayload(value: unknown): value is EmailSendRecipientPayload {
  return isRecord(value)
    && typeof value.address === "string"
    && (value.name === undefined || typeof value.name === "string");
}

function isEmailSendAttachmentPayload(value: unknown): value is EmailSendAttachmentPayload {
  return isRecord(value)
    && typeof value.path === "string"
    && (value.filename === undefined || typeof value.filename === "string")
    && (value.mimeType === undefined || typeof value.mimeType === "string");
}

export function isEmailSendPayload(value: unknown): value is EmailSendPayload {
  if (!isRecord(value)) {
    return false;
  }

  return value.kind === "email_send"
    && typeof value.agentKey === "string"
    && typeof value.accountKey === "string"
    && typeof value.fromAddress === "string"
    && (value.fromName === undefined || typeof value.fromName === "string")
    && Array.isArray(value.to)
    && value.to.every(isEmailSendRecipientPayload)
    && Array.isArray(value.cc)
    && value.cc.every(isEmailSendRecipientPayload)
    && typeof value.subject === "string"
    && typeof value.text === "string"
    && (value.html === undefined || typeof value.html === "string")
    && Array.isArray(value.attachments)
    && value.attachments.every(isEmailSendAttachmentPayload)
    && (value.replyToEmailId === undefined || typeof value.replyToEmailId === "string")
    && (value.inReplyTo === undefined || typeof value.inReplyTo === "string")
    && (value.references === undefined || typeof value.references === "string")
    && typeof value.threadKey === "string";
}

export function emailSendPayloadToJsonObject(payload: EmailSendPayload): JsonObject {
  if (isJsonObject(payload)) {
    return payload;
  }

  throw new Error("Email send payload must be JSON-safe.");
}
