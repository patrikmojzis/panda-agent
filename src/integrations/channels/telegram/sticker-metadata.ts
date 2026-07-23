import type {MediaDescriptor} from "../../../domain/channels/types.js";
import type {JsonObject} from "../../../lib/json.js";
import {isRecord} from "../../../lib/records.js";
import {
  normalizeTelegramStickerFormat,
  normalizeTelegramStickerType,
  type TelegramStickerItem,
} from "../../../domain/agents/telegram-stickers/types.js";

export interface TelegramInboundSticker extends TelegramStickerItem {
  mediaId: string;
  inboundRef: string;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredString(value: unknown): string | null {
  return optionalString(value) ?? null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

export function inferTelegramStickerFormat(input: {is_animated?: boolean; is_video?: boolean}): "static" | "animated" | "video" {
  if (input.is_video) {
    return "video";
  }
  if (input.is_animated) {
    return "animated";
  }
  return "static";
}

export function buildTelegramInboundStickerRef(mediaId: string): string {
  return `tg-in:${mediaId}`;
}

export function parseTelegramInboundStickerRef(value: string): string {
  const normalized = value.trim();
  const match = /^tg-in:([A-Za-z0-9_-]+)$/.exec(normalized);
  if (!match) {
    throw new Error("Telegram inbound sticker reference must use tg-in:<media-id>.");
  }
  return match[1]!;
}

export function readTelegramInboundSticker(media: MediaDescriptor): TelegramInboundSticker | null {
  if (!isRecord(media.metadata) || media.metadata.telegramMediaKind !== "sticker") {
    return null;
  }
  const fileId = requiredString(media.metadata.telegramFileId);
  const fileUniqueId = requiredString(media.metadata.telegramFileUniqueId);
  const width = positiveInteger(media.metadata.width);
  const height = positiveInteger(media.metadata.height);
  if (!fileId || !fileUniqueId || !width || !height) {
    return null;
  }
  try {
    return {
      mediaId: media.id,
      inboundRef: buildTelegramInboundStickerRef(media.id),
      fileId,
      fileUniqueId,
      setName: optionalString(media.metadata.setName),
      emoji: optionalString(media.metadata.emoji),
      stickerType: normalizeTelegramStickerType(media.metadata.stickerType),
      format: normalizeTelegramStickerFormat(media.metadata.stickerFormat),
      width,
      height,
      sizeBytes: media.sizeBytes,
    };
  } catch {
    return null;
  }
}

export function serializeSafeTelegramSticker(sticker: TelegramInboundSticker): JsonObject {
  return {
    stickerRef: sticker.inboundRef,
    ...(sticker.emoji ? {emoji: sticker.emoji} : {}),
    ...(sticker.setName ? {setName: sticker.setName} : {}),
    stickerType: sticker.stickerType,
    format: sticker.format,
    width: sticker.width,
    height: sticker.height,
  };
}

export function describeTelegramSticker(sticker: TelegramInboundSticker): readonly string[] {
  return [
    `sticker_ref: ${sticker.inboundRef}`,
    `sticker_emoji: ${sticker.emoji ?? "null"}`,
    `sticker_set_name: ${sticker.setName ?? "null"}`,
    `sticker_type: ${sticker.stickerType}`,
    `sticker_format: ${sticker.format}`,
    `sticker_dimensions: ${String(sticker.width)}x${String(sticker.height)}`,
  ];
}
