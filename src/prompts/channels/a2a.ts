import {formatMaybeValue} from "./shared.js";

export function renderA2AInboundText(options: {
  connectorKey: string;
  conversationId: string;
  actorId: string;
  messageId: string;
  sentAt?: string;
  fromAgentKey: string;
  fromSessionId: string;
  attachments: readonly string[];
  body: string;
}): string {
  const attachments = options.attachments.length === 0 ? "- none" : options.attachments.join("\n");
  const trimmedBody = options.body.trim();

  return `
<runtime-channel-context>
channel: a2a
connector_key: ${options.connectorKey}
conversation_id: ${options.conversationId}
actor_id: ${options.actorId}
message_id: ${options.messageId}
sent_at: ${formatMaybeValue(options.sentAt)}
from_agent_key: ${options.fromAgentKey}
from_session_id: ${options.fromSessionId}
attachments:
${attachments}
</runtime-channel-context>

${trimmedBody || "[A2A message]"}
`.trim();
}

export function renderA2AInboundFallbackBody(options: {
  textBlocks: readonly string[];
}): string {
  const blocks = options.textBlocks
    .map((block) => block.trim())
    .filter((block) => block.length > 0);

  if (blocks.length === 0) {
    return "[A2A message]";
  }

  return blocks.join("\n\n");
}

export function renderA2AAttachmentCaption(caption: string | undefined): string {
  return `caption: ${formatMaybeValue(caption)}`;
}
