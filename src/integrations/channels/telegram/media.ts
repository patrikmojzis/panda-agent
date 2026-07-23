import type {Context} from "grammy";

import type {WriteMediaInput} from "../../../domain/channels/media-store.js";
import type {MediaDescriptor} from "../../../domain/channels/types.js";
import type {JsonObject} from "../../../lib/json.js";
import {trimToUndefined} from "../../../lib/strings.js";
import {TELEGRAM_SOURCE} from "./config.js";

type TelegramContext = Context;

const TELEGRAM_BOT_API_DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024;
const TELEGRAM_FILE_DOWNLOAD_TIMEOUT_MS = 30_000;

export type TelegramMediaKind =
  | "photo"
  | "document"
  | "voice"
  | "sticker"
  | "video"
  | "audio"
  | "animation"
  | "video_note";

export interface TelegramUnavailableMedia {
  kind: TelegramMediaKind;
  mimeType: string;
  sizeBytes?: number;
  filename?: string;
  reason: string;
}

export interface TelegramMediaDownloadResult {
  media: readonly MediaDescriptor[];
  unavailable: readonly TelegramUnavailableMedia[];
}

export interface TelegramMediaPart {
  kind: TelegramMediaKind;
  fileId: string;
  fileUniqueId: string;
  mimeType: string;
  sizeBytes?: number;
  hintFilename?: string;
  metadata?: JsonObject;
}

export interface TelegramFileApi {
  getFile(fileId: string): Promise<{
    file_path?: string;
  }>;
}

export interface TelegramMediaStore {
  writeMedia(input: WriteMediaInput): Promise<MediaDescriptor>;
}

export interface DownloadTelegramSupportedMediaOptions {
  api: TelegramFileApi;
  token: string;
  connectorKey: string;
  mediaStore: TelegramMediaStore;
  fetchImpl?: typeof fetch;
  onUnavailable?: (item: TelegramUnavailableMedia) => void;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isTelegramFileTooBigError(error: unknown): boolean {
  return error instanceof Error && /file is too big/i.test(error.message);
}

function shouldSkipTelegramDownload(sizeBytes: number | undefined): boolean {
  return typeof sizeBytes === "number"
    && Number.isFinite(sizeBytes)
    && sizeBytes > TELEGRAM_BOT_API_DOWNLOAD_LIMIT_BYTES;
}

function renderUnavailableMediaNotice(items: readonly TelegramUnavailableMedia[]): string {
  if (items.length === 0) {
    return "";
  }

  const lines = items.map((item) => {
    const details = [
      item.filename ? `filename: ${item.filename}` : undefined,
      `mime_type: ${item.mimeType}`,
      item.sizeBytes === undefined ? undefined : `size_bytes: ${item.sizeBytes}`,
      `reason: ${item.reason}`,
    ].filter((line): line is string => Boolean(line));

    return `- ${item.kind}\n  ${details.join("\n  ")}`;
  });

  return [
    "Telegram attachment unavailable:",
    ...lines,
  ].join("\n");
}

export function mergeTextWithUnavailableMediaNotice(
  text: string,
  unavailable: readonly TelegramUnavailableMedia[],
): string {
  const notice = renderUnavailableMediaNotice(unavailable);
  if (!notice) {
    return text;
  }

  return [text, notice].filter(Boolean).join("\n\n");
}

function inferTelegramAnimationMimeType(animation: NonNullable<TelegramContext["msg"]>["animation"]): string {
  const mimeType = trimToUndefined(animation?.mime_type);
  if (mimeType) {
    return mimeType;
  }

  const filename = animation?.file_name?.toLowerCase() ?? "";
  if (filename.endsWith(".mp4")) {
    return "video/mp4";
  }
  if (filename.endsWith(".webm")) {
    return "video/webm";
  }

  return "image/gif";
}

function inferTelegramStickerMimeType(sticker: NonNullable<TelegramContext["msg"]>["sticker"]): string {
  if (sticker?.is_video) {
    return "video/webm";
  }
  if (sticker?.is_animated) {
    return "application/x-tgsticker";
  }

  return "image/webp";
}

export function collectTelegramMediaParts(message: TelegramContext["msg"]): readonly TelegramMediaPart[] {
  if (!message) {
    return [];
  }

  const parts: TelegramMediaPart[] = [];
  const photo = message.photo?.at(-1);
  if (photo) {
    parts.push({
      kind: "photo",
      fileId: photo.file_id,
      fileUniqueId: photo.file_unique_id,
      mimeType: "image/jpeg",
      sizeBytes: photo.file_size,
      metadata: {
        telegramMediaKind: "photo",
        width: photo.width,
        height: photo.height,
      },
    });
  }

  if (message.document && !message.animation) {
    parts.push({
      kind: "document",
      fileId: message.document.file_id,
      fileUniqueId: message.document.file_unique_id,
      mimeType: message.document.mime_type ?? "application/octet-stream",
      sizeBytes: message.document.file_size,
      hintFilename: message.document.file_name,
      metadata: {
        telegramMediaKind: "document",
      },
    });
  }

  if (message.voice) {
    parts.push({
      kind: "voice",
      fileId: message.voice.file_id,
      fileUniqueId: message.voice.file_unique_id,
      mimeType: message.voice.mime_type ?? "audio/ogg",
      sizeBytes: message.voice.file_size,
      metadata: {
        telegramMediaKind: "voice",
        duration: message.voice.duration,
      },
    });
  }

  if (message.sticker) {
    parts.push({
      kind: "sticker",
      fileId: message.sticker.file_id,
      fileUniqueId: message.sticker.file_unique_id,
      mimeType: inferTelegramStickerMimeType(message.sticker),
      sizeBytes: message.sticker.file_size,
      metadata: {
        telegramMediaKind: "sticker",
        emoji: message.sticker.emoji ?? null,
        setName: message.sticker.set_name ?? null,
        stickerType: message.sticker.type,
        stickerFormat: message.sticker.is_video ? "video" : message.sticker.is_animated ? "animated" : "static",
        isAnimated: message.sticker.is_animated,
        isVideo: message.sticker.is_video,
        width: message.sticker.width,
        height: message.sticker.height,
      },
    });
  }

  if (message.video) {
    parts.push({
      kind: "video",
      fileId: message.video.file_id,
      fileUniqueId: message.video.file_unique_id,
      mimeType: message.video.mime_type ?? "video/mp4",
      sizeBytes: message.video.file_size,
      hintFilename: message.video.file_name,
      metadata: {
        telegramMediaKind: "video",
        duration: message.video.duration,
        width: message.video.width,
        height: message.video.height,
      },
    });
  }

  if (message.audio) {
    parts.push({
      kind: "audio",
      fileId: message.audio.file_id,
      fileUniqueId: message.audio.file_unique_id,
      mimeType: message.audio.mime_type ?? "audio/mpeg",
      sizeBytes: message.audio.file_size,
      hintFilename: message.audio.file_name,
      metadata: {
        telegramMediaKind: "audio",
        duration: message.audio.duration,
        title: message.audio.title ?? null,
        performer: message.audio.performer ?? null,
      },
    });
  }

  if (message.animation) {
    parts.push({
      kind: "animation",
      fileId: message.animation.file_id,
      fileUniqueId: message.animation.file_unique_id,
      mimeType: inferTelegramAnimationMimeType(message.animation),
      sizeBytes: message.animation.file_size,
      hintFilename: message.animation.file_name,
      metadata: {
        telegramMediaKind: "animation",
        duration: message.animation.duration,
        width: message.animation.width,
        height: message.animation.height,
      },
    });
  }

  if (message.video_note) {
    parts.push({
      kind: "video_note",
      fileId: message.video_note.file_id,
      fileUniqueId: message.video_note.file_unique_id,
      mimeType: "video/mp4",
      sizeBytes: message.video_note.file_size,
      metadata: {
        telegramMediaKind: "video_note",
        duration: message.video_note.duration,
        length: message.video_note.length,
      },
    });
  }

  return parts;
}

function buildUnavailableTelegramMedia(part: TelegramMediaPart, reason: string): TelegramUnavailableMedia {
  return {
    kind: part.kind,
    mimeType: part.mimeType,
    sizeBytes: part.sizeBytes,
    filename: part.hintFilename,
    reason,
  };
}

function markUnavailable(
  part: TelegramMediaPart,
  reason: string,
  options: DownloadTelegramSupportedMediaOptions,
): {unavailable: TelegramUnavailableMedia} {
  const unavailable = buildUnavailableTelegramMedia(part, reason);
  options.onUnavailable?.(unavailable);
  return {unavailable};
}

async function downloadTelegramMediaPart(
  part: TelegramMediaPart,
  options: DownloadTelegramSupportedMediaOptions,
): Promise<MediaDescriptor> {
  const file = await options.api.getFile(part.fileId);
  if (!file.file_path) {
    throw new Error(`Telegram file ${part.fileId} has no file_path.`);
  }

  const controller = new globalThis.AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, TELEGRAM_FILE_DOWNLOAD_TIMEOUT_MS);
  timeout.unref?.();

  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(`https://api.telegram.org/file/bot${options.token}/${file.file_path}`, {
      signal: controller.signal,
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error(`Telegram file ${part.fileId} download timed out after ${TELEGRAM_FILE_DOWNLOAD_TIMEOUT_MS}ms.`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`Failed to download Telegram file ${part.fileId}: ${response.status} ${response.statusText}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  return options.mediaStore.writeMedia({
    bytes,
    source: TELEGRAM_SOURCE,
    connectorKey: options.connectorKey,
    mimeType: part.mimeType,
    sizeBytes: part.sizeBytes,
    hintFilename: part.hintFilename,
    metadata: {
      telegramFileId: part.fileId,
      telegramFileUniqueId: part.fileUniqueId,
      telegramFilePath: file.file_path,
      ...(part.metadata ?? {}),
    },
  });
}

async function downloadTelegramFileOrUnavailable(
  part: TelegramMediaPart,
  options: DownloadTelegramSupportedMediaOptions,
): Promise<{media: MediaDescriptor} | {unavailable: TelegramUnavailableMedia}> {
  if (shouldSkipTelegramDownload(part.sizeBytes)) {
    return markUnavailable(part, "Telegram Bot API only exposes bot-downloadable files up to 20 MB.", options);
  }

  try {
    return {
      media: await downloadTelegramMediaPart(part, options),
    };
  } catch (error) {
    if (isTelegramFileTooBigError(error)) {
      return markUnavailable(part, "Telegram Bot API refused to expose this file because it is too big.", options);
    }

    throw error;
  }
}

export async function downloadTelegramSupportedMedia(
  message: TelegramContext["msg"],
  options: DownloadTelegramSupportedMediaOptions,
): Promise<TelegramMediaDownloadResult> {
  const media: MediaDescriptor[] = [];
  const unavailable: TelegramUnavailableMedia[] = [];

  for (const part of collectTelegramMediaParts(message)) {
    const result = await downloadTelegramFileOrUnavailable(part, options);
    if ("media" in result) {
      media.push(result.media);
      continue;
    }

    unavailable.push(result.unavailable);
  }

  return {
    media,
    unavailable,
  };
}
