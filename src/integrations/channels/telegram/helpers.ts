import path from "node:path";

import type {JsonObject} from "../../../kernel/agent/types.js";
import type {MediaDescriptor, RememberedRoute} from "../../../domain/channels/types.js";
import {TELEGRAM_SOURCE} from "./config.js";

export interface TelegramInboundTextOptions {
  connectorKey: string;
  externalConversationId: string;
  externalActorId: string;
  externalMessageId: string;
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
  identityHandle = "local",
): string {
  return `panda telegram pair --identity ${identityHandle} --actor ${actorId}`;
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

function buildTelegramHeaderLines(options: {
  connectorKey: string;
  externalConversationId: string;
  externalActorId: string;
  externalMessageId: string;
  chatId: string;
  chatType: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  extraLines?: readonly string[];
  media: readonly MediaDescriptor[];
}): readonly string[] {
  return [
    "<panda-channel-context>",
    `channel: telegram`,
    `connector_key: ${options.connectorKey}`,
    `conversation_id: ${options.externalConversationId}`,
    `actor_id: ${options.externalActorId}`,
    `external_message_id: ${options.externalMessageId}`,
    `chat_id: ${options.chatId}`,
    `chat_type: ${options.chatType}`,
    `username: ${formatMaybeValue(options.username)}`,
    `first_name: ${formatMaybeValue(options.firstName)}`,
    `last_name: ${formatMaybeValue(options.lastName)}`,
    ...(options.extraLines ?? []),
    "attachments:",
    ...(options.media.length === 0
      ? ["- none"]
      : options.media.map((descriptor) => describeMediaDescriptor(descriptor))),
    "</panda-channel-context>",
  ];
}

export function buildTelegramInboundText(options: TelegramInboundTextOptions): string {
  const trimmedText = options.text?.trim() ?? "";
  const headerLines = buildTelegramHeaderLines({
    connectorKey: options.connectorKey,
    externalConversationId: options.externalConversationId,
    externalActorId: options.externalActorId,
    externalMessageId: options.externalMessageId,
    chatId: options.chatId,
    chatType: options.chatType,
    username: options.username,
    firstName: options.firstName,
    lastName: options.lastName,
    extraLines: [
      `reply_to_message_id: ${formatMaybeValue(options.replyToMessageId)}`,
    ],
    media: options.media,
  });

  return [
    ...headerLines,
    "",
    trimmedText || "[Telegram message]",
  ].join("\n");
}

export function buildTelegramReactionText(options: TelegramReactionTextOptions): string {
  const headerLines = buildTelegramHeaderLines({
    connectorKey: options.connectorKey,
    externalConversationId: options.externalConversationId,
    externalActorId: options.externalActorId,
    externalMessageId: options.externalMessageId,
    chatId: options.chatId,
    chatType: options.chatType,
    username: options.username,
    firstName: options.firstName,
    lastName: options.lastName,
    extraLines: [
      "reply_to_message_id: null",
      `reaction_target_message_id: ${options.targetMessageId}`,
      `reaction_added_emojis: ${options.addedEmojis.join(", ")}`,
      `reaction_actor_id: ${options.externalActorId}`,
      `reaction_actor_username: ${formatMaybeValue(options.username)}`,
    ],
    media: [],
  });

  return [
    ...headerLines,
    "",
    `Added reaction${options.addedEmojis.length === 1 ? "" : "s"}: ${options.addedEmojis.join(", ")}`,
  ].join("\n");
}
