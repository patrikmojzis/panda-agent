import {copyFile, mkdir, stat} from "node:fs/promises";
import path from "node:path";

import type {JsonObject, JsonValue} from "../../../lib/json.js";
import {isJsonObject} from "../../../lib/json.js";
import {isRecord} from "../../../lib/records.js";
import {trimToUndefined} from "../../../lib/strings.js";
import {assertPathReadable} from "../../../lib/fs.js";
import type {TelegramStickerStore} from "../../../domain/agents/telegram-stickers/store.js";
import {parseTelegramStickerLibraryRef} from "../../../domain/agents/telegram-stickers/types.js";
import type {OutboundDeliveryRecord, OutboundDeliveryTargetHistoryFilter} from "../../../domain/channels/deliveries/types.js";
import type {ChannelActionInput} from "../../../domain/channels/actions/types.js";
import {assertCurrentSessionConversationBinding, type ConversationBindingAuthorizer} from "../../../domain/channels/conversation-authority.js";
import {commandScopeDenied} from "../../../domain/commands/errors.js";
import type {OutboundDeliveryInput} from "../../../domain/channels/deliveries/types.js";
import type {MediaDescriptor, OutboundFileItem, OutboundImageItem, OutboundItem} from "../../../domain/channels/types.js";
import type {CommandFileResolver, CommandWritableFileResolver} from "../../../domain/commands/files.js";
import type {
  CommandArtifactDescriptor,
  CommandDescriptor,
  CommandRequest,
  CommandSuccess,
  RegisteredCommand,
} from "../../../domain/commands/types.js";
import type {ConnectorAccountListFilter, ConnectorAccountRecord} from "../../../domain/connectors/types.js";
import type {ConversationBinding, ConversationBindingListFilter} from "../../../domain/sessions/conversations/types.js";
import type {
  ThreadChannelMediaFilter,
  ThreadChannelMediaRecord,
  ThreadChannelMessageFilter,
  ThreadMessageRecord,
} from "../../../domain/threads/runtime/types.js";
import {TELEGRAM_SOURCE} from "./config.js";
import {parseTelegramConversationId} from "./conversation-id.js";
import {
  ALLOWED_TELEGRAM_REACTION_EMOJI_LIST,
  isAllowedTelegramReactionEmoji,
  parseTelegramReactionMessageId,
} from "./reactions.js";
import {readTelegramInboundSticker, serializeSafeTelegramSticker} from "./sticker-metadata.js";

export const TELEGRAM_REACT_COMMAND_NAME = "telegram.react";
export const TELEGRAM_EDIT_COMMAND_NAME = "telegram.edit";
export const TELEGRAM_DELETE_COMMAND_NAME = "telegram.delete";
export const TELEGRAM_PIN_COMMAND_NAME = "telegram.pin";
export const TELEGRAM_UNPIN_COMMAND_NAME = "telegram.unpin";
export const TELEGRAM_STICKER_SEND_COMMAND_NAME = "telegram.sticker.send";
export const TELEGRAM_SEND_COMMAND_NAME = "telegram.send";
export const TELEGRAM_CHAT_LIST_COMMAND_NAME = "telegram.chat.list";
export const TELEGRAM_CHAT_INFO_COMMAND_NAME = "telegram.chat.info";
export const TELEGRAM_HISTORY_COMMAND_NAME = "telegram.history";
export const TELEGRAM_MEDIA_FETCH_COMMAND_NAME = "telegram.media.fetch";

const MAX_TELEGRAM_SEND_ITEMS = 10;
const DEFAULT_TELEGRAM_HISTORY_LIMIT = 20;
const MAX_TELEGRAM_HISTORY_LIMIT = 100;

type TelegramActionTarget = JsonObject & {
  connectorKey: string;
  conversationId: string;
};

export type TelegramReactCommandCurrentInput = JsonObject & {
  source: string;
  channelId?: string;
  externalMessageId?: string;
  metadata?: JsonValue;
};

export type TelegramReactCommandInput = JsonObject & {
  emoji?: string;
  remove?: boolean;
  messageId?: string;
  target?: TelegramActionTarget;
  currentInput?: TelegramReactCommandCurrentInput;
};

export type TelegramEditCommandInput = JsonObject & {
  connectorKey: string;
  conversationId: string;
  messageId: string;
  text: string;
};

export type TelegramDeleteCommandInput = JsonObject & {
  connectorKey: string;
  conversationId: string;
  messageId: string;
};

export type TelegramPinCommandInput = JsonObject & {
  connectorKey: string;
  conversationId: string;
  messageId: string;
  silent?: boolean;
};

export type TelegramUnpinCommandInput = JsonObject & {
  connectorKey: string;
  conversationId: string;
  messageId: string;
};

export type TelegramStickerSendCommandInput = JsonObject & {
  connectorKey: string;
  conversationId: string;
  filePath?: string;
  fileId?: string;
  stickerRef?: string;
};

type TelegramHistoryDirection = "inbound" | "outbound" | "all";

export type TelegramHistoryCommandInput = JsonObject & {
  connectorKey?: string;
  conversationId: string;
  direction?: TelegramHistoryDirection;
  limit?: number;
};

export type TelegramMediaFetchCommandInput = JsonObject & {
  connectorKey?: string;
  conversationId: string;
  mediaId: string;
  save?: string;
  overwrite?: boolean;
};

export interface TelegramReactCommandQueue extends ConversationBindingAuthorizer {
  enqueueAction(input: ChannelActionInput<"telegram_reaction">): Promise<unknown>;
}

export interface TelegramEditCommandQueue extends ConversationBindingAuthorizer {
  enqueueAction(input: ChannelActionInput<"telegram_edit">): Promise<unknown>;
}

export interface TelegramDeleteCommandQueue extends ConversationBindingAuthorizer {
  enqueueAction(input: ChannelActionInput<"telegram_delete">): Promise<unknown>;
}

export interface TelegramPinCommandQueue extends ConversationBindingAuthorizer {
  enqueueAction(input: ChannelActionInput<"telegram_pin">): Promise<unknown>;
}

export interface TelegramUnpinCommandQueue extends ConversationBindingAuthorizer {
  enqueueAction(input: ChannelActionInput<"telegram_unpin">): Promise<unknown>;
}

export interface TelegramStickerSendCommandQueue extends ConversationBindingAuthorizer {
  enqueueAction(input: ChannelActionInput<"telegram_sticker_send">): Promise<unknown>;
}

export interface TelegramSendCommandQueue extends ConversationBindingAuthorizer {
  enqueueDelivery(input: OutboundDeliveryInput): Promise<{
    id: string;
    channel: string;
  }>;
}

export interface TelegramChatListCommandServices {
  connectorAccounts: {
    listAccounts(filter?: ConnectorAccountListFilter): Promise<readonly ConnectorAccountRecord[]>;
  };
  conversations: {
    listConversationBindings(filter: ConversationBindingListFilter): Promise<readonly ConversationBinding[]>;
  };
}

export interface TelegramHistoryCommandServices extends TelegramChatListCommandServices {
  messages: {
    listChannelMessages(filter: ThreadChannelMessageFilter): Promise<readonly ThreadMessageRecord[]>;
  };
  deliveries: {
    listDeliveriesForTarget(filter: OutboundDeliveryTargetHistoryFilter): Promise<readonly OutboundDeliveryRecord[]>;
  };
}

export interface TelegramMediaFetchCommandServices extends TelegramChatListCommandServices {
  messages: {
    findChannelMedia(filter: ThreadChannelMediaFilter): Promise<ThreadChannelMediaRecord | null>;
  };
}

const TELEGRAM_MESSAGE_ID_ARGUMENT = {
  name: "message-id",
  description: "Telegram message id.",
  required: true,
  kind: "positional" as const,
  valueType: "string" as const,
  valueName: "message-id",
};

const TELEGRAM_REACT_JSON_ARGUMENT = {
  name: "json",
  description: "Structured JSON object containing emoji or remove=true, messageId, and target {connectorKey, conversationId}.",
  valueType: "json" as const,
};

const TELEGRAM_SEND_JSON_ARGUMENT = {
  name: "json",
  description: "Structured JSON object containing connectorKey, conversationId, items, and optional replyToMessageId.",
  valueType: "json" as const,
};

const TELEGRAM_CHAT_LIST_JSON_ARGUMENT = {
  name: "json",
  description: "Structured JSON object containing optional connectorKey.",
  valueType: "json" as const,
};

const TELEGRAM_CHAT_INFO_JSON_ARGUMENT = {
  name: "json",
  description: "Structured JSON object containing conversationId and optional connectorKey.",
  valueType: "json" as const,
};

const TELEGRAM_HISTORY_JSON_ARGUMENT = {
  name: "json",
  description: "Structured JSON object containing conversationId plus optional connectorKey, direction, and limit.",
  valueType: "json" as const,
};

const TELEGRAM_MEDIA_FETCH_JSON_ARGUMENT = {
  name: "json",
  description: "Structured JSON object containing mediaId, conversationId, optional connectorKey, save, and overwrite.",
  valueType: "json" as const,
};

const TELEGRAM_EDIT_JSON_ARGUMENT = {
  name: "json",
  description: "Structured JSON object containing connectorKey, conversationId, messageId, and text.",
  valueType: "json" as const,
};

const TELEGRAM_DELETE_JSON_ARGUMENT = {
  name: "json",
  description: "Structured JSON object containing connectorKey, conversationId, and messageId.",
  valueType: "json" as const,
};

const TELEGRAM_PIN_JSON_ARGUMENT = {
  name: "json",
  description: "Structured JSON object containing connectorKey, conversationId, messageId, and optional silent.",
  valueType: "json" as const,
};

const TELEGRAM_UNPIN_JSON_ARGUMENT = {
  name: "json",
  description: "Structured JSON object containing connectorKey, conversationId, and messageId.",
  valueType: "json" as const,
};

const TELEGRAM_STICKER_SEND_JSON_ARGUMENT = {
  name: "json",
  description: "Structured JSON object containing connectorKey, conversationId, and exactly one of stickerRef, filePath, or fileId.",
  valueType: "json" as const,
};

function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must not be empty.`);
  }

  return value.trim();
}

function readOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  return readRequiredString(value, label);
}

function readOptionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }

  return value;
}

function readOptionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean.`);
  }

  return value;
}

function readOptionalTelegramHistoryDirection(value: unknown): TelegramHistoryDirection | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value === "inbound" || value === "outbound" || value === "all") {
    return value;
  }

  throw new Error("telegram.history direction must be inbound, outbound, or all.");
}

function readTarget(value: unknown, label = "telegram.react"): TelegramActionTarget | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${label} target must be a JSON object.`);
  }

  return {
    connectorKey: readRequiredString(value.connectorKey, `${label} target.connectorKey`),
    conversationId: readRequiredString(value.conversationId, `${label} target.conversationId`),
  };
}

function readCurrentInput(value: unknown): TelegramReactCommandCurrentInput | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error("telegram.react currentInput must be a JSON object.");
  }

  const metadata = value.metadata;
  if (metadata !== undefined && !isJsonObject(metadata)) {
    throw new Error("telegram.react currentInput.metadata must be a JSON object.");
  }

  const channelId = readOptionalString(value.channelId, "telegram.react currentInput.channelId");
  const externalMessageId = readOptionalString(value.externalMessageId, "telegram.react currentInput.externalMessageId");
  return {
    source: readRequiredString(value.source, "telegram.react currentInput.source"),
    ...(channelId ? {channelId} : {}),
    ...(externalMessageId ? {externalMessageId} : {}),
    ...(metadata ? {metadata} : {}),
  };
}

function rejectUnexpectedKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unexpected.length > 0) {
    throw new Error(`${label} contains unsupported field ${unexpected[0]}.`);
  }
}

function parseTelegramSendItem(value: unknown, label: string): OutboundItem {
  if (!isRecord(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }

  switch (value.type) {
    case "text":
      rejectUnexpectedKeys(value, ["type", "text"], label);
      return {
        type: "text",
        text: readRequiredString(value.text, `${label}.text`),
      };
    case "image": {
      rejectUnexpectedKeys(value, ["type", "path", "caption"], label);
      const caption = readOptionalString(value.caption, `${label}.caption`);
      return {
        type: "image",
        path: readRequiredString(value.path, `${label}.path`),
        ...(caption ? {caption} : {}),
      };
    }
    case "file": {
      rejectUnexpectedKeys(value, ["type", "path", "filename", "caption", "mimeType"], label);
      const filename = readOptionalString(value.filename, `${label}.filename`);
      const caption = readOptionalString(value.caption, `${label}.caption`);
      const mimeType = readOptionalString(value.mimeType, `${label}.mimeType`);
      return {
        type: "file",
        path: readRequiredString(value.path, `${label}.path`),
        ...(filename ? {filename} : {}),
        ...(caption ? {caption} : {}),
        ...(mimeType ? {mimeType} : {}),
      };
    }
    default:
      throw new Error(`${label}.type must be text, image, or file.`);
  }
}

function parseTelegramSendCommandInput(input: unknown): {
  connectorKey: string;
  conversationId: string;
  replyToMessageId?: string;
  items: readonly OutboundItem[];
} {
  if (!isRecord(input)) {
    throw new Error("telegram.send input must be a JSON object.");
  }
  rejectUnexpectedKeys(input, ["connectorKey", "conversationId", "replyToMessageId", "items"], "telegram.send input");

  if (!Array.isArray(input.items) || input.items.length === 0 || input.items.length > MAX_TELEGRAM_SEND_ITEMS) {
    throw new Error(`telegram.send items must contain 1-${MAX_TELEGRAM_SEND_ITEMS} items.`);
  }

  const replyToMessageId = readOptionalString(input.replyToMessageId, "telegram.send replyToMessageId");
  return {
    connectorKey: readRequiredString(input.connectorKey, "telegram.send connectorKey"),
    conversationId: readRequiredString(input.conversationId, "telegram.send conversationId"),
    ...(replyToMessageId ? {replyToMessageId} : {}),
    items: input.items.map((item, index) => parseTelegramSendItem(item, `telegram.send items[${index}]`)),
  };
}

function parseTelegramChatListCommandInput(input: unknown): {
  connectorKey?: string;
} {
  if (!isRecord(input)) {
    throw new Error("telegram.chat.list input must be a JSON object.");
  }
  rejectUnexpectedKeys(input, ["connectorKey"], "telegram.chat.list input");

  const connectorKey = readOptionalString(input.connectorKey, "telegram.chat.list connectorKey");
  return connectorKey ? {connectorKey} : {};
}

function parseTelegramChatInfoCommandInput(input: unknown): {
  connectorKey?: string;
  conversationId: string;
} {
  if (!isRecord(input)) {
    throw new Error("telegram.chat.info input must be a JSON object.");
  }
  rejectUnexpectedKeys(input, ["connectorKey", "conversationId"], "telegram.chat.info input");

  const connectorKey = readOptionalString(input.connectorKey, "telegram.chat.info connectorKey");
  return {
    ...(connectorKey ? {connectorKey} : {}),
    conversationId: readRequiredString(input.conversationId, "telegram.chat.info conversationId"),
  };
}

function parseTelegramHistoryCommandInput(input: unknown): TelegramHistoryCommandInput {
  if (!isRecord(input)) {
    throw new Error("telegram.history input must be a JSON object.");
  }
  rejectUnexpectedKeys(input, ["connectorKey", "conversationId", "direction", "limit"], "telegram.history input");

  const connectorKey = readOptionalString(input.connectorKey, "telegram.history connectorKey");
  const direction = readOptionalTelegramHistoryDirection(input.direction);
  const limit = readOptionalPositiveInteger(input.limit, "telegram.history limit");
  return {
    ...(connectorKey ? {connectorKey} : {}),
    conversationId: readRequiredString(input.conversationId, "telegram.history conversationId"),
    ...(direction ? {direction} : {}),
    ...(limit === undefined ? {} : {limit}),
  };
}

function parseTelegramMediaFetchCommandInput(input: unknown): TelegramMediaFetchCommandInput {
  if (!isRecord(input)) {
    throw new Error("telegram.media.fetch input must be a JSON object.");
  }
  rejectUnexpectedKeys(input, ["connectorKey", "conversationId", "mediaId", "save", "overwrite"], "telegram.media.fetch input");

  const connectorKey = readOptionalString(input.connectorKey, "telegram.media.fetch connectorKey");
  const save = readOptionalString(input.save, "telegram.media.fetch save");
  const overwrite = readOptionalBoolean(input.overwrite, "telegram.media.fetch overwrite");
  return {
    ...(connectorKey ? {connectorKey} : {}),
    conversationId: readRequiredString(input.conversationId, "telegram.media.fetch conversationId"),
    mediaId: readRequiredString(input.mediaId, "telegram.media.fetch mediaId"),
    ...(save ? {save} : {}),
    ...(overwrite === undefined ? {} : {overwrite}),
  };
}

function parseTelegramReactCommandInput(input: unknown): TelegramReactCommandInput {
  if (!isRecord(input)) {
    throw new Error("telegram.react input must be a JSON object.");
  }

  const remove = input.remove;
  if (remove !== undefined && typeof remove !== "boolean") {
    throw new Error("telegram.react remove must be a boolean.");
  }

  const emoji = readOptionalString(input.emoji, "telegram.react emoji");
  if (remove !== true && !emoji) {
    throw new Error("telegram.react emoji is required unless remove=true.");
  }

  const messageId = readOptionalString(input.messageId, "telegram.react messageId");
  const target = readTarget(input.target);
  const currentInput = readCurrentInput(input.currentInput);
  return {
    ...(emoji ? {emoji} : {}),
    ...(remove === undefined ? {} : {remove}),
    ...(messageId ? {messageId} : {}),
    ...(target ? {target} : {}),
    ...(currentInput ? {currentInput} : {}),
  };
}

function parseTelegramEditCommandInput(input: unknown): TelegramEditCommandInput {
  if (!isRecord(input)) {
    throw new Error("telegram.edit input must be a JSON object.");
  }
  rejectUnexpectedKeys(input, ["connectorKey", "conversationId", "messageId", "text"], "telegram.edit input");

  return {
    connectorKey: readRequiredString(input.connectorKey, "telegram.edit connectorKey"),
    conversationId: readRequiredString(input.conversationId, "telegram.edit conversationId"),
    messageId: readRequiredString(input.messageId, "telegram.edit messageId"),
    text: readRequiredString(input.text, "telegram.edit text"),
  };
}

function parseTelegramDeleteCommandInput(input: unknown): TelegramDeleteCommandInput {
  if (!isRecord(input)) {
    throw new Error("telegram.delete input must be a JSON object.");
  }
  rejectUnexpectedKeys(input, ["connectorKey", "conversationId", "messageId"], "telegram.delete input");

  return {
    connectorKey: readRequiredString(input.connectorKey, "telegram.delete connectorKey"),
    conversationId: readRequiredString(input.conversationId, "telegram.delete conversationId"),
    messageId: readRequiredString(input.messageId, "telegram.delete messageId"),
  };
}

function parseTelegramPinCommandInput(input: unknown): TelegramPinCommandInput {
  if (!isRecord(input)) {
    throw new Error("telegram.pin input must be a JSON object.");
  }
  rejectUnexpectedKeys(input, ["connectorKey", "conversationId", "messageId", "silent"], "telegram.pin input");
  const silent = input.silent;
  if (silent !== undefined && typeof silent !== "boolean") {
    throw new Error("telegram.pin silent must be a boolean.");
  }

  return {
    connectorKey: readRequiredString(input.connectorKey, "telegram.pin connectorKey"),
    conversationId: readRequiredString(input.conversationId, "telegram.pin conversationId"),
    messageId: readRequiredString(input.messageId, "telegram.pin messageId"),
    ...(silent !== undefined ? {silent} : {}),
  };
}

function parseTelegramUnpinCommandInput(input: unknown): TelegramUnpinCommandInput {
  if (!isRecord(input)) {
    throw new Error("telegram.unpin input must be a JSON object.");
  }
  rejectUnexpectedKeys(input, ["connectorKey", "conversationId", "messageId"], "telegram.unpin input");

  return {
    connectorKey: readRequiredString(input.connectorKey, "telegram.unpin connectorKey"),
    conversationId: readRequiredString(input.conversationId, "telegram.unpin conversationId"),
    messageId: readRequiredString(input.messageId, "telegram.unpin messageId"),
  };
}

function parseTelegramStickerSendCommandInput(input: unknown): TelegramStickerSendCommandInput {
  if (!isRecord(input)) {
    throw new Error("telegram.sticker.send input must be a JSON object.");
  }
  rejectUnexpectedKeys(input, ["connectorKey", "conversationId", "filePath", "fileId", "stickerRef"], "telegram.sticker.send input");
  const filePath = readOptionalString(input.filePath, "telegram.sticker.send filePath");
  const fileId = readOptionalString(input.fileId, "telegram.sticker.send fileId");
  const stickerRef = readOptionalString(input.stickerRef, "telegram.sticker.send stickerRef");
  if ([filePath, fileId, stickerRef].filter(Boolean).length !== 1) {
    throw new Error("telegram.sticker.send requires exactly one of filePath, fileId, or stickerRef.");
  }

  return {
    connectorKey: readRequiredString(input.connectorKey, "telegram.sticker.send connectorKey"),
    conversationId: readRequiredString(input.conversationId, "telegram.sticker.send conversationId"),
    ...(filePath ? {filePath} : {}),
    ...(fileId ? {fileId} : {}),
    ...(stickerRef ? {stickerRef} : {}),
  };
}

function parseTelegramMessageId(value: string): number {
  try {
    return parseTelegramReactionMessageId(value);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }
}

function parseReactionConversationId(value: string): void {
  try {
    parseTelegramConversationId(value);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }
}

function parseTelegramActionConversationId(value: string): void {
  try {
    parseTelegramConversationId(value);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }
}

function parseSendConversationId(value: string): void {
  try {
    parseTelegramConversationId(value);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }
}

function requireAllowedTelegramReactionEmoji(value: string): string {
  if (!isAllowedTelegramReactionEmoji(value)) {
    throw new Error(
      `telegram.react emoji is unsupported by Telegram. Allowed emoji: ${ALLOWED_TELEGRAM_REACTION_EMOJI_LIST.join(", ")}`,
    );
  }

  return value;
}

function readCurrentTelegramTarget(currentInput: TelegramReactCommandCurrentInput | undefined): TelegramActionTarget | null {
  if (currentInput?.source !== TELEGRAM_SOURCE) {
    return null;
  }

  const metadata = currentInput.metadata;
  if (!isRecord(metadata)) {
    return null;
  }

  const route = metadata.route;
  if (!isRecord(route)) {
    return null;
  }

  const connectorKey = trimToUndefined(route.connectorKey);
  const conversationId =
    trimToUndefined(route.externalConversationId)
    ?? trimToUndefined(currentInput.channelId);
  if (!connectorKey || !conversationId) {
    return null;
  }

  return {
    connectorKey,
    conversationId,
  };
}

function readReactionTargetMessageId(currentInput: TelegramReactCommandCurrentInput | undefined): string | undefined {
  if (currentInput?.source !== TELEGRAM_SOURCE) {
    return undefined;
  }

  const metadata = currentInput.metadata;
  if (!isRecord(metadata)) {
    return undefined;
  }

  const telegram = metadata.telegram;
  if (!isRecord(telegram)) {
    return undefined;
  }

  const reaction = telegram.reaction;
  if (!isRecord(reaction)) {
    return undefined;
  }

  return trimToUndefined(reaction.targetMessageId);
}

function resolveTelegramMessageId(input: TelegramReactCommandInput): string | undefined {
  return (
    trimToUndefined(input.messageId)
    ?? readReactionTargetMessageId(input.currentInput)
    ?? (input.currentInput?.source === TELEGRAM_SOURCE
      ? trimToUndefined(input.currentInput.externalMessageId)
      : undefined)
  );
}

function requireCommandJsonObject(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }

  return value;
}

export async function executeTelegramReactCommand(
  input: TelegramReactCommandInput,
  request: CommandRequest,
  queue: TelegramReactCommandQueue,
): Promise<JsonObject> {
  const target = input.target ?? readCurrentTelegramTarget(input.currentInput);
  if (!target) {
    throw new Error("telegram.react requires a current Telegram input or an explicit target.");
  }

  const messageIdValue = resolveTelegramMessageId(input);
  if (!messageIdValue) {
    throw new Error("telegram.react requires a target message id.");
  }

  parseReactionConversationId(target.conversationId);
  await assertCurrentSessionConversationBinding({
    conversations: queue,
    source: TELEGRAM_SOURCE,
    connectorKey: target.connectorKey,
    externalConversationId: target.conversationId,
    sessionId: request.scope.sessionId,
    commandName: TELEGRAM_REACT_COMMAND_NAME,
  });
  const messageId = parseTelegramMessageId(messageIdValue);
  const remove = input.remove === true;
  const resolvedEmoji = remove ? "" : requireAllowedTelegramReactionEmoji(input.emoji!.trim());
  await queue.enqueueAction({
    channel: TELEGRAM_SOURCE,
    connectorKey: target.connectorKey,
    kind: "telegram_reaction",
    payload: {
      conversationId: target.conversationId,
      messageId: String(messageId),
      emoji: remove ? undefined : resolvedEmoji,
      remove,
    },
  });

  return requireCommandJsonObject(remove
    ? {
      ok: true,
      connectorKey: target.connectorKey,
      conversationId: target.conversationId,
      messageId: String(messageId),
      removed: true,
      queued: true,
    }
    : {
      ok: true,
      connectorKey: target.connectorKey,
      conversationId: target.conversationId,
      messageId: String(messageId),
      added: resolvedEmoji,
      queued: true,
    }, "telegram.react result");
}

export const telegramReactCommandDescriptor: CommandDescriptor = {
  name: TELEGRAM_REACT_COMMAND_NAME,
  summary: "Add or remove a Telegram message reaction.",
  description: "Queues a Telegram reaction action. Pass target and messageId explicitly from CLI, or rely on currentInput when called through the model-facing adapter.",
  usage: "panda telegram react <message-id> (--emoji <emoji>|--remove) --chat <conversation-id> --connector <key>",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    TELEGRAM_MESSAGE_ID_ARGUMENT,
    {
      name: "emoji",
      description: "Reaction emoji to add. Must be supported by Telegram.",
      valueType: "string",
      valueName: "emoji",
      conflictsWith: ["remove"],
    },
    {
      name: "remove",
      description: "Remove the current reaction instead of adding one.",
      valueType: "boolean",
      conflictsWith: ["emoji"],
    },
    {
      name: "chat",
      description: "Telegram conversation id.",
      required: true,
      valueType: "string",
      valueName: "conversation-id",
    },
    {
      name: "connector",
      description: "Telegram connector key.",
      required: true,
      valueType: "string",
      valueName: "key",
    },
    TELEGRAM_REACT_JSON_ARGUMENT,
  ],
  examples: [
    {
      description: "React to an explicit message",
      command: "panda telegram react 555 --emoji \"🔥\" --chat 12345 --connector telegram-main",
    },
    {
      description: "Remove reaction from an explicit message",
      command: "panda telegram react 555 --remove --chat 12345 --connector telegram-main",
    },
    {
      description: "Use JSON input",
      command: "panda telegram react --json '{\"emoji\":\"🔥\",\"messageId\":\"555\",\"target\":{\"connectorKey\":\"telegram-main\",\"conversationId\":\"12345\"}}'",
    },
  ],
  requiredCapabilities: ["telegram.react"],
  resultShape: {
    ok: "boolean",
    connectorKey: "string",
    conversationId: "string",
    messageId: "string",
    queued: "boolean",
  },
};

export async function executeTelegramEditCommand(
  input: TelegramEditCommandInput,
  request: CommandRequest,
  queue: TelegramEditCommandQueue,
): Promise<JsonObject> {
  parseTelegramActionConversationId(input.conversationId);
  await assertCurrentSessionConversationBinding({
    conversations: queue,
    source: TELEGRAM_SOURCE,
    connectorKey: input.connectorKey,
    externalConversationId: input.conversationId,
    sessionId: request.scope.sessionId,
    commandName: TELEGRAM_EDIT_COMMAND_NAME,
  });
  const messageId = parseTelegramMessageId(input.messageId);
  await queue.enqueueAction({
    channel: TELEGRAM_SOURCE,
    connectorKey: input.connectorKey,
    kind: "telegram_edit",
    payload: {
      conversationId: input.conversationId,
      messageId: String(messageId),
      text: input.text,
    },
  });

  return requireCommandJsonObject({
    ok: true,
    connectorKey: input.connectorKey,
    conversationId: input.conversationId,
    messageId: String(messageId),
    edited: true,
    queued: true,
  }, "telegram.edit result");
}

export const telegramEditCommandDescriptor: CommandDescriptor = {
  name: TELEGRAM_EDIT_COMMAND_NAME,
  summary: "Edit a Telegram text message.",
  description: "Queues a Telegram text edit action for an explicit chat and connector. Telegram only permits editing messages the bot is allowed to edit.",
  usage: "panda telegram edit <message-id> (--text <text|@file|@->|--stdin) --chat <conversation-id> --connector <key>",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    TELEGRAM_MESSAGE_ID_ARGUMENT,
    {
      name: "text",
      description: "Replacement message text. Use @file or @- for multiline text.",
      valueType: "string",
      valueName: "text|@file|@-",
      valueSources: ["literal", "file", "stdin"] as const,
    },
    {
      name: "stdin",
      description: "Read replacement text from stdin.",
      valueType: "boolean",
    },
    {
      name: "chat",
      description: "Telegram conversation id.",
      required: true,
      valueType: "string",
      valueName: "conversation-id",
    },
    {
      name: "connector",
      description: "Telegram connector key.",
      required: true,
      valueType: "string",
      valueName: "key",
    },
    TELEGRAM_EDIT_JSON_ARGUMENT,
  ],
  examples: [
    {
      description: "Edit an explicit message",
      command: "panda telegram edit 555 --text 'Updated.' --chat 12345 --connector telegram-main",
    },
    {
      description: "Edit with multiline text from stdin",
      command: "cat message.md | panda telegram edit 555 --text @- --chat 12345 --connector telegram-main",
    },
    {
      description: "Use JSON input",
      command: "panda telegram edit --json '{\"connectorKey\":\"telegram-main\",\"conversationId\":\"12345\",\"messageId\":\"555\",\"text\":\"Updated.\"}'",
    },
  ],
  requiredCapabilities: ["telegram.edit"],
  resultShape: {
    ok: "boolean",
    connectorKey: "string",
    conversationId: "string",
    messageId: "string",
    edited: "boolean",
    queued: "boolean",
  },
};

export async function executeTelegramDeleteCommand(
  input: TelegramDeleteCommandInput,
  request: CommandRequest,
  queue: TelegramDeleteCommandQueue,
): Promise<JsonObject> {
  parseTelegramActionConversationId(input.conversationId);
  await assertCurrentSessionConversationBinding({
    conversations: queue,
    source: TELEGRAM_SOURCE,
    connectorKey: input.connectorKey,
    externalConversationId: input.conversationId,
    sessionId: request.scope.sessionId,
    commandName: TELEGRAM_DELETE_COMMAND_NAME,
  });
  const messageId = parseTelegramMessageId(input.messageId);
  await queue.enqueueAction({
    channel: TELEGRAM_SOURCE,
    connectorKey: input.connectorKey,
    kind: "telegram_delete",
    payload: {
      conversationId: input.conversationId,
      messageId: String(messageId),
    },
  });

  return requireCommandJsonObject({
    ok: true,
    connectorKey: input.connectorKey,
    conversationId: input.conversationId,
    messageId: String(messageId),
    deleted: true,
    queued: true,
  }, "telegram.delete result");
}

export const telegramDeleteCommandDescriptor: CommandDescriptor = {
  name: TELEGRAM_DELETE_COMMAND_NAME,
  summary: "Delete a Telegram message.",
  description: "Queues a Telegram delete action for an explicit chat and connector. Telegram only permits deleting messages the bot is allowed to delete.",
  usage: "panda telegram delete <message-id> --chat <conversation-id> --connector <key>",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    TELEGRAM_MESSAGE_ID_ARGUMENT,
    {
      name: "chat",
      description: "Telegram conversation id.",
      required: true,
      valueType: "string",
      valueName: "conversation-id",
    },
    {
      name: "connector",
      description: "Telegram connector key.",
      required: true,
      valueType: "string",
      valueName: "key",
    },
    TELEGRAM_DELETE_JSON_ARGUMENT,
  ],
  examples: [
    {
      description: "Delete an explicit message",
      command: "panda telegram delete 555 --chat 12345 --connector telegram-main",
    },
    {
      description: "Use JSON input",
      command: "panda telegram delete --json '{\"connectorKey\":\"telegram-main\",\"conversationId\":\"12345\",\"messageId\":\"555\"}'",
    },
  ],
  requiredCapabilities: ["telegram.delete"],
  resultShape: {
    ok: "boolean",
    connectorKey: "string",
    conversationId: "string",
    messageId: "string",
    deleted: "boolean",
    queued: "boolean",
  },
};

export async function executeTelegramPinCommand(
  input: TelegramPinCommandInput,
  request: CommandRequest,
  queue: TelegramPinCommandQueue,
): Promise<JsonObject> {
  parseTelegramActionConversationId(input.conversationId);
  await assertCurrentSessionConversationBinding({
    conversations: queue,
    source: TELEGRAM_SOURCE,
    connectorKey: input.connectorKey,
    externalConversationId: input.conversationId,
    sessionId: request.scope.sessionId,
    commandName: TELEGRAM_PIN_COMMAND_NAME,
  });
  const messageId = parseTelegramMessageId(input.messageId);
  await queue.enqueueAction({
    channel: TELEGRAM_SOURCE,
    connectorKey: input.connectorKey,
    kind: "telegram_pin",
    payload: {
      conversationId: input.conversationId,
      messageId: String(messageId),
      ...(input.silent !== undefined ? {silent: input.silent} : {}),
    },
  });

  return requireCommandJsonObject({
    ok: true,
    connectorKey: input.connectorKey,
    conversationId: input.conversationId,
    messageId: String(messageId),
    pinned: true,
    queued: true,
  }, "telegram.pin result");
}

export const telegramPinCommandDescriptor: CommandDescriptor = {
  name: TELEGRAM_PIN_COMMAND_NAME,
  summary: "Pin a Telegram message.",
  description: "Queues a Telegram pin action for an explicit chat and connector. Telegram only permits pinning messages the bot is allowed to pin.",
  usage: "panda telegram pin <message-id> --chat <conversation-id> --connector <key> [--silent]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    TELEGRAM_MESSAGE_ID_ARGUMENT,
    {
      name: "chat",
      description: "Telegram conversation id.",
      required: true,
      valueType: "string",
      valueName: "conversation-id",
    },
    {
      name: "connector",
      description: "Telegram connector key.",
      required: true,
      valueType: "string",
      valueName: "key",
    },
    {
      name: "silent",
      description: "Pin without notifying chat members when Telegram supports it.",
      valueType: "boolean",
    },
    TELEGRAM_PIN_JSON_ARGUMENT,
  ],
  examples: [
    {
      description: "Pin an explicit message",
      command: "panda telegram pin 555 --chat 12345 --connector telegram-main",
    },
    {
      description: "Pin silently",
      command: "panda telegram pin 555 --chat 12345 --connector telegram-main --silent",
    },
    {
      description: "Use JSON input",
      command: "panda telegram pin --json '{\"connectorKey\":\"telegram-main\",\"conversationId\":\"12345\",\"messageId\":\"555\",\"silent\":true}'",
    },
  ],
  requiredCapabilities: ["telegram.pin"],
  resultShape: {
    ok: "boolean",
    connectorKey: "string",
    conversationId: "string",
    messageId: "string",
    pinned: "boolean",
    queued: "boolean",
  },
};

export async function executeTelegramUnpinCommand(
  input: TelegramUnpinCommandInput,
  request: CommandRequest,
  queue: TelegramUnpinCommandQueue,
): Promise<JsonObject> {
  parseTelegramActionConversationId(input.conversationId);
  await assertCurrentSessionConversationBinding({
    conversations: queue,
    source: TELEGRAM_SOURCE,
    connectorKey: input.connectorKey,
    externalConversationId: input.conversationId,
    sessionId: request.scope.sessionId,
    commandName: TELEGRAM_UNPIN_COMMAND_NAME,
  });
  const messageId = parseTelegramMessageId(input.messageId);
  await queue.enqueueAction({
    channel: TELEGRAM_SOURCE,
    connectorKey: input.connectorKey,
    kind: "telegram_unpin",
    payload: {
      conversationId: input.conversationId,
      messageId: String(messageId),
    },
  });

  return requireCommandJsonObject({
    ok: true,
    connectorKey: input.connectorKey,
    conversationId: input.conversationId,
    messageId: String(messageId),
    unpinned: true,
    queued: true,
  }, "telegram.unpin result");
}

export const telegramUnpinCommandDescriptor: CommandDescriptor = {
  name: TELEGRAM_UNPIN_COMMAND_NAME,
  summary: "Unpin a Telegram message.",
  description: "Queues a Telegram unpin action for an explicit chat and connector. Telegram only permits unpinning messages the bot is allowed to unpin.",
  usage: "panda telegram unpin <message-id> --chat <conversation-id> --connector <key>",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    TELEGRAM_MESSAGE_ID_ARGUMENT,
    {
      name: "chat",
      description: "Telegram conversation id.",
      required: true,
      valueType: "string",
      valueName: "conversation-id",
    },
    {
      name: "connector",
      description: "Telegram connector key.",
      required: true,
      valueType: "string",
      valueName: "key",
    },
    TELEGRAM_UNPIN_JSON_ARGUMENT,
  ],
  examples: [
    {
      description: "Unpin an explicit message",
      command: "panda telegram unpin 555 --chat 12345 --connector telegram-main",
    },
    {
      description: "Use JSON input",
      command: "panda telegram unpin --json '{\"connectorKey\":\"telegram-main\",\"conversationId\":\"12345\",\"messageId\":\"555\"}'",
    },
  ],
  requiredCapabilities: ["telegram.unpin"],
  resultShape: {
    ok: "boolean",
    connectorKey: "string",
    conversationId: "string",
    messageId: "string",
    unpinned: "boolean",
    queued: "boolean",
  },
};

async function resolveTelegramStickerFilePath(
  filePath: string,
  request: CommandRequest,
  fileResolver: CommandFileResolver,
): Promise<string> {
  const resolved = await fileResolver.resolveReadablePath({
    request,
    file: {
      path: filePath,
    },
  });
  await assertPathReadable(resolved.path, () => new Error(`No readable file found at ${resolved.displayPath}`));
  return resolved.path;
}

export async function executeTelegramStickerSendCommand(
  input: TelegramStickerSendCommandInput,
  request: CommandRequest,
  queue: TelegramStickerSendCommandQueue,
  fileResolver: CommandFileResolver,
  stickers: Pick<TelegramStickerStore, "getSticker">,
): Promise<JsonObject> {
  parseTelegramActionConversationId(input.conversationId);
  await assertCurrentSessionConversationBinding({
    conversations: queue,
    source: TELEGRAM_SOURCE,
    connectorKey: input.connectorKey,
    externalConversationId: input.conversationId,
    sessionId: request.scope.sessionId,
    commandName: TELEGRAM_STICKER_SEND_COMMAND_NAME,
  });
  let sticker:
    | {type: "file"; path: string}
    | {type: "file_id"; fileId: string};
  let resultType: "file" | "file_id" | "library_ref";
  if (input.filePath) {
    sticker = {
      type: "file" as const,
      path: await resolveTelegramStickerFilePath(input.filePath, request, fileResolver),
    };
    resultType = "file";
  } else if (input.stickerRef) {
    const id = parseTelegramStickerLibraryRef(input.stickerRef);
    const saved = await stickers.getSticker(request.scope.agentKey, id);
    if (!saved) {
      throw new Error("telegram.sticker.send found no matching sticker in the current agent library.");
    }
    if (saved.connectorKey !== input.connectorKey) {
      throw new Error("telegram.sticker.send saved sticker belongs to a different Telegram connector.");
    }
    sticker = {
      type: "file_id" as const,
      fileId: saved.fileId,
    };
    resultType = "library_ref";
  } else {
    sticker = {
      type: "file_id" as const,
      fileId: readRequiredString(input.fileId, "telegram.sticker.send fileId"),
    };
    resultType = "file_id";
  }
  await queue.enqueueAction({
    channel: TELEGRAM_SOURCE,
    connectorKey: input.connectorKey,
    kind: "telegram_sticker_send",
    payload: {
      conversationId: input.conversationId,
      sticker,
    },
  });

  return requireCommandJsonObject({
    ok: true,
    connectorKey: input.connectorKey,
    conversationId: input.conversationId,
    sticker: {type: resultType},
    queued: true,
  }, "telegram.sticker.send result");
}

export const telegramStickerSendCommandDescriptor: CommandDescriptor = {
  name: TELEGRAM_STICKER_SEND_COMMAND_NAME,
  summary: "Send a Telegram sticker.",
  description: "Queues a Telegram sticker action for an explicit chat and connector. Prefer an agent-library ref; file and raw file-id remain available for compatibility.",
  usage: "panda telegram sticker send --chat <conversation-id> --connector <key> (--ref <sticker-ref>|--file <path>|--file-id <id>)",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "chat",
      description: "Telegram conversation id.",
      required: true,
      valueType: "string",
      valueName: "conversation-id",
    },
    {
      name: "connector",
      description: "Telegram connector key.",
      required: true,
      valueType: "string",
      valueName: "key",
    },
    {
      name: "ref",
      description: "Agent-library sticker reference.",
      valueType: "string",
      valueName: "sticker-ref",
      conflictsWith: ["file", "file-id"],
    },
    {
      name: "file",
      description: "Workspace sticker file path.",
      valueType: "string",
      valueName: "path",
      conflictsWith: ["ref", "file-id"],
    },
    {
      name: "file-id",
      description: "Telegram sticker file id.",
      valueType: "string",
      valueName: "id",
      conflictsWith: ["ref", "file"],
    },
    TELEGRAM_STICKER_SEND_JSON_ARGUMENT,
  ],
  examples: [
    {
      description: "Send a sticker saved in the agent library",
      command: "panda telegram sticker send --chat 12345 --connector telegram-main --ref tg-lib:00000000-0000-4000-8000-000000000001",
    },
    {
      description: "Send a workspace sticker file",
      command: "panda telegram sticker send --chat 12345 --connector telegram-main --file ./sticker.webp",
    },
    {
      description: "Send a Telegram-hosted sticker id",
      command: "panda telegram sticker send --chat 12345 --connector telegram-main --file-id CAACAgIAAxkBAAE",
    },
    {
      description: "Use JSON input",
      command: "panda telegram sticker send --json '{\"connectorKey\":\"telegram-main\",\"conversationId\":\"12345\",\"filePath\":\"./sticker.webp\"}'",
    },
  ],
  requiredCapabilities: ["telegram.sticker.send"],
  resultShape: {
    ok: "boolean",
    connectorKey: "string",
    conversationId: "string",
    sticker: "object",
    queued: "boolean",
  },
};

async function resolveTelegramSendItemPath<TItem extends OutboundImageItem | OutboundFileItem>(
  item: TItem,
  request: CommandRequest,
  fileResolver: CommandFileResolver,
): Promise<TItem> {
  if (!("path" in item)) {
    throw new Error("Telegram send does not accept command upload references.");
  }
  const resolved = await fileResolver.resolveReadablePath({
    request,
    file: {
      path: item.path,
    },
  });
  await assertPathReadable(resolved.path, () => new Error(`No readable file found at ${resolved.displayPath}`));
  return {
    ...item,
    path: resolved.path,
  };
}

async function resolveTelegramSendItems(
  items: readonly OutboundItem[],
  request: CommandRequest,
  fileResolver: CommandFileResolver,
): Promise<readonly OutboundItem[]> {
  const resolved: OutboundItem[] = [];
  for (const item of items) {
    switch (item.type) {
      case "text":
        resolved.push(item);
        break;
      case "image":
        resolved.push(await resolveTelegramSendItemPath(item, request, fileResolver));
        break;
      case "file":
        resolved.push(await resolveTelegramSendItemPath(item, request, fileResolver));
        break;
    }
  }
  return resolved;
}

export async function executeTelegramSendCommand(
  input: {
    connectorKey: string;
    conversationId: string;
    replyToMessageId?: string;
    items: readonly OutboundItem[];
  },
  request: CommandRequest,
  queue: TelegramSendCommandQueue,
  fileResolver: CommandFileResolver,
): Promise<JsonObject> {
  if (!request.scope.threadId) {
    throw commandScopeDenied(
      "telegram.send requires a thread id in the current runtime context.",
      "command_scope_denied",
      "Run the command from an active Panda thread context.",
    );
  }

  parseSendConversationId(input.conversationId);
  await assertCurrentSessionConversationBinding({
    conversations: queue,
    source: TELEGRAM_SOURCE,
    connectorKey: input.connectorKey,
    externalConversationId: input.conversationId,
    sessionId: request.scope.sessionId,
    commandName: TELEGRAM_SEND_COMMAND_NAME,
  });
  const items = await resolveTelegramSendItems(input.items, request, fileResolver);
  const delivery = await queue.enqueueDelivery({
    threadId: request.scope.threadId,
    channel: TELEGRAM_SOURCE,
    target: {
      source: TELEGRAM_SOURCE,
      connectorKey: input.connectorKey,
      externalConversationId: input.conversationId,
      ...(input.replyToMessageId ? {replyToMessageId: input.replyToMessageId} : {}),
    },
    items,
  });

  return requireCommandJsonObject({
    ok: true,
    status: "queued",
    deliveryId: delivery.id,
    to: {
      channel: TELEGRAM_SOURCE,
      connectorKey: input.connectorKey,
      conversationId: input.conversationId,
    },
  }, "telegram.send result");
}

export const telegramSendCommandDescriptor: CommandDescriptor = {
  name: TELEGRAM_SEND_COMMAND_NAME,
  summary: "Send a Telegram message.",
  description: "Queues a Telegram outbound delivery to an explicit chat and connector.",
  usage: "panda telegram send --chat <conversation-id> --connector <key> (--text <text|@file|@->|--stdin|--image <path>|--file <path>)... [--reply-to-message-id <message-id>]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "chat",
      description: "Telegram conversation id. Supports forum-topic ids accepted by Panda Telegram routing.",
      required: true,
      valueType: "string",
      valueName: "conversation-id",
    },
    {
      name: "connector",
      description: "Telegram connector key.",
      required: true,
      valueType: "string",
      valueName: "key",
    },
    {
      name: "text",
      description: "Text message body. Use --stdin or --text @file for longer bodies. Repeat to send multiple text items.",
      valueType: "string",
      valueName: "text|@file|@-",
      valueSources: ["literal", "file", "stdin"] as const,
      repeatable: true,
    },
    {
      name: "stdin",
      description: "Read one text item from stdin.",
      valueType: "boolean",
    },
    {
      name: "image",
      description: "Repeatable image path sent as Telegram photo.",
      valueType: "string",
      valueName: "path",
      repeatable: true,
    },
    {
      name: "file",
      description: "Repeatable file path sent as Telegram document.",
      valueType: "string",
      valueName: "path",
      repeatable: true,
    },
    {
      name: "reply-to-message-id",
      description: "Telegram message id to reply to.",
      valueType: "string",
      valueName: "message-id",
    },
    TELEGRAM_SEND_JSON_ARGUMENT,
  ],
  examples: [
    {
      description: "Send a text message",
      command: "panda telegram send --chat 12345 --connector telegram-main --text 'Done.'",
    },
    {
      description: "Send text from stdin with a file",
      command: "cat message.md | panda telegram send --chat 12345 --connector telegram-main --text @- --file ./report.pdf",
    },
    {
      description: "Use JSON input",
      command: "panda telegram send --json '{\"connectorKey\":\"telegram-main\",\"conversationId\":\"12345\",\"items\":[{\"type\":\"text\",\"text\":\"Done.\"}]}'",
    },
  ],
  requiredCapabilities: ["telegram.send"],
  resultShape: {
    ok: "boolean",
    status: "queued",
    deliveryId: "string",
    to: {
      channel: "telegram",
      connectorKey: "string",
      conversationId: "string",
    },
  },
};

function selectEnabledTelegramAccounts(
  accounts: readonly ConnectorAccountRecord[],
  connectorKey: string | undefined,
): readonly ConnectorAccountRecord[] {
  if (!connectorKey) {
    return accounts;
  }

  return accounts.filter((account) => account.connectorKey === connectorKey);
}

function serializeTelegramChatBinding(
  account: ConnectorAccountRecord,
  binding: ConversationBinding,
): JsonObject {
  return requireCommandJsonObject({
    accountKey: account.accountKey,
    connectorKey: account.connectorKey,
    conversationId: binding.externalConversationId,
    sessionId: binding.sessionId,
    ...(binding.metadata === undefined ? {} : {metadata: binding.metadata}),
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
  }, "telegram.chat.list chat");
}

function clampTelegramHistoryLimit(limit: number | undefined): number {
  return Math.min(limit ?? DEFAULT_TELEGRAM_HISTORY_LIMIT, MAX_TELEGRAM_HISTORY_LIMIT);
}

function textPreview(text: string | undefined, maxChars = 1200): JsonObject {
  const value = text?.trim();
  if (!value) {
    return {};
  }

  if (value.length <= maxChars) {
    return {text: value};
  }

  return {
    text: `${value.slice(0, maxChars)}...`,
    truncated: true,
  };
}

function extractHistoryMessageText(record: ThreadMessageRecord): string | undefined {
  const content = (record.message as {content?: unknown}).content;
  if (typeof content === "string") {
    return trimToUndefined(content);
  }
  if (!Array.isArray(content)) {
    return undefined;
  }

  const parts = content.flatMap((part) => {
    if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") {
      return [];
    }
    const text = part.text.trim();
    return text ? [text] : [];
  });
  return trimToUndefined(parts.join("\n\n"));
}

function readTelegramHistoryMetadata(record: ThreadMessageRecord): Record<string, unknown> {
  if (!isRecord(record.metadata)) {
    return {};
  }
  const telegram = record.metadata.telegram;
  return isRecord(telegram) ? telegram : {};
}

function serializeInboundMedia(metadata: Record<string, unknown>): JsonObject[] {
  const media = metadata.media;
  if (!Array.isArray(media)) {
    return [];
  }

  return media.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }
    const id = readOptionalString(entry.id, "telegram.history media.id");
    const mimeType = readOptionalString(entry.mimeType, "telegram.history media.mimeType");
    const originalFilename = readOptionalString(entry.originalFilename, "telegram.history media.originalFilename");
    const sizeBytes = typeof entry.sizeBytes === "number" && Number.isFinite(entry.sizeBytes)
      ? entry.sizeBytes
      : undefined;
    const serializedMetadata = isRecord(entry.metadata) ? entry.metadata : undefined;
    const sticker = id && mimeType && sizeBytes !== undefined && serializedMetadata
      ? readTelegramInboundSticker({
        id,
        source: TELEGRAM_SOURCE,
        connectorKey: "",
        mimeType,
        sizeBytes,
        localPath: "",
        metadata: serializedMetadata as JsonValue,
        createdAt: 0,
      })
      : null;
    return [requireCommandJsonObject({
      ...(id ? {id} : {}),
      ...(mimeType ? {mimeType} : {}),
      ...(sizeBytes === undefined ? {} : {sizeBytes}),
      ...(originalFilename ? {originalFilename} : {}),
      ...(sticker ? {sticker: serializeSafeTelegramSticker(sticker)} : {}),
    }, "telegram.history media")];
  });
}

function safeTelegramMediaFilename(media: MediaDescriptor): string {
  const filename = trimToUndefined(media.originalFilename);
  const base = filename ? path.basename(filename) : media.id;
  const safe = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return safe || media.id;
}

function defaultTelegramMediaSavePath(media: MediaDescriptor): string {
  return path.join("telegram-media", `${media.id}-${safeTelegramMediaFilename(media)}`);
}

function inferTelegramMediaMimeType(media: MediaDescriptor): string | undefined {
  const normalized = trimToUndefined(media.mimeType)?.toLowerCase();
  if (normalized) {
    return normalized;
  }

  const extension = path.extname(media.originalFilename ?? media.localPath).toLowerCase();
  switch (extension) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".pdf":
      return "application/pdf";
    default:
      return undefined;
  }
}

function toTelegramMediaArtifact(
  media: MediaDescriptor,
  savedPath: string,
  bytes: number,
): CommandArtifactDescriptor | undefined {
  const mimeType = inferTelegramMediaMimeType(media);
  if (!mimeType) {
    return undefined;
  }

  if (mimeType === "application/pdf") {
    return {
      kind: "pdf",
      source: "view_media",
      path: savedPath,
      mimeType,
      bytes,
      originalPath: media.originalFilename ?? media.id,
    };
  }

  if (mimeType.startsWith("image/")) {
    return {
      kind: "image",
      source: "view_media",
      path: savedPath,
      mimeType,
      bytes,
      originalPath: media.originalFilename ?? media.id,
    };
  }

  return undefined;
}

function serializeFetchedTelegramMedia(media: MediaDescriptor): JsonObject {
  return requireCommandJsonObject({
    id: media.id,
    source: media.source,
    connectorKey: media.connectorKey,
    mimeType: media.mimeType,
    sizeBytes: media.sizeBytes,
    ...(media.originalFilename ? {originalFilename: media.originalFilename} : {}),
    createdAt: media.createdAt,
  }, "telegram.media.fetch media");
}

function serializeInboundHistoryItem(record: ThreadMessageRecord): JsonObject {
  const telegram = readTelegramHistoryMetadata(record);
  const sentAt = readOptionalString(telegram.sentAt, "telegram.history sentAt");
  const messageId = readOptionalString(record.externalMessageId, "telegram.history externalMessageId")
    ?? (typeof telegram.messageId === "number" ? String(telegram.messageId) : undefined);
  const username = readOptionalString(telegram.username, "telegram.history username");
  const firstName = readOptionalString(telegram.firstName, "telegram.history firstName");
  const lastName = readOptionalString(telegram.lastName, "telegram.history lastName");
  const media = serializeInboundMedia(telegram);

  return requireCommandJsonObject({
    id: record.id,
    direction: "inbound",
    threadId: record.threadId,
    ...(messageId ? {messageId} : {}),
    ...(record.actorId ? {actorId: record.actorId} : {}),
    ...(username ? {username} : {}),
    ...(firstName ? {firstName} : {}),
    ...(lastName ? {lastName} : {}),
    ...textPreview(extractHistoryMessageText(record)),
    ...(media.length > 0 ? {media} : {}),
    ...(sentAt ? {sentAt} : {}),
    createdAt: record.createdAt,
  }, "telegram.history inbound item");
}

function serializeOutboundItem(item: OutboundItem): JsonObject {
  switch (item.type) {
    case "text":
      return requireCommandJsonObject({
        type: "text",
        ...textPreview(item.text, 500),
      }, "telegram.history outbound text item");
    case "image":
      return requireCommandJsonObject({
        type: "image",
        ...(item.caption ? {caption: item.caption} : {}),
      }, "telegram.history outbound image item");
    case "file":
      return requireCommandJsonObject({
        type: "file",
        ...(item.filename ? {filename: item.filename} : {}),
        ...(item.mimeType ? {mimeType: item.mimeType} : {}),
        ...(item.caption ? {caption: item.caption} : {}),
      }, "telegram.history outbound file item");
  }
}

function serializeOutboundHistoryItem(delivery: OutboundDeliveryRecord): JsonObject {
  return requireCommandJsonObject({
    id: delivery.id,
    deliveryId: delivery.id,
    direction: "outbound",
    status: delivery.status,
    threadId: delivery.threadId,
    ...(delivery.target.replyToMessageId ? {replyToMessageId: delivery.target.replyToMessageId} : {}),
    items: delivery.items.map(serializeOutboundItem),
    ...(delivery.sent ? {sentItems: delivery.sent.map((item) => requireCommandJsonObject(item, "telegram.history sent item"))} : {}),
    ...(delivery.lastError ? {lastError: delivery.lastError} : {}),
    createdAt: delivery.createdAt,
    ...(delivery.completedAt ? {completedAt: delivery.completedAt} : {}),
  }, "telegram.history outbound item");
}

function readHistoryItemCreatedAt(item: JsonObject): number {
  return typeof item.createdAt === "number" ? item.createdAt : 0;
}

async function findTelegramChatBinding(
  input: {
    connectorKey?: string;
    conversationId: string;
  },
  request: CommandRequest,
  services: TelegramChatListCommandServices,
): Promise<JsonObject> {
  parseTelegramActionConversationId(input.conversationId);
  const accounts = selectEnabledTelegramAccounts(await services.connectorAccounts.listAccounts({
    source: TELEGRAM_SOURCE,
    status: "enabled",
  }), input.connectorKey);

  if (input.connectorKey && accounts.length === 0) {
    throw new Error(`telegram.chat.info found no enabled Telegram connector ${input.connectorKey}.`);
  }

  const matches: JsonObject[] = [];
  for (const account of accounts) {
    const bindings = await services.conversations.listConversationBindings({
      source: TELEGRAM_SOURCE,
      connectorKey: account.connectorKey,
    });
    for (const binding of bindings) {
      if (
        binding.sessionId === request.scope.sessionId
        && binding.externalConversationId === input.conversationId
      ) {
        matches.push(serializeTelegramChatBinding(account, binding));
      }
    }
  }

  if (matches.length === 0) {
    throw commandScopeDenied(
      "telegram.chat.info found no matching current-session Telegram chat.",
      "resource_scope_denied",
      "Use a chat returned by telegram.chat.list in the current session.",
    );
  }
  if (!input.connectorKey && matches.length > 1) {
    throw new Error("telegram.chat.info found multiple matching chats; pass --connector <key>.");
  }

  return matches[0]!;
}

export async function executeTelegramChatListCommand(
  input: {
    connectorKey?: string;
  },
  request: CommandRequest,
  services: TelegramChatListCommandServices,
): Promise<JsonObject> {
  const accounts = selectEnabledTelegramAccounts(await services.connectorAccounts.listAccounts({
    source: TELEGRAM_SOURCE,
    status: "enabled",
  }), input.connectorKey);

  if (input.connectorKey && accounts.length === 0) {
    throw new Error(`telegram.chat.list found no enabled Telegram connector ${input.connectorKey}.`);
  }

  const chats: JsonObject[] = [];
  for (const account of accounts) {
    const bindings = await services.conversations.listConversationBindings({
      source: TELEGRAM_SOURCE,
      connectorKey: account.connectorKey,
    });
    for (const binding of bindings) {
      if (binding.sessionId !== request.scope.sessionId) {
        continue;
      }
      chats.push(serializeTelegramChatBinding(account, binding));
    }
  }

  chats.sort((left, right) => {
    const leftKey = `${String(left.connectorKey)}\u0000${String(left.conversationId)}`;
    const rightKey = `${String(right.connectorKey)}\u0000${String(right.conversationId)}`;
    return leftKey.localeCompare(rightKey);
  });

  return requireCommandJsonObject({
    ok: true,
    count: chats.length,
    chats,
  }, "telegram.chat.list result");
}

export async function executeTelegramChatInfoCommand(
  input: {
    connectorKey?: string;
    conversationId: string;
  },
  request: CommandRequest,
  services: TelegramChatListCommandServices,
): Promise<JsonObject> {
  const chat = await findTelegramChatBinding(input, request, services);
  return requireCommandJsonObject({
    ok: true,
    chat,
  }, "telegram.chat.info result");
}

export async function executeTelegramHistoryCommand(
  input: TelegramHistoryCommandInput,
  request: CommandRequest,
  services: TelegramHistoryCommandServices,
): Promise<JsonObject> {
  const limit = clampTelegramHistoryLimit(input.limit);
  const direction = input.direction ?? "all";
  const chat = await findTelegramChatBinding(input, request, services);
  const connectorKey = readRequiredString(chat.connectorKey, "telegram.history chat.connectorKey");
  const conversationId = readRequiredString(chat.conversationId, "telegram.history chat.conversationId");
  const sessionId = readRequiredString(chat.sessionId, "telegram.history chat.sessionId");

  const [messages, deliveries] = await Promise.all([
    direction === "outbound"
      ? Promise.resolve([])
      : services.messages.listChannelMessages({
        sessionId,
        source: TELEGRAM_SOURCE,
        connectorKey,
        channelId: conversationId,
        limit,
      }),
    direction === "inbound"
      ? Promise.resolve([])
      : services.deliveries.listDeliveriesForTarget({
        sessionId,
        channel: TELEGRAM_SOURCE,
        connectorKey,
        externalConversationId: conversationId,
        limit,
      }),
  ]);

  const items = [
    ...messages.map(serializeInboundHistoryItem),
    ...deliveries.map(serializeOutboundHistoryItem),
  ]
    .sort((left, right) => readHistoryItemCreatedAt(left) - readHistoryItemCreatedAt(right))
    .slice(-limit);

  return requireCommandJsonObject({
    ok: true,
    source: "durable_panda_records",
    direction,
    limit,
    count: items.length,
    chat: {
      connectorKey,
      conversationId,
      sessionId,
    },
    items,
  }, "telegram.history result");
}

export async function executeTelegramMediaFetchCommand(
  input: TelegramMediaFetchCommandInput,
  request: CommandRequest,
  services: TelegramMediaFetchCommandServices,
  fileResolver: CommandWritableFileResolver,
): Promise<{output: JsonObject; artifact?: CommandArtifactDescriptor}> {
  const chat = await findTelegramChatBinding(input, request, services);
  const connectorKey = readRequiredString(chat.connectorKey, "telegram.media.fetch chat.connectorKey");
  const conversationId = readRequiredString(chat.conversationId, "telegram.media.fetch chat.conversationId");
  const sessionId = readRequiredString(chat.sessionId, "telegram.media.fetch chat.sessionId");
  const found = await services.messages.findChannelMedia({
    sessionId,
    source: TELEGRAM_SOURCE,
    connectorKey,
    channelId: conversationId,
    mediaId: input.mediaId,
  });
  if (!found) {
    throw commandScopeDenied(
      "telegram.media.fetch found no matching media in the current-session chat.",
      "resource_scope_denied",
      "Use media returned by current-session Telegram history.",
    );
  }

  const sourceStat = await stat(found.media.localPath);
  if (!sourceStat.isFile()) {
    throw new Error(`telegram.media.fetch media ${found.media.id} is not stored as a readable file.`);
  }

  const savePath = input.save ?? defaultTelegramMediaSavePath(found.media);
  const resolved = await fileResolver.resolveWritablePath({
    request,
    file: {
      path: savePath,
    },
  });
  if (!input.overwrite) {
    try {
      await stat(resolved.path);
      throw new Error(`Refusing to overwrite existing file at ${resolved.displayPath}; pass --overwrite to replace it.`);
    } catch (error) {
      if (
        error instanceof Error
        && error.message === `Refusing to overwrite existing file at ${resolved.displayPath}; pass --overwrite to replace it.`
      ) {
        throw error;
      }
    }
  }

  await mkdir(path.dirname(resolved.path), {recursive: true});
  await copyFile(found.media.localPath, resolved.path);
  const bytes = sourceStat.size;
  const mimeType = inferTelegramMediaMimeType(found.media);
  const artifact = toTelegramMediaArtifact(found.media, resolved.path, bytes);
  return {
    output: requireCommandJsonObject({
      ok: true,
      chat: {
        connectorKey,
        conversationId,
        sessionId,
      },
      media: serializeFetchedTelegramMedia(found.media),
      message: {
        id: found.message.id,
        threadId: found.message.threadId,
        ...(found.message.externalMessageId ? {messageId: found.message.externalMessageId} : {}),
        createdAt: found.message.createdAt,
      },
      saved: {
        path: resolved.path,
        displayPath: resolved.displayPath,
        bytes,
        ...(mimeType ? {mimeType} : {}),
      },
    }, "telegram.media.fetch result"),
    ...(artifact ? {artifact} : {}),
  };
}

export const telegramChatListCommandDescriptor: CommandDescriptor = {
  name: TELEGRAM_CHAT_LIST_COMMAND_NAME,
  summary: "List Telegram chats bound to the current session.",
  description: "Shows enabled Telegram connector keys and conversation ids that this session can use with Telegram provider commands. Results are scoped to the current session.",
  usage: "panda telegram chat list [--connector <key>]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "connector",
      description: "Optional Telegram connector key to narrow the list.",
      valueType: "string",
      valueName: "key",
    },
    TELEGRAM_CHAT_LIST_JSON_ARGUMENT,
  ],
  examples: [
    {
      description: "List Telegram chats for the current session",
      command: "panda telegram chat list",
    },
    {
      description: "List chats for one connector",
      command: "panda telegram chat list --connector telegram-main",
    },
    {
      description: "Use JSON input",
      command: "panda telegram chat list --json '{\"connectorKey\":\"telegram-main\"}'",
    },
  ],
  requiredCapabilities: ["telegram.chat.list"],
  resultShape: {
    ok: "boolean",
    count: "number",
    chats: ["object"],
  },
};

export const telegramChatInfoCommandDescriptor: CommandDescriptor = {
  name: TELEGRAM_CHAT_INFO_COMMAND_NAME,
  summary: "Show one Telegram chat binding for the current session.",
  description: "Shows one current-session Telegram chat binding with connector key, conversation id, session id, metadata, and timestamps. This is durable Panda routing state, not a live Telegram network lookup.",
  usage: "panda telegram chat info <conversation-id> [--connector <key>]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "conversation-id",
      description: "Telegram conversation id.",
      required: true,
      kind: "positional",
      valueType: "string",
      valueName: "conversation-id",
    },
    {
      name: "connector",
      description: "Optional Telegram connector key. Required when the conversation id is ambiguous across connectors.",
      valueType: "string",
      valueName: "key",
    },
    TELEGRAM_CHAT_INFO_JSON_ARGUMENT,
  ],
  examples: [
    {
      description: "Show one Telegram chat binding",
      command: "panda telegram chat info 12345",
    },
    {
      description: "Disambiguate by connector",
      command: "panda telegram chat info 12345 --connector telegram-main",
    },
    {
      description: "Use JSON input",
      command: "panda telegram chat info --json '{\"conversationId\":\"12345\",\"connectorKey\":\"telegram-main\"}'",
    },
  ],
  requiredCapabilities: ["telegram.chat.info"],
  resultShape: {
    ok: "boolean",
    chat: "object",
  },
};

export const telegramHistoryCommandDescriptor: CommandDescriptor = {
  name: TELEGRAM_HISTORY_COMMAND_NAME,
  summary: "Show recent durable Telegram chat history.",
  description: "Lists recent Telegram messages visible to the current session from Panda's durable records: inbound thread messages and outbound delivery receipts. This does not call Telegram for server-side chat history.",
  usage: "panda telegram history --chat <conversation-id> [--connector <key>] [--direction inbound|outbound|all] [--limit <n>]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "chat",
      description: "Telegram conversation id.",
      required: true,
      valueType: "string",
      valueName: "conversation-id",
    },
    {
      name: "connector",
      description: "Optional Telegram connector key. Required when the conversation id is ambiguous across connectors.",
      valueType: "string",
      valueName: "key",
    },
    {
      name: "direction",
      description: "History direction to include.",
      valueType: "string",
      valueName: "inbound|outbound|all",
      enumValues: ["inbound", "outbound", "all"],
      defaultValue: "all",
    },
    {
      name: "limit",
      description: `Maximum number of history items to return. Defaults to ${DEFAULT_TELEGRAM_HISTORY_LIMIT}.`,
      valueType: "number",
      valueName: "n",
      defaultValue: DEFAULT_TELEGRAM_HISTORY_LIMIT,
    },
    TELEGRAM_HISTORY_JSON_ARGUMENT,
  ],
  examples: [
    {
      description: "Show recent chat history",
      command: "panda telegram history --chat 12345 --connector telegram-main",
    },
    {
      description: "Show only outbound receipts",
      command: "panda telegram history --chat 12345 --connector telegram-main --direction outbound --limit 10",
    },
    {
      description: "Use JSON input",
      command: "panda telegram history --json '{\"conversationId\":\"12345\",\"connectorKey\":\"telegram-main\",\"direction\":\"all\"}'",
    },
  ],
  requiredCapabilities: ["telegram.history"],
  resultShape: {
    ok: "boolean",
    source: "durable_panda_records",
    direction: "inbound|outbound|all",
    count: "number",
    chat: "object",
    items: ["object"],
  },
};

export const telegramMediaFetchCommandDescriptor: CommandDescriptor = {
  name: TELEGRAM_MEDIA_FETCH_COMMAND_NAME,
  summary: "Fetch stored Telegram media into the command workspace.",
  description: "Copies one media item from Panda's durable Telegram message records into a writable command workspace path. This does not call Telegram; use telegram.history to discover media ids.",
  usage: "panda telegram media fetch <media-id> --chat <conversation-id> [--connector <key>] [--save <path>] [--overwrite]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "media-id",
      description: "Telegram media id from telegram.history.",
      required: true,
      kind: "positional",
      valueType: "string",
      valueName: "media-id",
    },
    {
      name: "chat",
      description: "Telegram conversation id.",
      required: true,
      valueType: "string",
      valueName: "conversation-id",
    },
    {
      name: "connector",
      description: "Optional Telegram connector key. Required when the conversation id is ambiguous across connectors.",
      valueType: "string",
      valueName: "key",
    },
    {
      name: "save",
      description: "Workspace path to copy the media to. Defaults to telegram-media/<media-id>-<filename>.",
      valueType: "string",
      valueName: "path",
    },
    {
      name: "overwrite",
      description: "Replace an existing file at the save path.",
      valueType: "boolean",
    },
    TELEGRAM_MEDIA_FETCH_JSON_ARGUMENT,
  ],
  examples: [
    {
      description: "Fetch a Telegram image discovered from history",
      command: "panda telegram media fetch media_abc123 --chat 12345 --connector telegram-main",
    },
    {
      description: "Save to an explicit path",
      command: "panda telegram media fetch media_abc123 --chat 12345 --connector telegram-main --save ./inbox/photo.png",
    },
    {
      description: "Use JSON input",
      command: "panda telegram media fetch --json '{\"mediaId\":\"media_abc123\",\"conversationId\":\"12345\",\"connectorKey\":\"telegram-main\"}'",
    },
  ],
  requiredCapabilities: ["telegram.media.fetch"],
  resultShape: {
    ok: "boolean",
    chat: "object",
    media: "object",
    message: "object",
    saved: "object",
  },
};

export function createTelegramReactCommand(queue: TelegramReactCommandQueue): RegisteredCommand {
  return {
    descriptor: telegramReactCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const output = await executeTelegramReactCommand(parseTelegramReactCommandInput(request.input), request, queue);
      return {
        ok: true,
        command: TELEGRAM_REACT_COMMAND_NAME,
        output,
        summary: "Queued Telegram reaction.",
      };
    },
  };
}

export function createTelegramEditCommand(queue: TelegramEditCommandQueue): RegisteredCommand {
  return {
    descriptor: telegramEditCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const output = await executeTelegramEditCommand(parseTelegramEditCommandInput(request.input), request, queue);
      return {
        ok: true,
        command: TELEGRAM_EDIT_COMMAND_NAME,
        output,
        summary: "Queued Telegram edit.",
      };
    },
  };
}

export function createTelegramDeleteCommand(queue: TelegramDeleteCommandQueue): RegisteredCommand {
  return {
    descriptor: telegramDeleteCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const output = await executeTelegramDeleteCommand(parseTelegramDeleteCommandInput(request.input), request, queue);
      return {
        ok: true,
        command: TELEGRAM_DELETE_COMMAND_NAME,
        output,
        summary: "Queued Telegram delete.",
      };
    },
  };
}

export function createTelegramPinCommand(queue: TelegramPinCommandQueue): RegisteredCommand {
  return {
    descriptor: telegramPinCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const output = await executeTelegramPinCommand(parseTelegramPinCommandInput(request.input), request, queue);
      return {
        ok: true,
        command: TELEGRAM_PIN_COMMAND_NAME,
        output,
        summary: "Queued Telegram pin.",
      };
    },
  };
}

export function createTelegramUnpinCommand(queue: TelegramUnpinCommandQueue): RegisteredCommand {
  return {
    descriptor: telegramUnpinCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const output = await executeTelegramUnpinCommand(parseTelegramUnpinCommandInput(request.input), request, queue);
      return {
        ok: true,
        command: TELEGRAM_UNPIN_COMMAND_NAME,
        output,
        summary: "Queued Telegram unpin.",
      };
    },
  };
}

export function createTelegramStickerSendCommand(
  queue: TelegramStickerSendCommandQueue,
  fileResolver: CommandFileResolver,
  stickers: Pick<TelegramStickerStore, "getSticker">,
): RegisteredCommand {
  return {
    descriptor: telegramStickerSendCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const output = await executeTelegramStickerSendCommand(
        parseTelegramStickerSendCommandInput(request.input),
        request,
        queue,
        fileResolver,
        stickers,
      );
      return {
        ok: true,
        command: TELEGRAM_STICKER_SEND_COMMAND_NAME,
        output,
        summary: "Queued Telegram sticker.",
      };
    },
  };
}

export function createTelegramChatListCommand(services: TelegramChatListCommandServices): RegisteredCommand {
  return {
    descriptor: telegramChatListCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const output = await executeTelegramChatListCommand(
        parseTelegramChatListCommandInput(request.input),
        request,
        services,
      );
      return {
        ok: true,
        command: TELEGRAM_CHAT_LIST_COMMAND_NAME,
        output,
        summary: `Found ${String(output.count)} Telegram chat(s) for this session.`,
      };
    },
  };
}

export function createTelegramChatInfoCommand(services: TelegramChatListCommandServices): RegisteredCommand {
  return {
    descriptor: telegramChatInfoCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const output = await executeTelegramChatInfoCommand(
        parseTelegramChatInfoCommandInput(request.input),
        request,
        services,
      );
      return {
        ok: true,
        command: TELEGRAM_CHAT_INFO_COMMAND_NAME,
        output,
        summary: "Found Telegram chat.",
      };
    },
  };
}

export function createTelegramHistoryCommand(services: TelegramHistoryCommandServices): RegisteredCommand {
  return {
    descriptor: telegramHistoryCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const output = await executeTelegramHistoryCommand(
        parseTelegramHistoryCommandInput(request.input),
        request,
        services,
      );
      return {
        ok: true,
        command: TELEGRAM_HISTORY_COMMAND_NAME,
        output,
        summary: `Found ${String(output.count)} Telegram history item(s).`,
      };
    },
  };
}

export function createTelegramMediaFetchCommand(
  services: TelegramMediaFetchCommandServices,
  fileResolver: CommandWritableFileResolver,
): RegisteredCommand {
  return {
    descriptor: telegramMediaFetchCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = parseTelegramMediaFetchCommandInput(request.input);
      const result = await executeTelegramMediaFetchCommand(
        input,
        request,
        services,
        fileResolver,
      );
      return {
        ok: true,
        command: TELEGRAM_MEDIA_FETCH_COMMAND_NAME,
        output: result.output,
        ...(result.artifact ? {artifact: result.artifact} : {}),
        summary: `Fetched Telegram media ${input.mediaId}.`,
      };
    },
  };
}

export function createTelegramSendCommand(
  queue: TelegramSendCommandQueue,
  fileResolver: CommandFileResolver,
): RegisteredCommand {
  return {
    descriptor: telegramSendCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const output = await executeTelegramSendCommand(
        parseTelegramSendCommandInput(request.input),
        request,
        queue,
        fileResolver,
      );
      return {
        ok: true,
        command: TELEGRAM_SEND_COMMAND_NAME,
        output,
        summary: `Queued Telegram delivery ${String(output.deliveryId)}.`,
      };
    },
  };
}
