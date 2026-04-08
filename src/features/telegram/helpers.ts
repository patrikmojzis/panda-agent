import path from "node:path";

import type { MediaDescriptor } from "../channels/core/types.js";

export interface TelegramStartTextOptions {
  actorId: string;
  defaultIdentityHandle?: string;
}

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

function escapeTelegramHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function buildTelegramStartText(options: TelegramStartTextOptions): string {
  const command = escapeTelegramHtml(
    buildTelegramPairCommand(options.actorId, options.defaultIdentityHandle ?? "local"),
  );
  return [
    "Pair this Telegram account with Panda by running:",
    `<pre><code>${command}</code></pre>`,
    "",
    "Adjust the identity handle if you want a different Panda identity.",
  ].join("\n");
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

export function buildTelegramInboundText(options: TelegramInboundTextOptions): string {
  const trimmedText = options.text?.trim() ?? "";
  const headerLines = [
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
    `reply_to_message_id: ${formatMaybeValue(options.replyToMessageId)}`,
    "attachments:",
    ...(options.media.length === 0
      ? ["- none"]
      : options.media.map((descriptor) => describeMediaDescriptor(descriptor))),
    "</panda-channel-context>",
  ];

  return [
    ...headerLines,
    "",
    trimmedText || "[Telegram message]",
  ].join("\n");
}
