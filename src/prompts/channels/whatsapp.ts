import {formatMaybeValue} from "./shared.js";

function buildWhatsAppHeaderLines(options: {
  channel: string;
  connectorKey: string;
  sentAt?: string;
  conversationId: string;
  actorId: string;
  externalMessageId: string;
  identityHandle?: string;
  remoteJid: string;
  chatType: string;
  pushName?: string;
  quotedMessageId?: string;
  extraLines?: readonly string[];
  attachments: readonly string[];
}): string {
  const extraLines = options.extraLines?.length ? `\n${options.extraLines.join("\n")}` : "";
  const attachments = options.attachments.length === 0 ? "- none" : options.attachments.join("\n");
  return `
<runtime-channel-context>
channel: ${options.channel}
connector_key: ${options.connectorKey}
conversation_id: ${options.conversationId}
actor_id: ${options.actorId}
external_message_id: ${options.externalMessageId}
sent_at: ${formatMaybeValue(options.sentAt)}
identity_handle: ${formatMaybeValue(options.identityHandle)}
remote_jid: ${options.remoteJid}
chat_type: ${options.chatType}
push_name: ${formatMaybeValue(options.pushName)}
quoted_message_id: ${formatMaybeValue(options.quotedMessageId)}${extraLines}
attachments:
${attachments}
</runtime-channel-context>
`.trim();
}

export function renderWhatsAppInboundText(options: {
  channel: string;
  connectorKey: string;
  sentAt?: string;
  conversationId: string;
  actorId: string;
  externalMessageId: string;
  identityHandle?: string;
  remoteJid: string;
  chatType: string;
  pushName?: string;
  quotedMessageId?: string;
  attachments: readonly string[];
  body?: string;
}): string {
  const trimmedBody = options.body?.trim() ?? "";
  return `
${buildWhatsAppHeaderLines({
    channel: options.channel,
    connectorKey: options.connectorKey,
    sentAt: options.sentAt,
    conversationId: options.conversationId,
    actorId: options.actorId,
    externalMessageId: options.externalMessageId,
    identityHandle: options.identityHandle,
    remoteJid: options.remoteJid,
    chatType: options.chatType,
    pushName: options.pushName,
    quotedMessageId: options.quotedMessageId,
    attachments: options.attachments,
  })}

${trimmedBody || "[WhatsApp message]"}
`.trim();
}

export function renderWhatsAppReactionText(options: {
  connectorKey: string;
  sentAt?: string;
  conversationId: string;
  actorId: string;
  externalMessageId: string;
  identityHandle?: string;
  remoteJid: string;
  chatType: string;
  pushName?: string;
  targetMessageId: string;
  emoji: string;
}): string {
  return `
${buildWhatsAppHeaderLines({
    channel: "whatsapp",
    connectorKey: options.connectorKey,
    sentAt: options.sentAt,
    conversationId: options.conversationId,
    actorId: options.actorId,
    externalMessageId: options.externalMessageId,
    identityHandle: options.identityHandle,
    remoteJid: options.remoteJid,
    chatType: options.chatType,
    pushName: options.pushName,
    quotedMessageId: undefined,
    extraLines: [
      `reaction_target_message_id: ${options.targetMessageId}`,
      `reaction_emoji: ${options.emoji}`,
      `reaction_actor_id: ${options.actorId}`,
    ],
    attachments: [],
  })}

Added reaction: ${options.emoji}
`.trim();
}
