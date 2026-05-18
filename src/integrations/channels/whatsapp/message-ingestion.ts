import type {BaileysEventMap, WAMessage} from "baileys";
import {jidNormalizedUser} from "baileys";
import {normalizeMessageContent} from "baileys/lib/Utils/messages.js";

import type {MediaDescriptor} from "../../../domain/channels/types.js";
import type {CreateRuntimeRequestInput, RuntimeRequestKind} from "../../../domain/threads/requests/types.js";
import {
  describeWhatsAppMessageShape,
  extractWhatsAppMessageText,
  extractWhatsAppQuotedMessageId,
  extractWhatsAppReaction,
  readWhatsAppMessageSentAtMs,
  resolveWhatsAppChatType,
} from "./helpers.js";

type WhatsAppIngestedRequestKind = Extract<RuntimeRequestKind, "whatsapp_message" | "whatsapp_reaction">;

export interface WhatsAppMessageRequestQueue {
  enqueueRequest(
    input: CreateRuntimeRequestInput<WhatsAppIngestedRequestKind>,
  ): Promise<{id: string}>;
}

export interface WhatsAppMessageIngestionOptions {
  connectorKey: string;
  requests: WhatsAppMessageRequestQueue;
  downloadMedia(message: WAMessage): Promise<readonly MediaDescriptor[]>;
  log(event: string, payload: Record<string, unknown>): void;
}

interface WhatsAppMessageEnvelope {
  externalConversationId: string | null;
  externalActorId: string | null;
  externalMessageId: string | null;
  remoteJid: string | null;
  chatType: ReturnType<typeof resolveWhatsAppChatType>;
}

function buildWhatsAppMessageEnvelope(message: WAMessage): WhatsAppMessageEnvelope {
  const remoteJid = message.key.remoteJid ?? null;
  const externalConversationId = remoteJid ? jidNormalizedUser(remoteJid) : null;
  return {
    remoteJid,
    externalConversationId,
    externalActorId: message.key.participant
      ? jidNormalizedUser(message.key.participant)
      : externalConversationId,
    externalMessageId: message.key.id?.trim() || null,
    chatType: resolveWhatsAppChatType(remoteJid ?? undefined),
  };
}

function isReactionRemoval(message: WAMessage): boolean {
  return Boolean(normalizeMessageContent(message.message)?.reactionMessage);
}

async function ingestWhatsAppMessage(
  message: WAMessage,
  options: WhatsAppMessageIngestionOptions,
): Promise<void> {
  const envelope = buildWhatsAppMessageEnvelope(message);

  if (message.key.fromMe) {
    options.log("message_ignored", {
      connectorKey: options.connectorKey,
      externalConversationId: envelope.externalConversationId,
      externalActorId: envelope.externalActorId,
      chatType: envelope.chatType,
      reason: "own_message",
    });
    return;
  }

  if (!envelope.remoteJid || !envelope.externalConversationId || !envelope.externalActorId || !envelope.externalMessageId) {
    options.log("message_dropped", {
      connectorKey: options.connectorKey,
      externalConversationId: envelope.externalConversationId,
      externalActorId: envelope.externalActorId,
      chatType: envelope.chatType,
      reason: "missing_actor_conversation_or_message",
    });
    return;
  }

  if (envelope.chatType !== "private") {
    options.log("message_dropped", {
      connectorKey: options.connectorKey,
      externalConversationId: envelope.externalConversationId,
      externalActorId: envelope.externalActorId,
      chatType: envelope.chatType,
      reason: "group_support_not_enabled",
    });
    return;
  }

  const sentAt = readWhatsAppMessageSentAtMs(message.messageTimestamp);
  const reaction = extractWhatsAppReaction(message);
  if (reaction) {
    const request = await options.requests.enqueueRequest({
      kind: "whatsapp_reaction",
      payload: {
        connectorKey: options.connectorKey,
        sentAt,
        externalConversationId: envelope.externalConversationId,
        externalActorId: envelope.externalActorId,
        externalMessageId: envelope.externalMessageId,
        remoteJid: envelope.remoteJid,
        chatType: envelope.chatType,
        targetMessageId: reaction.targetMessageId,
        emoji: reaction.emoji,
        pushName: message.pushName ?? undefined,
      },
    });

    options.log("reaction_ingested", {
      connectorKey: options.connectorKey,
      externalConversationId: envelope.externalConversationId,
      externalActorId: envelope.externalActorId,
      chatType: envelope.chatType,
      externalMessageId: envelope.externalMessageId,
      targetMessageId: reaction.targetMessageId,
      emoji: reaction.emoji,
      requestId: request.id,
    });
    return;
  }

  if (isReactionRemoval(message)) {
    options.log("reaction_ignored", {
      connectorKey: options.connectorKey,
      externalConversationId: envelope.externalConversationId,
      externalActorId: envelope.externalActorId,
      chatType: envelope.chatType,
      externalMessageId: envelope.externalMessageId,
      reason: "empty_reaction",
    });
    return;
  }

  const rawText = extractWhatsAppMessageText(message);
  const media = await options.downloadMedia(message);
  if (!rawText && media.length === 0) {
    options.log("message_dropped", {
      connectorKey: options.connectorKey,
      externalConversationId: envelope.externalConversationId,
      externalActorId: envelope.externalActorId,
      chatType: envelope.chatType,
      reason: "unsupported_message_shape",
      messageShape: describeWhatsAppMessageShape(message),
    });
    return;
  }

  const quotedMessageId = extractWhatsAppQuotedMessageId(message);
  const request = await options.requests.enqueueRequest({
    kind: "whatsapp_message",
    payload: {
      connectorKey: options.connectorKey,
      sentAt,
      externalConversationId: envelope.externalConversationId,
      externalActorId: envelope.externalActorId,
      externalMessageId: envelope.externalMessageId,
      remoteJid: envelope.remoteJid,
      chatType: envelope.chatType,
      text: rawText,
      pushName: message.pushName ?? undefined,
      quotedMessageId,
      media,
    },
  });

  options.log("message_ingested", {
    connectorKey: options.connectorKey,
    externalConversationId: envelope.externalConversationId,
    externalActorId: envelope.externalActorId,
    chatType: envelope.chatType,
    externalMessageId: envelope.externalMessageId,
    mediaCount: media.length,
    textLength: rawText.length,
    requestId: request.id,
  });
}

export async function ingestWhatsAppMessagesUpsert(
  update: BaileysEventMap["messages.upsert"],
  options: WhatsAppMessageIngestionOptions,
): Promise<void> {
  if (update.type !== "notify") {
    options.log("message_ignored", {
      connectorKey: options.connectorKey,
      reason: "non_notify_upsert",
      upsertType: update.type,
      messageCount: update.messages.length,
    });
    return;
  }

  for (const message of update.messages) {
    await ingestWhatsAppMessage(message, options);
  }
}
