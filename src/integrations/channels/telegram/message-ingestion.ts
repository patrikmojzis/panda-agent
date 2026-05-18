import type {Context} from "grammy";

import type {CreateRuntimeRequestInput, RuntimeRequestKind} from "../../../domain/threads/requests/types.js";
import {buildTelegramConversationId} from "./helpers.js";
import {
  describeTelegramMessageShape,
  extractTelegramMessageText,
  readTelegramSentAtMs,
} from "./message-content.js";
import {
  mergeTextWithUnavailableMediaNotice,
  type TelegramMediaDownloadResult,
} from "./media.js";
import {extractAddedTelegramReactionEmojis} from "./reactions.js";

type TelegramContext = Context;
type TelegramIngestedRequestKind = Extract<RuntimeRequestKind, "telegram_message" | "telegram_reaction">;

interface TelegramMessageRequestQueue {
  enqueueRequest(
    input: CreateRuntimeRequestInput<TelegramIngestedRequestKind>,
  ): Promise<{id: string}>;
}

interface TelegramMessageIngestionOptions {
  connectorKey: string;
  botUsername: string | null;
  requests: TelegramMessageRequestQueue;
  downloadMedia(message: TelegramContext["msg"]): Promise<TelegramMediaDownloadResult>;
  log(event: string, payload: Record<string, unknown>): void;
}

interface TelegramReactionUpdateUser {
  id?: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  is_bot?: boolean;
}

export interface TelegramReactionContextLike {
  update?: {
    update_id?: number;
  };
  messageReaction?: {
    chat: {
      id: number;
      type?: string;
    };
    message_id: number;
    user?: TelegramReactionUpdateUser;
    old_reaction: readonly unknown[];
    new_reaction: readonly unknown[];
  };
}

interface TelegramReactionIngestionOptions {
  connectorKey: string;
  requests: TelegramMessageRequestQueue;
  log(event: string, payload: Record<string, unknown>): void;
}

export async function ingestTelegramMessageReaction(
  ctx: TelegramReactionContextLike,
  options: TelegramReactionIngestionOptions,
): Promise<void> {
  const reaction = ctx.messageReaction;
  const chatId = reaction?.chat.id;
  const chatType = reaction?.chat.type ?? null;
  const updateId = ctx.update?.update_id;
  const actorId = reaction?.user?.id != null ? String(reaction.user.id) : null;
  const externalConversationId = buildTelegramConversationId(
    String(chatId ?? "unknown"),
  );

  if (!reaction || typeof chatId !== "number") {
    options.log("reaction_dropped", {
      connectorKey: options.connectorKey,
      externalActorId: actorId,
      externalConversationId,
      chatType,
      reason: "missing_reaction_payload",
    });
    return;
  }

  if (chatType !== "private") {
    options.log("reaction_dropped", {
      connectorKey: options.connectorKey,
      externalActorId: actorId,
      externalConversationId,
      chatType,
      reason: "group_support_not_enabled",
    });
    return;
  }

  if (typeof updateId !== "number" || !Number.isInteger(updateId)) {
    options.log("reaction_dropped", {
      connectorKey: options.connectorKey,
      externalActorId: actorId,
      externalConversationId,
      chatType,
      reason: "missing_update_id",
    });
    return;
  }

  if (!actorId) {
    options.log("reaction_dropped", {
      connectorKey: options.connectorKey,
      externalActorId: actorId,
      externalConversationId,
      chatType,
      reason: "missing_actor",
    });
    return;
  }

  if (reaction.user?.is_bot) {
    options.log("reaction_dropped", {
      connectorKey: options.connectorKey,
      externalActorId: actorId,
      externalConversationId,
      chatType,
      reason: "bot_actor",
    });
    return;
  }

  const addedEmojis = extractAddedTelegramReactionEmojis(reaction.old_reaction, reaction.new_reaction);

  if (addedEmojis.length === 0) {
    return;
  }

  const request = await options.requests.enqueueRequest({
    kind: "telegram_reaction",
    payload: {
      connectorKey: options.connectorKey,
      externalConversationId,
      chatId: String(chatId),
      chatType: chatType ?? "private",
      externalActorId: actorId,
      updateId,
      targetMessageId: String(reaction.message_id),
      addedEmojis,
      username: reaction.user?.username,
      firstName: reaction.user?.first_name,
      lastName: reaction.user?.last_name,
    },
  });

  options.log("reaction_ingested", {
    connectorKey: options.connectorKey,
    externalActorId: actorId,
    externalConversationId,
    chatType,
    updateId,
    requestId: request.id,
    targetMessageId: String(reaction.message_id),
    addedEmojis,
  });
}

export async function ingestTelegramMessage(
  ctx: TelegramContext,
  options: TelegramMessageIngestionOptions,
): Promise<void> {
  const message = ctx.msg;
  const chatType = ctx.chat?.type ?? null;
  const actorId = ctx.from?.id ? String(ctx.from.id) : null;
  const externalConversationId = buildTelegramConversationId(
    String(ctx.chat?.id ?? "unknown"),
    message && "message_thread_id" in message && typeof message.message_thread_id === "number"
      ? String(message.message_thread_id)
      : undefined,
  );

  if (chatType !== "private") {
    options.log("message_dropped", {
      connectorKey: options.connectorKey,
      externalActorId: actorId,
      externalConversationId,
      chatType,
      reason: "group_support_not_enabled",
    });
    return;
  }

  if (!message || !actorId) {
    options.log("message_dropped", {
      connectorKey: options.connectorKey,
      externalActorId: actorId,
      externalConversationId,
      chatType,
      reason: "missing_actor_or_message",
    });
    return;
  }

  const mediaDownload = await options.downloadMedia(message);
  const rawText = extractTelegramMessageText(message);
  const text = mergeTextWithUnavailableMediaNotice(rawText, mediaDownload.unavailable);
  if (!text && mediaDownload.media.length === 0) {
    options.log("message_dropped", {
      connectorKey: options.connectorKey,
      externalActorId: actorId,
      externalConversationId,
      chatType,
      reason: "unsupported_message_shape",
      messageShape: describeTelegramMessageShape(message),
    });
    return;
  }

  const request = await options.requests.enqueueRequest({
    kind: "telegram_message",
    payload: {
      connectorKey: options.connectorKey,
      botUsername: options.botUsername,
      sentAt: readTelegramSentAtMs(message),
      externalConversationId,
      chatId: String(message.chat.id),
      chatType: chatType ?? "private",
      externalActorId: actorId,
      externalMessageId: String(message.message_id),
      text,
      username: ctx.from?.username,
      firstName: ctx.from?.first_name,
      lastName: ctx.from?.last_name,
      replyToMessageId: message.reply_to_message?.message_id
        ? String(message.reply_to_message.message_id)
        : undefined,
      media: mediaDownload.media,
    },
  });

  options.log("message_ingested", {
    connectorKey: options.connectorKey,
    externalActorId: actorId,
    externalConversationId,
    chatType,
    externalMessageId: String(message.message_id),
    mediaCount: mediaDownload.media.length,
    unavailableMediaCount: mediaDownload.unavailable.length,
    textLength: rawText.length,
    requestId: request.id,
  });
}
