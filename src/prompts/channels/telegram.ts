import {formatMaybeValue} from "./shared.js";

function buildTelegramHeaderLines(options: {
  connectorKey: string;
  conversationId: string;
  actorId: string;
  externalMessageId: string;
  identityId?: string;
  identityHandle?: string;
  chatId: string;
  chatType: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  extraLines?: readonly string[];
  attachments: readonly string[];
}): string {
  const extraLines = options.extraLines?.length ? `\n${options.extraLines.join("\n")}` : "";
  const attachments = options.attachments.length === 0 ? "- none" : options.attachments.join("\n");
  return `
<runtime-channel-context>
channel: telegram
connector_key: ${options.connectorKey}
conversation_id: ${options.conversationId}
actor_id: ${options.actorId}
external_message_id: ${options.externalMessageId}
identity_id: ${formatMaybeValue(options.identityId)}
identity_handle: ${formatMaybeValue(options.identityHandle)}
chat_id: ${options.chatId}
chat_type: ${options.chatType}
username: ${formatMaybeValue(options.username)}
first_name: ${formatMaybeValue(options.firstName)}
last_name: ${formatMaybeValue(options.lastName)}${extraLines}
attachments:
${attachments}
</runtime-channel-context>
`.trim();
}

export function renderTelegramInboundText(options: {
  connectorKey: string;
  conversationId: string;
  actorId: string;
  externalMessageId: string;
  identityId?: string;
  identityHandle?: string;
  chatId: string;
  chatType: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  replyToMessageId?: string;
  attachments: readonly string[];
  body?: string;
}): string {
  const trimmedBody = options.body?.trim() ?? "";
  return `
${buildTelegramHeaderLines({
    connectorKey: options.connectorKey,
    conversationId: options.conversationId,
    actorId: options.actorId,
    externalMessageId: options.externalMessageId,
    identityId: options.identityId,
    identityHandle: options.identityHandle,
    chatId: options.chatId,
    chatType: options.chatType,
    username: options.username,
    firstName: options.firstName,
    lastName: options.lastName,
    extraLines: [
      `reply_to_message_id: ${formatMaybeValue(options.replyToMessageId)}`,
    ],
    attachments: options.attachments,
  })}

${trimmedBody || "[Telegram message]"}
`.trim();
}

export function renderTelegramReactionText(options: {
  connectorKey: string;
  conversationId: string;
  actorId: string;
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
}): string {
  return `
${buildTelegramHeaderLines({
    connectorKey: options.connectorKey,
    conversationId: options.conversationId,
    actorId: options.actorId,
    externalMessageId: options.externalMessageId,
    identityId: options.identityId,
    identityHandle: options.identityHandle,
    chatId: options.chatId,
    chatType: options.chatType,
    username: options.username,
    firstName: options.firstName,
    lastName: options.lastName,
    extraLines: [
      "reply_to_message_id: null",
      `reaction_target_message_id: ${options.targetMessageId}`,
      `reaction_added_emojis: ${options.addedEmojis.join(", ")}`,
      `reaction_actor_id: ${options.actorId}`,
      `reaction_actor_username: ${formatMaybeValue(options.username)}`,
    ],
    attachments: [],
  })}

Added reaction${options.addedEmojis.length === 1 ? "" : "s"}: ${options.addedEmojis.join(", ")}
`.trim();
}
