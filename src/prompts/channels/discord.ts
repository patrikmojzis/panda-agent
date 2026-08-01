import {formatMaybeValue} from "./shared.js";

interface DiscordAttachmentSummaryPromptInput {
  id: string;
  filename?: string;
  contentType?: string;
  sizeBytes?: number;
  status: string;
  reason?: string;
  httpStatus?: number;
}

interface DiscordEmbedSummaryPromptInput {
  type: string;
  title?: string;
  description?: string;
  providerName?: string;
  media: readonly {
    kind: string;
    contentType?: string;
    width?: number;
    height?: number;
    status: string;
    reason?: string;
  }[];
}

interface DiscordStickerSummaryPromptInput {
  id: string;
  name: string;
  format: string;
  status: string;
  reason?: string;
}

function formatMaybeBoolean(value: boolean | undefined): string {
  return value === undefined ? "null" : String(value);
}

function formatMaybeNumber(value: number | undefined): string {
  return value === undefined ? "null" : String(value);
}

function formatAttachment(summary: DiscordAttachmentSummaryPromptInput): string {
  return `- id=${summary.id} filename=${formatMaybeValue(summary.filename)} content_type=${formatMaybeValue(summary.contentType)} size_bytes=${formatMaybeNumber(summary.sizeBytes)} status=${summary.status} reason=${formatMaybeValue(summary.reason)} http_status=${formatMaybeNumber(summary.httpStatus)}`;
}

function formatEmbed(summary: DiscordEmbedSummaryPromptInput): string {
  const header = `- type=${summary.type} provider=${formatMaybeValue(summary.providerName)} title=${formatMaybeValue(summary.title)} description=${formatMaybeValue(summary.description)}`;
  if (summary.media.length === 0) {
    return `${header}\n  media: none`;
  }
  return [
    header,
    ...summary.media.map((media) => `  media: kind=${media.kind} content_type=${formatMaybeValue(media.contentType)} dimensions=${formatMaybeNumber(media.width)}x${formatMaybeNumber(media.height)} status=${media.status} reason=${formatMaybeValue(media.reason)}`),
  ].join("\n");
}

function formatSticker(summary: DiscordStickerSummaryPromptInput): string {
  return `- id=${summary.id} name=${summary.name} format=${summary.format} status=${summary.status} reason=${formatMaybeValue(summary.reason)}`;
}

function countPhrase(count: number, singular: string): string {
  return count === 1 ? `one ${singular}` : `${String(count)} ${singular}s`;
}

function singleEmbedPhrase(summary: DiscordEmbedSummaryPromptInput): string {
  if (summary.type === "gifv") {
    return "one GIF embed";
  }
  return summary.type === "unknown" ? "one embed" : `one ${summary.type} embed`;
}

function singleStickerPhrase(summary: DiscordStickerSummaryPromptInput): string {
  const format = summary.format === "gif"
    ? "GIF"
    : summary.format === "apng"
      ? "APNG"
      : summary.format === "lottie"
        ? "Lottie"
        : summary.format;
  return summary.format === "unknown" ? "one sticker" : `one ${format} sticker`;
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
  embeds: readonly DiscordEmbedSummaryPromptInput[];
  stickers: readonly DiscordStickerSummaryPromptInput[];
  media?: readonly string[];
  body?: string;
}): string {
  const attachments = options.attachments.length === 0
    ? "- none"
    : options.attachments.map(formatAttachment).join("\n");
  const downloadedMedia = !options.media?.length ? "- none" : options.media.join("\n");
  const mediaNote = (options.media?.length ?? 0) > 1
    ? `media_note: all ${String(options.media!.length)} downloaded media files belong to this message; inspect each path with view_media and do not ask for separate uploads.`
    : undefined;
  const embeds = options.embeds.length === 0 ? "- none" : options.embeds.map(formatEmbed).join("\n");
  const stickers = options.stickers.length === 0 ? "- none" : options.stickers.map(formatSticker).join("\n");
  const trimmedBody = options.body?.trim() ?? "";
  const attachmentCount = options.attachments.length;
  const parts = [
    attachmentCount > 0 ? countPhrase(attachmentCount, "attachment") : undefined,
    options.embeds.length === 1
      ? singleEmbedPhrase(options.embeds[0]!)
      : options.embeds.length > 1 ? countPhrase(options.embeds.length, "embed") : undefined,
    options.stickers.length === 1
      ? singleStickerPhrase(options.stickers[0]!)
      : options.stickers.length > 1 ? countPhrase(options.stickers.length, "sticker") : undefined,
  ].filter((part): part is string => Boolean(part));
  const body = trimmedBody || `Discord message with ${parts.join(", ")}.`;

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
embeds:
${embeds}
stickers:
${stickers}
downloaded_media:
${downloadedMedia}
${mediaNote ?? ""}
</runtime-channel-context>

${body}
`.trim();
}
