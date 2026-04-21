import {formatMaybeValue} from "./shared.js";

export function renderTuiInboundText(options: {
  channel: string;
  connectorKey: string;
  conversationId: string;
  actorId: string;
  externalMessageId: string;
  identityId?: string;
  identityHandle?: string;
  sentAt?: string;
  body: string;
}): string {
  const trimmedBody = options.body.trim();
  return `
<runtime-channel-context>
channel: ${options.channel}
connector_key: ${options.connectorKey}
conversation_id: ${options.conversationId}
actor_id: ${options.actorId}
external_message_id: ${options.externalMessageId}
sent_at: ${formatMaybeValue(options.sentAt)}
identity_id: ${formatMaybeValue(options.identityId)}
identity_handle: ${formatMaybeValue(options.identityHandle)}
attachments:
- none
</runtime-channel-context>

${trimmedBody || "[Terminal message]"}
`.trim();
}
