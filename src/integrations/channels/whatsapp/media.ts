import type {WAMessage, WASocket} from "baileys";
import {downloadMediaMessage, normalizeMessageContent} from "baileys/lib/Utils/messages.js";

import type {WriteMediaInput} from "../../../domain/channels/media-store.js";
import type {MediaDescriptor} from "../../../domain/channels/types.js";
import type {JsonObject} from "../../../lib/json.js";
import {WHATSAPP_SOURCE} from "./config.js";
import {WHATSAPP_LOGGER} from "./transport.js";

export interface WhatsAppMediaPart {
  mimeType: string;
  sizeBytes?: number;
  hintFilename?: string;
  metadata?: JsonObject;
}

export interface WhatsAppMediaStore {
  writeMedia(input: WriteMediaInput): Promise<MediaDescriptor>;
}

export interface DownloadWhatsAppSupportedMediaOptions {
  connectorKey: string;
  mediaStore: WhatsAppMediaStore;
  reuploadRequest: WASocket["updateMediaMessage"];
  parts?: readonly WhatsAppMediaPart[];
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
  options: DownloadWhatsAppSupportedMediaOptions,
): Promise<MediaDescriptor> {
  const bytes = new Uint8Array(await downloadMediaMessage(message, "buffer", {}, {
    reuploadRequest: options.reuploadRequest,
    logger: WHATSAPP_LOGGER,
  }));

  return options.mediaStore.writeMedia({
    bytes,
    source: WHATSAPP_SOURCE,
    connectorKey: options.connectorKey,
    mimeType: part.mimeType,
    sizeBytes: part.sizeBytes,
    hintFilename: part.hintFilename,
    metadata: buildWhatsAppMediaMetadata(message, part),
  });
}

export async function downloadWhatsAppSupportedMedia(
  message: WAMessage,
  options: DownloadWhatsAppSupportedMediaOptions,
): Promise<readonly MediaDescriptor[]> {
  const descriptors: MediaDescriptor[] = [];
  for (const part of options.parts ?? collectWhatsAppMediaParts(message)) {
    descriptors.push(await downloadWhatsAppMediaPart(message, part, options));
  }

  return descriptors;
}
