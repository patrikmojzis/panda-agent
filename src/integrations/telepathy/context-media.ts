import type {WriteMediaInput} from "../../domain/channels/media-store.js";
import type {MediaDescriptor} from "../../domain/channels/types.js";
import {TELEPATHY_SOURCE} from "./config.js";
import {
  decodeTelepathyMediaPayload,
  type TelepathyContextAudioItem,
  type TelepathyContextImageItem,
  type TelepathyContextItem,
} from "./protocol.js";

const EXTENSIONS_BY_MIME_TYPE = new Map<string, string>([
  ["audio/m4a", ".m4a"],
  ["audio/mp4", ".m4a"],
  ["audio/mpeg", ".mp3"],
  ["audio/ogg", ".ogg"],
  ["audio/opus", ".opus"],
  ["audio/wav", ".wav"],
  ["audio/webm", ".webm"],
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
]);

export interface TelepathyContextMediaMetadata {
  frontmostApp?: string;
  trigger?: string;
  windowTitle?: string;
}

export interface TelepathyContextMediaStore {
  writeMedia(input: WriteMediaInput): Promise<MediaDescriptor>;
}

export interface PersistTelepathyContextItemsOptions {
  agentKey: string;
  deviceId: string;
  requestId: string;
  mode: string;
  label?: string;
  metadata?: TelepathyContextMediaMetadata;
  items: readonly TelepathyContextItem[];
  mediaStore: TelepathyContextMediaStore;
}

export interface PersistedTelepathyContextItems {
  media: readonly MediaDescriptor[];
  textParts: readonly string[];
}

function inferExtension(mimeType: string): string {
  return EXTENSIONS_BY_MIME_TYPE.get(mimeType.toLowerCase()) ?? ".bin";
}

function buildHintFilename(
  item: TelepathyContextAudioItem | TelepathyContextImageItem,
  requestId: string,
  index: number,
): string {
  if (item.filename?.trim()) {
    return item.filename.trim();
  }

  return `${requestId}-${item.type}-${index + 1}${inferExtension(item.mimeType)}`;
}

function decodeContextMedia(item: TelepathyContextAudioItem | TelepathyContextImageItem): Buffer {
  return decodeTelepathyMediaPayload({
    data: item.data,
    ...(item.bytes !== undefined ? {bytes: item.bytes} : {}),
    kind: item.type,
  });
}

/**
 * Persists Telepathy push-context items as channel media and separates text payloads.
 */
export async function persistTelepathyContextItems(
  options: PersistTelepathyContextItemsOptions,
): Promise<PersistedTelepathyContextItems> {
  const media: MediaDescriptor[] = [];
  const textParts: string[] = [];

  for (const [index, item] of options.items.entries()) {
    if (item.type === "text") {
      textParts.push(item.text);
      continue;
    }

    const bytes = decodeContextMedia(item);
    const descriptor = await options.mediaStore.writeMedia({
      bytes,
      source: TELEPATHY_SOURCE,
      connectorKey: options.deviceId,
      mimeType: item.mimeType,
      hintFilename: buildHintFilename(item, options.requestId, index),
      metadata: {
        requestId: options.requestId,
        deviceId: options.deviceId,
        agentKey: options.agentKey,
        label: options.label ?? null,
        mode: options.mode,
        itemType: item.type,
        itemIndex: index,
        frontmostApp: options.metadata?.frontmostApp ?? null,
        windowTitle: options.metadata?.windowTitle ?? null,
        trigger: options.metadata?.trigger ?? null,
      },
    });
    media.push(descriptor);
  }

  return {
    media,
    textParts,
  };
}
