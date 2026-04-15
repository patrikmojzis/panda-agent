function formatMaybeValue(value: string | undefined): string {
  return value?.trim() || "null";
}

export function renderWhatsAppInboundText(options: {
  channel: string;
  connectorKey: string;
  conversationId: string;
  actorId: string;
  externalMessageId: string;
  identityId?: string;
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
<panda-channel-context>
channel: ${options.channel}
connector_key: ${options.connectorKey}
conversation_id: ${options.conversationId}
actor_id: ${options.actorId}
external_message_id: ${options.externalMessageId}
identity_id: ${formatMaybeValue(options.identityId)}
identity_handle: ${formatMaybeValue(options.identityHandle)}
remote_jid: ${options.remoteJid}
chat_type: ${options.chatType}
push_name: ${formatMaybeValue(options.pushName)}
quoted_message_id: ${formatMaybeValue(options.quotedMessageId)}
attachments:
${attachments}
</panda-channel-context>

${trimmedBody || "[WhatsApp message]"}
`.trim();
}
