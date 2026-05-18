import {formatMaybeValue} from "./shared.js";

interface DiscordAttachmentSummaryPromptInput {
  id: string;
  filename?: string;
  contentType?: string;
  sizeBytes?: number;
}

function formatMaybeBoolean(value: boolean | undefined): string {
  return value === undefined ? "null" : String(value);
}

function formatMaybeNumber(value: number | undefined): string {
  return value === undefined ? "null" : String(value);
}

function formatAttachment(summary: DiscordAttachmentSummaryPromptInput): string {
  return `- id=${summary.id} filename=${formatMaybeValue(summary.filename)} content_type=${formatMaybeValue(summary.contentType)} size_bytes=${formatMaybeNumber(summary.sizeBytes)}`;
}

export function renderDiscordInboundText(options: {
  connectorKey: string;
  conversationId: string;
  actualChannelId: string;
  threadId?: string;
  guildId?: string;
  actorId: string;
  externalMessageId: string;
  sentAt?: string;
  identityHandle?: string;
  authorUsername?: string;
  authorGlobalName?: string;
  authorDisplayName?: string;
  authorIsBot?: boolean;
  replyToMessageId?: string;
  attachments: readonly DiscordAttachmentSummaryPromptInput[];
  body?: string;
}): string {
  const attachments = options.attachments.length === 0
    ? "- none"
    : options.attachments.map(formatAttachment).join("\n");
  const trimmedBody = options.body?.trim() ?? "";
  const body = trimmedBody || `Discord message with ${options.attachments.length} attachment${options.attachments.length === 1 ? "" : "s"}.`;

  return `
<runtime-channel-context>
channel: discord
connector_key: ${options.connectorKey}
conversation_id: ${options.conversationId}
actual_channel_id: ${options.actualChannelId}
thread_id: ${formatMaybeValue(options.threadId)}
guild_id: ${formatMaybeValue(options.guildId)}
actor_id: ${options.actorId}
external_message_id: ${options.externalMessageId}
sent_at: ${formatMaybeValue(options.sentAt)}
identity_handle: ${formatMaybeValue(options.identityHandle)}
author_username: ${formatMaybeValue(options.authorUsername)}
author_global_name: ${formatMaybeValue(options.authorGlobalName)}
author_display_name: ${formatMaybeValue(options.authorDisplayName)}
author_is_bot: ${formatMaybeBoolean(options.authorIsBot)}
reply_to_message_id: ${formatMaybeValue(options.replyToMessageId)}
attachments:
${attachments}
</runtime-channel-context>

${body}
`.trim();
}
