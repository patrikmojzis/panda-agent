import type {BaileysEventMap, WAMessage} from "baileys";
import {jidNormalizedUser} from "baileys";
import {normalizeMessageContent} from "baileys/lib/Utils/messages.js";

import type {MediaDescriptor} from "../../../domain/channels/types.js";
import {
  discardStagedMediaDescriptors,
  type MediaReceiptOwner,
} from "../../../domain/channels/media-store.js";
import type {
  CreateRuntimeRequestInput,
  RuntimeRequestKind,
  RuntimeRequestStatus,
  WhatsAppAuthorizationSnapshot,
} from "../../../domain/threads/requests/types.js";
import {deriveRuntimeRequestIngressIdempotencyKey} from "../../../domain/threads/requests/ordering-key.js";
import {
  describeWhatsAppMessageShape,
  extractWhatsAppMessageText,
  extractWhatsAppQuotedMessageId,
  extractWhatsAppReaction,
  readWhatsAppMessageSentAtMs,
  resolveWhatsAppChatType,
} from "./helpers.js";
import type {WhatsAppActorAuthorization} from "./authorization.js";
import {WhatsAppMediaPolicyError} from "./media-work-queue.js";

type WhatsAppIngestedRequestKind = Extract<RuntimeRequestKind, "whatsapp_message" | "whatsapp_reaction">;

export interface WhatsAppMessageRequestQueue {
  enqueueRequest(
    input: CreateRuntimeRequestInput<WhatsAppIngestedRequestKind>,
    options?: {idempotencyKey?: string},
  ): Promise<{id: string; status?: RuntimeRequestStatus}>;
}

export interface WhatsAppMessageIngestionOptions {
  connectorKey: string;
  requests: WhatsAppMessageRequestQueue;
  authorizeActor(externalActorId: string): Promise<WhatsAppActorAuthorization>;
  downloadMedia(message: WAMessage, receiptOwner: MediaReceiptOwner): Promise<readonly MediaDescriptor[]>;
  log(event: string, payload: Record<string, unknown>): void;
}

interface WhatsAppMessageEnvelope {
  externalConversationId: string | null;
  externalActorId: string | null;
  externalMessageId: string | null;
  remoteJid: string | null;
  chatType: ReturnType<typeof resolveWhatsAppChatType>;
}

function snapshotAuthorization(
  authorization: Extract<WhatsAppActorAuthorization, {authorized: true}>,
): WhatsAppAuthorizationSnapshot {
  return {
    identityId: authorization.identityId,
    agentKey: authorization.agentKey,
    actorBindingId: authorization.actorBindingId,
    authorizationVersion: authorization.authorizationVersion,
  };
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

  const authorization = await options.authorizeActor(envelope.externalActorId);
  if (!authorization.authorized) {
    options.log("message_dropped", {
      connectorKey: options.connectorKey,
      externalConversationId: envelope.externalConversationId,
      externalActorId: envelope.externalActorId,
      chatType: envelope.chatType,
      reason: authorization.reason,
    });
    return;
  }

  const sentAt = readWhatsAppMessageSentAtMs(message.messageTimestamp);
  const reaction = extractWhatsAppReaction(message);
  if (reaction) {
    const request = await options.requests.enqueueRequest({
      kind: "whatsapp_reaction",
      payload: {
        identityId: authorization.identityId,
        authorization: snapshotAuthorization(authorization),
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
    }, {idempotencyKey: deriveRuntimeRequestIngressIdempotencyKey({
      kind: "whatsapp_reaction",
      connectorKey: options.connectorKey,
      externalEventScope: envelope.externalConversationId,
      externalEventId: envelope.externalMessageId,
    })});

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

  const requestIdempotencyKey = deriveRuntimeRequestIngressIdempotencyKey({
    kind: "whatsapp_message",
    connectorKey: options.connectorKey,
    externalEventScope: envelope.externalConversationId,
    externalEventId: envelope.externalMessageId,
  });
  const rawText = extractWhatsAppMessageText(message);
  let media: readonly MediaDescriptor[];
  try {
    media = await options.downloadMedia(message, {
      requestKind: "whatsapp_message",
      requestIdempotencyKey,
    });
  } catch (error) {
    if (!(error instanceof WhatsAppMediaPolicyError)) throw error;
    options.log("message_dropped", {
      connectorKey: options.connectorKey,
      externalConversationId: envelope.externalConversationId,
      externalActorId: envelope.externalActorId,
      chatType: envelope.chatType,
      reason: error.reason,
    });
    return;
  }
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
  let request: Awaited<ReturnType<WhatsAppMessageRequestQueue["enqueueRequest"]>>;
  try {
    request = await options.requests.enqueueRequest({
      kind: "whatsapp_message",
      payload: {
        identityId: authorization.identityId,
        authorization: snapshotAuthorization(authorization),
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
    }, {idempotencyKey: requestIdempotencyKey});
  } catch (error) {
    try {
      await discardStagedMediaDescriptors(media);
    } catch (cleanupError) {
      options.log("media_cleanup_failed", {
        connectorKey: options.connectorKey,
        externalMessageId: envelope.externalMessageId,
        message: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    }
    throw error;
  }
  if (request.status === "completed" || request.status === "failed") {
    try {
      await discardStagedMediaDescriptors(media);
    } catch (cleanupError) {
      options.log("media_cleanup_failed", {
        connectorKey: options.connectorKey,
        externalMessageId: envelope.externalMessageId,
        message: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    }
  }

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
