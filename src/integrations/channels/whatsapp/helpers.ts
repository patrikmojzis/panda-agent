import type {WAMessage} from "baileys";
import {normalizeMessageContent} from "baileys/lib/Utils/messages.js";

import type {JsonObject} from "../../../kernel/agent/types.js";
import type {MediaDescriptor} from "../../../domain/channels/types.js";
import {renderWhatsAppInboundText} from "../../../prompts/channels/whatsapp.js";
import {WHATSAPP_SOURCE} from "./config.js";
import {describeMediaDescriptor, serializeMediaDescriptor} from "../media-shared.js";
import {trimToUndefined} from "../../../lib/strings.js";

export interface WhatsAppInboundTextOptions {
  connectorKey: string;
  sentAt?: string;
  externalConversationId: string;
  externalActorId: string;
  externalMessageId: string;
  identityHandle?: string;
  remoteJid: string;
  chatType: string;
  text?: string;
  pushName?: string;
  quotedMessageId?: string;
  media: readonly MediaDescriptor[];
}

export interface WhatsAppInboundMetadataOptions {
  connectorKey: string;
  sentAt?: string;
  externalConversationId: string;
  externalActorId: string;
  externalMessageId: string;
  remoteJid: string;
  chatType: string;
  pushName?: string;
  quotedMessageId?: string;
  media: readonly MediaDescriptor[];
}

export function extractWhatsAppMessageText(message: WAMessage): string {
  const content = normalizeMessageContent(message.message);
  return (
    trimToUndefined(content?.conversation)
    ?? trimToUndefined(content?.extendedTextMessage?.text)
    ?? trimToUndefined(content?.imageMessage?.caption)
    ?? trimToUndefined(content?.videoMessage?.caption)
    ?? trimToUndefined(content?.documentMessage?.caption)
    ?? ""
  );
}

export function extractWhatsAppQuotedMessageId(message: WAMessage): string | undefined {
  const content = normalizeMessageContent(message.message);
  return (
    trimToUndefined(content?.extendedTextMessage?.contextInfo?.stanzaId)
    ?? trimToUndefined(content?.imageMessage?.contextInfo?.stanzaId)
    ?? trimToUndefined(content?.videoMessage?.contextInfo?.stanzaId)
    ?? trimToUndefined(content?.documentMessage?.contextInfo?.stanzaId)
    ?? trimToUndefined(content?.audioMessage?.contextInfo?.stanzaId)
  );
}

export function buildWhatsAppInboundText(options: WhatsAppInboundTextOptions): string {
  return renderWhatsAppInboundText({
    channel: WHATSAPP_SOURCE,
    connectorKey: options.connectorKey,
    sentAt: options.sentAt,
    conversationId: options.externalConversationId,
    actorId: options.externalActorId,
    externalMessageId: options.externalMessageId,
    identityHandle: options.identityHandle,
    remoteJid: options.remoteJid,
    chatType: options.chatType,
    pushName: options.pushName,
    quotedMessageId: options.quotedMessageId,
    attachments: options.media.map((descriptor) => describeMediaDescriptor(descriptor)),
    body: options.text,
  });
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
      sentAt: options.sentAt ?? null,
      remoteJid: options.remoteJid,
      chatType: options.chatType,
      messageId: options.externalMessageId,
      pushName: options.pushName ?? null,
      quotedMessageId: options.quotedMessageId ?? null,
      media: options.media.map((descriptor) => serializeMediaDescriptor(descriptor)),
    },
  };
}
