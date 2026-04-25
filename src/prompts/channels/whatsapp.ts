import {formatMaybeValue} from "./shared.js";

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
quoted_message_id: ${formatMaybeValue(options.quotedMessageId)}
attachments:
${attachments}
</runtime-channel-context>

${trimmedBody || "[WhatsApp message]"}
`.trim();
}
