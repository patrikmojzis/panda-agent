import type {WAMessage} from "baileys";
import {normalizeMessageContent} from "baileys/lib/Utils/messages.js";

import type {JsonObject} from "../../../kernel/agent/types.js";
import type {MediaDescriptor} from "../../../domain/channels/types.js";
import {renderWhatsAppInboundText, renderWhatsAppReactionText} from "../../../prompts/channels/whatsapp.js";
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

export interface WhatsAppReactionTextOptions {
  connectorKey: string;
  sentAt?: string;
  externalConversationId: string;
  externalActorId: string;
  externalMessageId: string;
  identityHandle?: string;
  remoteJid: string;
  chatType: string;
  pushName?: string;
  targetMessageId: string;
  emoji: string;
}

export interface WhatsAppReactionMetadataOptions {
  connectorKey: string;
  sentAt?: string;
  externalConversationId: string;
  externalActorId: string;
  externalMessageId: string;
  remoteJid: string;
  chatType: string;
  pushName?: string;
  targetMessageId: string;
  emoji: string;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function renderWhatsAppContact(input: {
  displayName?: string | null;
  vcard?: string | null;
}, index?: number): string {
  const lines = [
    index === undefined ? "WhatsApp contact:" : `WhatsApp contact ${index + 1}:`,
    `name: ${trimToUndefined(input.displayName ?? undefined) ?? "unknown"}`,
  ];
  const vcard = trimToUndefined(input.vcard ?? undefined);
  if (vcard) {
    lines.push("vcard:", vcard);
  }

  return lines.join("\n");
}

function renderWhatsAppLocation(input: {
  name?: string | null;
  address?: string | null;
  degreesLatitude?: unknown;
  degreesLongitude?: unknown;
  url?: string | null;
}, kind: "location" | "live location"): string {
  const latitude = readFiniteNumber(input.degreesLatitude);
  const longitude = readFiniteNumber(input.degreesLongitude);
  const mapUrl = latitude === undefined || longitude === undefined
    ? undefined
    : `https://maps.google.com/?q=${latitude},${longitude}`;

  return [
    `WhatsApp ${kind}:`,
    `name: ${trimToUndefined(input.name ?? undefined) ?? "unknown"}`,
    `address: ${trimToUndefined(input.address ?? undefined) ?? "unknown"}`,
    latitude === undefined ? undefined : `latitude: ${latitude}`,
    longitude === undefined ? undefined : `longitude: ${longitude}`,
    `map: ${trimToUndefined(input.url ?? undefined) ?? mapUrl ?? "unknown"}`,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function extractWhatsAppStructuredText(message: WAMessage): string {
  const content = normalizeMessageContent(message.message);
  const parts: string[] = [];

  if (content?.contactMessage) {
    parts.push(renderWhatsAppContact(content.contactMessage));
  }

  const contacts = content?.contactsArrayMessage?.contacts ?? [];
  for (const [index, contact] of contacts.entries()) {
    parts.push(renderWhatsAppContact(contact, index));
  }

  if (content?.locationMessage) {
    parts.push(renderWhatsAppLocation(content.locationMessage, "location"));
  }

  if (content?.liveLocationMessage) {
    parts.push(renderWhatsAppLocation(content.liveLocationMessage, "live location"));
  }

  return parts.join("\n\n");
}

export function extractWhatsAppMessageText(message: WAMessage): string {
  const content = normalizeMessageContent(message.message);
  const text = (
    trimToUndefined(content?.conversation)
    ?? trimToUndefined(content?.extendedTextMessage?.text)
    ?? trimToUndefined(content?.imageMessage?.caption)
    ?? trimToUndefined(content?.videoMessage?.caption)
    ?? trimToUndefined(content?.documentMessage?.caption)
    ?? ""
  );
  const structuredText = extractWhatsAppStructuredText(message);
  return [text, structuredText].filter(Boolean).join("\n\n");
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

export function describeWhatsAppMessageShape(message: WAMessage): string {
  const content = normalizeMessageContent(message.message);
  if (!content) {
    return "empty";
  }

  const keys = Object.keys(content).filter((key) => key !== "messageContextInfo");
  return keys.length === 0 ? "unknown" : keys.join(",");
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

export function buildWhatsAppReactionText(options: WhatsAppReactionTextOptions): string {
  return renderWhatsAppReactionText({
    connectorKey: options.connectorKey,
    sentAt: options.sentAt,
    conversationId: options.externalConversationId,
    actorId: options.externalActorId,
    externalMessageId: options.externalMessageId,
    identityHandle: options.identityHandle,
    remoteJid: options.remoteJid,
    chatType: options.chatType,
    pushName: options.pushName,
    targetMessageId: options.targetMessageId,
    emoji: options.emoji,
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

export function buildWhatsAppReactionMetadata(options: WhatsAppReactionMetadataOptions): JsonObject {
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
      media: [],
      reaction: {
        targetMessageId: options.targetMessageId,
        emoji: options.emoji,
        actorId: options.externalActorId,
      },
    },
  };
}
