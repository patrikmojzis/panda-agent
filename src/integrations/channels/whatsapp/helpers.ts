import path from "node:path";

import type {WAMessage} from "baileys";
import {normalizeMessageContent} from "baileys/lib/Utils/messages.js";

import type {JsonObject} from "../../../kernel/agent/types.js";
import type {MediaDescriptor} from "../../../domain/channels/types.js";
import {WHATSAPP_SOURCE} from "./config.js";

export interface WhatsAppInboundTextOptions {
  connectorKey: string;
  externalConversationId: string;
  externalActorId: string;
  externalMessageId: string;
  remoteJid: string;
  chatType: string;
  text?: string;
  pushName?: string;
  quotedMessageId?: string;
  media: readonly MediaDescriptor[];
}

export interface WhatsAppInboundMetadataOptions {
  connectorKey: string;
  externalConversationId: string;
  externalActorId: string;
  externalMessageId: string;
  remoteJid: string;
  chatType: string;
  pushName?: string;
  quotedMessageId?: string;
  media: readonly MediaDescriptor[];
}

function describeMediaDescriptor(descriptor: MediaDescriptor): string {
  const filename = descriptor.originalFilename ?? path.basename(descriptor.localPath);
  return [
    "- id: " + descriptor.id,
    `  filename: ${filename}`,
    `  mime_type: ${descriptor.mimeType}`,
    `  size_bytes: ${descriptor.sizeBytes}`,
    `  path: ${descriptor.localPath}`,
  ].join("\n");
}

function formatMaybeValue(value: string | undefined): string {
  return value?.trim() || "null";
}

function trimMaybeValue(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function serializeMediaDescriptor(descriptor: MediaDescriptor): JsonObject {
  return {
    id: descriptor.id,
    source: descriptor.source,
    connectorKey: descriptor.connectorKey,
    mimeType: descriptor.mimeType,
    sizeBytes: descriptor.sizeBytes,
    localPath: descriptor.localPath,
    originalFilename: descriptor.originalFilename ?? null,
    metadata: descriptor.metadata ?? null,
    createdAt: descriptor.createdAt,
  };
}

export function extractWhatsAppMessageText(message: WAMessage): string {
  const content = normalizeMessageContent(message.message);
  return (
    trimMaybeValue(content?.conversation)
    ?? trimMaybeValue(content?.extendedTextMessage?.text)
    ?? trimMaybeValue(content?.imageMessage?.caption)
    ?? trimMaybeValue(content?.videoMessage?.caption)
    ?? trimMaybeValue(content?.documentMessage?.caption)
    ?? ""
  );
}

export function extractWhatsAppQuotedMessageId(message: WAMessage): string | undefined {
  const content = normalizeMessageContent(message.message);
  return (
    trimMaybeValue(content?.extendedTextMessage?.contextInfo?.stanzaId)
    ?? trimMaybeValue(content?.imageMessage?.contextInfo?.stanzaId)
    ?? trimMaybeValue(content?.videoMessage?.contextInfo?.stanzaId)
    ?? trimMaybeValue(content?.documentMessage?.contextInfo?.stanzaId)
    ?? trimMaybeValue(content?.audioMessage?.contextInfo?.stanzaId)
  );
}

export function buildWhatsAppInboundText(options: WhatsAppInboundTextOptions): string {
  const trimmedText = options.text?.trim() ?? "";
  const headerLines = [
    "<panda-channel-context>",
    `channel: ${WHATSAPP_SOURCE}`,
    `connector_key: ${options.connectorKey}`,
    `conversation_id: ${options.externalConversationId}`,
    `actor_id: ${options.externalActorId}`,
    `external_message_id: ${options.externalMessageId}`,
    `remote_jid: ${options.remoteJid}`,
    `chat_type: ${options.chatType}`,
    `push_name: ${formatMaybeValue(options.pushName)}`,
    `quoted_message_id: ${formatMaybeValue(options.quotedMessageId)}`,
    "attachments:",
    ...(options.media.length === 0
      ? ["- none"]
      : options.media.map((descriptor) => describeMediaDescriptor(descriptor))),
    "</panda-channel-context>",
  ];

  return [
    ...headerLines,
    "",
    trimmedText || "[WhatsApp message]",
  ].join("\n");
}

export function buildWhatsAppInboundMetadata(options: WhatsAppInboundMetadataOptions): JsonObject {
  return {
    route: {
      source: WHATSAPP_SOURCE,
      connectorKey: options.connectorKey,
      externalConversationId: options.externalConversationId,
      externalActorId: options.externalActorId,
      externalMessageId: options.externalMessageId,
    },
    whatsapp: {
      remoteJid: options.remoteJid,
      chatType: options.chatType,
      messageId: options.externalMessageId,
      pushName: options.pushName ?? null,
      quotedMessageId: options.quotedMessageId ?? null,
      media: options.media.map((descriptor) => serializeMediaDescriptor(descriptor)),
    },
  };
}
