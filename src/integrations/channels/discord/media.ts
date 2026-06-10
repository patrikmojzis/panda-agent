import type {WriteMediaInput} from "../../../domain/channels/media-store.js";
import type {MediaDescriptor} from "../../../domain/channels/types.js";
import {firstNonEmptyString, trimToUndefined} from "../../../lib/strings.js";
import {DISCORD_SOURCE} from "./config.js";

export const DISCORD_ATTACHMENT_DOWNLOAD_LIMIT_BYTES = 25 * 1024 * 1024;
const DISCORD_ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 30_000;
const DISCORD_ATTACHMENT_CDN_HOSTS = new Set([
  "cdn.discordapp.com",
  "media.discordapp.net",
]);

export interface DiscordAttachmentDownloadPart {
  id: string;
  url: string;
  mimeType: string;
  sizeBytes?: number;
  hintFilename?: string;
}

export interface DiscordUnavailableAttachment {
  id: string;
  contentType?: string;
  filename?: string;
  sizeBytes?: number;
  reason: string;
}

export interface DiscordAttachmentDownloadResult {
  media: readonly MediaDescriptor[];
  unavailable: readonly DiscordUnavailableAttachment[];
}

export interface DiscordMediaStore {
  writeMedia(input: WriteMediaInput): Promise<MediaDescriptor>;
}

export interface DownloadDiscordSupportedAttachmentsOptions {
  connectorKey: string;
  mediaStore: DiscordMediaStore;
  fetchImpl?: typeof fetch;
  onUnavailable?: (item: DiscordUnavailableAttachment) => void;
}

function readAttachmentSizeBytes(...values: readonly unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }

  return undefined;
}

function readAttachmentContentType(attachment: Record<string, unknown>): string | undefined {
  return firstNonEmptyString(
    attachment.content_type,
    attachment.contentType,
    attachment.mime_type,
    attachment.mimeType,
  );
}

function readAttachmentDownloadUrl(attachment: Record<string, unknown>): string | undefined {
  return firstNonEmptyString(attachment.url, attachment.proxy_url, attachment.proxyUrl);
}

function readAttachmentFilename(attachment: Record<string, unknown>): string | undefined {
  return firstNonEmptyString(attachment.filename, attachment.name);
}

function readAttachmentDeclaredSizeBytes(attachment: Record<string, unknown>): number | undefined {
  return readAttachmentSizeBytes(attachment.size, attachment.size_bytes, attachment.sizeBytes);
}

function normalizeAttachmentUrl(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.protocol !== "https:" || !DISCORD_ATTACHMENT_CDN_HOSTS.has(url.hostname.toLowerCase())) {
    return null;
  }

  return url;
}

function readContentLength(headers: Headers): number | undefined {
  const raw = headers.get("content-length");
  if (!raw) {
    return undefined;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function buildUnavailableAttachment(
  part: Pick<DiscordAttachmentDownloadPart, "id" | "mimeType" | "sizeBytes" | "hintFilename">,
  reason: string,
): DiscordUnavailableAttachment {
  return {
    id: part.id,
    contentType: part.mimeType,
    filename: part.hintFilename,
    sizeBytes: part.sizeBytes,
    reason,
  };
}

function markUnavailable(
  part: Pick<DiscordAttachmentDownloadPart, "id" | "mimeType" | "sizeBytes" | "hintFilename">,
  reason: string,
  options: DownloadDiscordSupportedAttachmentsOptions,
): {unavailable: DiscordUnavailableAttachment} {
  const unavailable = buildUnavailableAttachment(part, reason);
  options.onUnavailable?.(unavailable);
  return {unavailable};
}

async function readCappedResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new Error("Discord attachment response exceeded download limit.");
    }

    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Discord attachment response exceeded download limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}

type DiscordAttachmentDownloadItem =
  | {kind: "download"; part: DiscordAttachmentDownloadPart}
  | {kind: "unavailable"; unavailable: DiscordUnavailableAttachment};

function collectDiscordAttachmentDownloadItems(value: unknown): readonly DiscordAttachmentDownloadItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const items: DiscordAttachmentDownloadItem[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }

    const attachment = entry as Record<string, unknown>;
    const id = trimToUndefined(attachment.id);
    if (!id) {
      continue;
    }

    const contentType = readAttachmentContentType(attachment);
    const filename = readAttachmentFilename(attachment);
    const sizeBytes = readAttachmentDeclaredSizeBytes(attachment);
    const url = readAttachmentDownloadUrl(attachment);
    if (!url) {
      items.push({
        kind: "unavailable",
        unavailable: {
          id,
          ...(contentType !== undefined ? {contentType} : {}),
          ...(filename !== undefined ? {filename} : {}),
          ...(sizeBytes !== undefined ? {sizeBytes} : {}),
          reason: "Discord attachment does not include a downloadable CDN URL.",
        },
      });
      continue;
    }

    items.push({
      kind: "download",
      part: {
        id,
        url,
        mimeType: contentType ?? "application/octet-stream",
        ...(sizeBytes !== undefined ? {sizeBytes} : {}),
        ...(filename !== undefined ? {hintFilename: filename} : {}),
      },
    });
  }

  return items;
}

export function collectDiscordAttachmentDownloadParts(value: unknown): readonly DiscordAttachmentDownloadPart[] {
  return collectDiscordAttachmentDownloadItems(value)
    .flatMap((item) => item.kind === "download" ? [item.part] : []);
}

async function downloadDiscordAttachmentPart(
  part: DiscordAttachmentDownloadPart,
  options: DownloadDiscordSupportedAttachmentsOptions,
): Promise<MediaDescriptor> {
  const normalizedUrl = normalizeAttachmentUrl(part.url);
  if (!normalizedUrl) {
    throw new Error("Discord attachment URL is not a supported CDN URL.");
  }

  const controller = new globalThis.AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, DISCORD_ATTACHMENT_DOWNLOAD_TIMEOUT_MS);
  timeout.unref?.();

  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(normalizedUrl.toString(), {
      signal: controller.signal,
    });
  } catch {
    throw new Error("Discord attachment download request failed.");
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`Discord attachment download returned HTTP ${response.status}.`);
  }

  const contentLength = readContentLength(response.headers);
  if (contentLength !== undefined && contentLength > DISCORD_ATTACHMENT_DOWNLOAD_LIMIT_BYTES) {
    throw new Error("Discord attachment response exceeded download limit.");
  }

  const bytes = await readCappedResponseBytes(response, DISCORD_ATTACHMENT_DOWNLOAD_LIMIT_BYTES);
  if (part.sizeBytes !== undefined && bytes.byteLength !== part.sizeBytes) {
    throw new Error("Discord attachment payload size did not match declared size.");
  }

  return options.mediaStore.writeMedia({
    bytes,
    source: DISCORD_SOURCE,
    connectorKey: options.connectorKey,
    mimeType: part.mimeType,
    sizeBytes: part.sizeBytes,
    hintFilename: part.hintFilename,
    metadata: {
      discordAttachmentId: part.id,
    },
  });
}

async function downloadDiscordAttachmentOrUnavailable(
  part: DiscordAttachmentDownloadPart,
  options: DownloadDiscordSupportedAttachmentsOptions,
): Promise<{media: MediaDescriptor} | {unavailable: DiscordUnavailableAttachment}> {
  if (part.sizeBytes !== undefined && part.sizeBytes > DISCORD_ATTACHMENT_DOWNLOAD_LIMIT_BYTES) {
    return markUnavailable(part, "Discord attachment exceeds the 25 MB download limit.", options);
  }

  if (!normalizeAttachmentUrl(part.url)) {
    return markUnavailable(part, "Discord attachment URL is not a supported CDN URL.", options);
  }

  try {
    return {
      media: await downloadDiscordAttachmentPart(part, options),
    };
  } catch {
    return markUnavailable(part, "Discord attachment download failed.", options);
  }
}

export async function downloadDiscordSupportedAttachments(
  attachments: unknown,
  options: DownloadDiscordSupportedAttachmentsOptions,
): Promise<DiscordAttachmentDownloadResult> {
  const media: MediaDescriptor[] = [];
  const unavailable: DiscordUnavailableAttachment[] = [];

  for (const item of collectDiscordAttachmentDownloadItems(attachments)) {
    if (item.kind === "unavailable") {
      options.onUnavailable?.(item.unavailable);
      unavailable.push(item.unavailable);
      continue;
    }

    const result = await downloadDiscordAttachmentOrUnavailable(item.part, options);
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
