import type {JsonObject} from "../../../kernel/agent/types.js";
import type {MediaDescriptor, RememberedRoute} from "../../../domain/channels/types.js";
import {renderTelegramInboundText, renderTelegramReactionText,} from "../../../prompts/channels/telegram.js";
import {TELEGRAM_SOURCE} from "./config.js";
import {describeMediaDescriptor, serializeMediaDescriptor} from "../media-shared.js";

export interface TelegramInboundTextOptions {
  connectorKey: string;
  externalConversationId: string;
  externalActorId: string;
  externalMessageId: string;
  identityId?: string;
  identityHandle?: string;
  chatId: string;
  chatType: string;
  text?: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  replyToMessageId?: string;
  media: readonly MediaDescriptor[];
}

export interface TelegramReactionTextOptions {
  connectorKey: string;
  externalConversationId: string;
  externalActorId: string;
  externalMessageId: string;
  identityId?: string;
  identityHandle?: string;
  chatId: string;
  chatType: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  targetMessageId: string;
  addedEmojis: readonly string[];
}

export interface TelegramReactionMetadataOptions {
  updateId: number;
  targetMessageId: string;
  addedEmojis: readonly string[];
  actorId: string;
  username?: string | null;
}

export interface TelegramInboundPersistenceOptions {
  connectorKey: string;
  externalConversationId: string;
  externalActorId: string;
  externalMessageId: string;
  chatId: string;
  chatType: string;
  messageId: number | null;
  username?: string;
  firstName?: string;
  lastName?: string;
  media: readonly MediaDescriptor[];
  reaction?: TelegramReactionMetadataOptions;
}

export function buildTelegramConversationId(chatId: string | number, messageThreadId?: string | number): string {
  const base = String(chatId);
  return messageThreadId === undefined ? base : `${base}:${String(messageThreadId)}`;
}

export function normalizeTelegramCommand(commandText: string | undefined, botUsername?: string | null): string | null {
  if (typeof commandText !== "string") {
    return null;
  }

  const firstToken = commandText.trim().split(/\s+/, 1)[0];
  if (!firstToken?.startsWith("/")) {
    return null;
  }

  const withoutSlash = firstToken.slice(1);
  const [command, mention] = withoutSlash.split("@", 2);
  if (!command) {
    return null;
  }

  if (mention && botUsername && mention.toLowerCase() !== botUsername.toLowerCase()) {
    return null;
  }

  return command.toLowerCase();
}

export function buildTelegramPairCommand(
  actorId: string,
  identityHandle = "<identity-handle>",
): string {
  return `panda telegram pair --identity ${identityHandle} --actor ${actorId}`;
}

export function buildTelegramInboundPersistence(
  options: TelegramInboundPersistenceOptions,
): {
  metadata: JsonObject;
  rememberedRoute: RememberedRoute;
} {
  return {
    metadata: {
      route: {
        source: TELEGRAM_SOURCE,
        connectorKey: options.connectorKey,
        externalConversationId: options.externalConversationId,
        externalActorId: options.externalActorId,
        externalMessageId: options.externalMessageId,
      },
      telegram: {
        chatId: options.chatId,
        chatType: options.chatType,
        messageId: options.messageId,
        username: options.username ?? null,
        firstName: options.firstName ?? null,
        lastName: options.lastName ?? null,
        media: options.media.map((descriptor) => serializeMediaDescriptor(descriptor)),
        ...(options.reaction
          ? {
            reaction: {
              updateId: options.reaction.updateId,
              targetMessageId: options.reaction.targetMessageId,
              addedEmojis: [...options.reaction.addedEmojis],
              actorId: options.reaction.actorId,
              username: options.reaction.username ?? null,
            },
          }
          : {}),
      },
    },
    rememberedRoute: {
      source: TELEGRAM_SOURCE,
      connectorKey: options.connectorKey,
      externalConversationId: options.externalConversationId,
      externalActorId: options.externalActorId,
      externalMessageId: options.externalMessageId,
      capturedAt: Date.now(),
    },
  };
}

export function buildTelegramInboundText(options: TelegramInboundTextOptions): string {
  return renderTelegramInboundText({
    connectorKey: options.connectorKey,
    conversationId: options.externalConversationId,
    actorId: options.externalActorId,
    externalMessageId: options.externalMessageId,
    identityId: options.identityId,
    identityHandle: options.identityHandle,
    chatId: options.chatId,
    chatType: options.chatType,
    username: options.username,
    firstName: options.firstName,
    lastName: options.lastName,
    replyToMessageId: options.replyToMessageId,
    attachments: options.media.map((descriptor) => describeMediaDescriptor(descriptor)),
    body: options.text,
  });
}

export function buildTelegramReactionText(options: TelegramReactionTextOptions): string {
  return renderTelegramReactionText({
    connectorKey: options.connectorKey,
    conversationId: options.externalConversationId,
    actorId: options.externalActorId,
    externalMessageId: options.externalMessageId,
    identityId: options.identityId,
    identityHandle: options.identityHandle,
    chatId: options.chatId,
    chatType: options.chatType,
    username: options.username,
    firstName: options.firstName,
    lastName: options.lastName,
    targetMessageId: options.targetMessageId,
    addedEmojis: options.addedEmojis,
  });
}
