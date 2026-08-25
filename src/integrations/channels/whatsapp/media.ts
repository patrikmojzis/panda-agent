import {createWriteStream} from "node:fs";
import * as fs from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {Transform} from "node:stream";
import {pipeline} from "node:stream/promises";

import type {WAMessage, WASocket} from "baileys";
import {downloadMediaMessage, normalizeMessageContent} from "baileys/lib/Utils/messages.js";

import {
  discardStagedMediaDescriptor,
  discardStagedMediaDescriptors,
  type WriteMediaFileInput,
} from "../../../domain/channels/media-store.js";
import type {MediaDescriptor} from "../../../domain/channels/types.js";
import type {JsonObject} from "../../../lib/json.js";
import {WHATSAPP_SOURCE} from "./config.js";
import {WhatsAppMediaPolicyError} from "./media-work-queue.js";
import {readWhatsAppMessageSentAtMs} from "./helpers.js";
import {WHATSAPP_LOGGER} from "./transport.js";

export interface WhatsAppMediaPart {
  mimeType: string;
  sizeBytes?: number;
  hintFilename?: string;
  metadata?: JsonObject;
}

export interface WhatsAppMediaStore {
  writeMediaFile(input: WriteMediaFileInput): Promise<MediaDescriptor>;
}

export interface DownloadWhatsAppSupportedMediaOptions {
  connectorKey: string;
  mediaStore: WhatsAppMediaStore;
  reuploadRequest: WASocket["updateMediaMessage"];
  parts?: readonly WhatsAppMediaPart[];
  maxBytes: number;
  timeoutMs: number;
  signal?: AbortSignal;
  onCleanupError?(error: unknown): void;
}

function readWhatsAppMediaSizeBytes(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }

  if (typeof value === "object" && value !== null && "toNumber" in value && typeof value.toNumber === "function") {
    const numericValue = value.toNumber();
    if (typeof numericValue === "number" && Number.isFinite(numericValue) && numericValue >= 0) {
      return numericValue;
    }
  }

  return undefined;
}

export function collectWhatsAppMediaParts(message: WAMessage): readonly WhatsAppMediaPart[] {
  const content = normalizeMessageContent(message.message);
  if (!content) {
    return [];
  }

  const parts: WhatsAppMediaPart[] = [];

  if (content.imageMessage) {
    parts.push({
      mimeType: content.imageMessage.mimetype ?? "image/jpeg",
      sizeBytes: readWhatsAppMediaSizeBytes(content.imageMessage.fileLength),
    });
  }

  if (content.videoMessage) {
    parts.push({
      mimeType: content.videoMessage.mimetype ?? "video/mp4",
      sizeBytes: readWhatsAppMediaSizeBytes(content.videoMessage.fileLength),
      metadata: {
        whatsappMediaKind: "video",
      },
    });
  }

  if (content.documentMessage) {
    parts.push({
      mimeType: content.documentMessage.mimetype ?? "application/octet-stream",
      sizeBytes: readWhatsAppMediaSizeBytes(content.documentMessage.fileLength),
      hintFilename: content.documentMessage.fileName ?? undefined,
    });
  }

  if (content.stickerMessage) {
    parts.push({
      mimeType: content.stickerMessage.mimetype ?? "image/webp",
      sizeBytes: readWhatsAppMediaSizeBytes(content.stickerMessage.fileLength),
      metadata: {
        whatsappMediaKind: "sticker",
        isAnimated: content.stickerMessage.isAnimated ?? null,
      },
    });
  }

  if (content.audioMessage) {
    parts.push({
      mimeType: content.audioMessage.mimetype ?? "audio/ogg",
      sizeBytes: readWhatsAppMediaSizeBytes(content.audioMessage.fileLength),
      metadata: {
        whatsappMediaKind: "audio",
        ptt: content.audioMessage.ptt ?? null,
      },
    });
  }

  return parts;
}

function buildWhatsAppMediaMetadata(message: WAMessage, part: WhatsAppMediaPart): JsonObject {
  return {
    whatsappMessageId: message.key.id ?? null,
    whatsappRemoteJid: message.key.remoteJid ?? null,
    ...part.metadata,
  };
}

async function downloadWhatsAppMediaPart(
  message: WAMessage,
  part: WhatsAppMediaPart,
  partIndex: number,
  options: DownloadWhatsAppSupportedMediaOptions,
  maxBytes: number,
): Promise<MediaDescriptor> {
  if (part.sizeBytes !== undefined && part.sizeBytes > maxBytes) {
    throw new WhatsAppMediaPolicyError(
      "media_too_large",
      `WhatsApp media exceeds the ${String(options.maxBytes)} byte message limit.`,
    );
  }

  const timeoutController = new AbortController();
  const timeout = setTimeout(() => {
    timeoutController.abort(new WhatsAppMediaPolicyError(
      "media_timeout",
      `WhatsApp media download timed out after ${String(options.timeoutMs)}ms.`,
    ));
  }, options.timeoutMs);
  timeout.unref?.();
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutController.signal])
    : timeoutController.signal;
  const temporaryDirectory = await fs.mkdtemp(path.join(tmpdir(), "panda-whatsapp-media-"));
  const temporaryPath = path.join(temporaryDirectory, "media.bin");
  let downloadedBytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer | Uint8Array, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      downloadedBytes += bytes.byteLength;
      if (downloadedBytes > maxBytes) {
        callback(new WhatsAppMediaPolicyError(
          "media_too_large",
          `WhatsApp media exceeds the ${String(options.maxBytes)} byte message limit.`,
        ));
        return;
      }
      callback(null, bytes);
    },
  });

  try {
    const streamPromise = downloadMediaMessage(message, "stream", {options: {signal}}, {
      reuploadRequest: options.reuploadRequest,
      logger: WHATSAPP_LOGGER,
    });
    const stream = await new Promise<Awaited<typeof streamPromise>>((resolve, reject) => {
      const onAbort = () => reject(signal.reason ?? new Error("WhatsApp media download aborted."));
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, {once: true});
      void streamPromise.then((value) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) {
          value.destroy(signal.reason instanceof Error ? signal.reason : undefined);
          return;
        }
        resolve(value);
      }, (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      });
    });
    await pipeline(
      stream,
      limiter,
      createWriteStream(temporaryPath, {flags: "wx"}),
      {signal},
    );
    if (part.sizeBytes !== undefined && part.sizeBytes !== downloadedBytes) {
      throw new WhatsAppMediaPolicyError(
        "media_invalid",
        `WhatsApp media declared ${String(part.sizeBytes)} bytes but downloaded ${String(downloadedBytes)}.`,
      );
    }

    const descriptor = await options.mediaStore.writeMediaFile({
      path: temporaryPath,
      source: WHATSAPP_SOURCE,
      connectorKey: options.connectorKey,
      mimeType: part.mimeType,
      sizeBytes: downloadedBytes,
      hintFilename: part.hintFilename,
      metadata: buildWhatsAppMediaMetadata(message, part),
      idempotencyKey: `${message.key.remoteJid ?? "unknown"}:${message.key.id ?? "unknown"}:${partIndex}`,
      createdAt: readWhatsAppMessageSentAtMs(message.messageTimestamp) ?? 0,
    });
    if (signal.aborted) {
      try {
        await discardStagedMediaDescriptor(descriptor);
      } catch (cleanupError) {
        options.onCleanupError?.(cleanupError);
      }
      throw signal.reason ?? new WhatsAppMediaPolicyError("media_aborted", "WhatsApp media download was aborted.");
    }
    return descriptor;
  } catch (error) {
    if (timeoutController.signal.aborted && !options.signal?.aborted) {
      throw timeoutController.signal.reason;
    }
    if (options.signal?.aborted) {
      throw new WhatsAppMediaPolicyError("media_aborted", "WhatsApp media download was aborted.", {cause: error});
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    try {
      await fs.rm(temporaryDirectory, {recursive: true, force: true});
    } catch (cleanupError) {
      options.onCleanupError?.(cleanupError);
    }
  }
}

export async function downloadWhatsAppSupportedMedia(
  message: WAMessage,
  options: DownloadWhatsAppSupportedMediaOptions,
): Promise<readonly MediaDescriptor[]> {
  const descriptors: MediaDescriptor[] = [];
  try {
    for (const [partIndex, part] of (options.parts ?? collectWhatsAppMediaParts(message)).entries()) {
      const remainingBytes = options.maxBytes - descriptors.reduce(
        (total, descriptor) => total + descriptor.sizeBytes,
        0,
      );
      descriptors.push(await downloadWhatsAppMediaPart(message, part, partIndex, options, remainingBytes));
    }
  } catch (error) {
    try {
      await discardStagedMediaDescriptors(descriptors);
    } catch (cleanupError) {
      options.onCleanupError?.(cleanupError);
    }
    throw error;
  }

  return descriptors;
}
