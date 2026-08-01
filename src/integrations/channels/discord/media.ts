import type {WriteMediaInput} from "../../../domain/channels/media-store.js";
import type {MediaDescriptor} from "../../../domain/channels/types.js";
import type {
  DiscordEmbedMediaSummary,
  DiscordEmbedSummary,
  DiscordMediaReason,
  DiscordStickerFormat,
  DiscordStickerSummary,
} from "../../../domain/threads/requests/types.js";
import {firstNonEmptyString, trimToUndefined} from "../../../lib/strings.js";
import {DISCORD_SOURCE} from "./config.js";

export const DISCORD_ATTACHMENT_DOWNLOAD_LIMIT_BYTES = 25 * 1024 * 1024;
const DISCORD_ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_DISCORD_EMBEDS = 10;
const MAX_DISCORD_STICKERS = 3;
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

export interface DiscordEmbedDownloadResult {
  media: readonly MediaDescriptor[];
  summaries: readonly DiscordEmbedSummary[];
}

export interface DiscordStickerDownloadResult {
  media: readonly MediaDescriptor[];
  summaries: readonly DiscordStickerSummary[];
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

function compactString(value: unknown, maxLength: number): string | undefined {
  const normalized = trimToUndefined(value);
  if (!normalized) {
    return undefined;
  }
  const sanitized = normalized
    .replace(/https:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\/\S+/giu, "[discord-media]")
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!sanitized) {
    return undefined;
  }
  return sanitized.length <= maxLength ? sanitized : sanitized.slice(0, maxLength);
}

function readDimension(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function baseContentType(value: string | null | undefined): string | undefined {
  const [raw] = value?.split(";") ?? [];
  return trimToUndefined(raw)?.toLowerCase();
}

interface DiscordEmbedCandidate {
  kind: DiscordEmbedMediaSummary["kind"];
  url?: string;
  contentType?: string;
  width?: number;
  height?: number;
}

interface DiscordEmbedEntry {
  candidate?: DiscordEmbedCandidate;
  index: number;
  summary: DiscordEmbedSummary;
}

function readEmbedCandidate(embed: Record<string, unknown>, type: string): DiscordEmbedCandidate | undefined {
  const order: readonly DiscordEmbedMediaSummary["kind"][] = type === "gifv"
    ? ["video", "image", "thumbnail"]
    : ["image", "video", "thumbnail"];
  let metadataOnlyCandidate: DiscordEmbedCandidate | undefined;
  for (const kind of order) {
    const raw = embed[kind];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      continue;
    }
    const media = raw as Record<string, unknown>;
    const candidate = {
      kind,
      url: firstNonEmptyString(media.proxy_url, media.proxyUrl, media.url),
      contentType: firstNonEmptyString(media.content_type, media.contentType),
      width: readDimension(media.width),
      height: readDimension(media.height),
    };
    if (candidate.url) {
      return candidate;
    }
    metadataOnlyCandidate ??= candidate;
  }
  return metadataOnlyCandidate;
}

function initialEmbedMediaSummary(candidate: DiscordEmbedCandidate): DiscordEmbedMediaSummary {
  const trusted = candidate.url ? normalizeAttachmentUrl(candidate.url) : null;
  return {
    kind: candidate.kind,
    ...(candidate.contentType !== undefined ? {contentType: candidate.contentType} : {}),
    ...(candidate.width !== undefined ? {width: candidate.width} : {}),
    ...(candidate.height !== undefined ? {height: candidate.height} : {}),
    status: "metadata_only",
    ...(!candidate.url
      ? {reason: "no_trusted_media" as const}
      : !trusted
        ? {reason: "untrusted_url" as const}
        : {}),
  };
}

function collectDiscordEmbedEntries(value: unknown): readonly DiscordEmbedEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.slice(0, MAX_DISCORD_EMBEDS).flatMap((raw, index) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return [];
    }
    const embed = raw as Record<string, unknown>;
    const type = compactString(embed.type, 32) ?? "unknown";
    const provider = typeof embed.provider === "object" && embed.provider !== null && !Array.isArray(embed.provider)
      ? embed.provider as Record<string, unknown>
      : undefined;
    const candidate = readEmbedCandidate(embed, type);
    return [{
      index,
      ...(candidate !== undefined ? {candidate} : {}),
      summary: {
        type,
        ...(compactString(embed.title, 256) !== undefined ? {title: compactString(embed.title, 256)} : {}),
        ...(compactString(embed.description, 1_000) !== undefined
          ? {description: compactString(embed.description, 1_000)}
          : {}),
        ...(compactString(provider?.name, 128) !== undefined
          ? {providerName: compactString(provider?.name, 128)}
          : {}),
        media: candidate ? [initialEmbedMediaSummary(candidate)] : [],
      },
    }];
  });
}

export function readDiscordEmbedSummaries(value: unknown): readonly DiscordEmbedSummary[] {
  return collectDiscordEmbedEntries(value).map((entry) => entry.summary);
}

function normalizeStickerFormat(value: unknown): DiscordStickerFormat {
  switch (value) {
    case 1:
      return "png";
    case 2:
      return "apng";
    case 3:
      return "lottie";
    case 4:
      return "gif";
    default:
      return "unknown";
  }
}

interface DiscordStickerEntry {
  summary: DiscordStickerSummary;
}

function collectDiscordStickerEntries(value: unknown): readonly DiscordStickerEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.slice(0, MAX_DISCORD_STICKERS).flatMap((raw) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return [];
    }
    const sticker = raw as Record<string, unknown>;
    const id = trimToUndefined(sticker.id);
    const name = compactString(sticker.name, 100);
    if (!id || !/^\d{1,20}$/u.test(id) || !name) {
      return [];
    }
    const format = normalizeStickerFormat(sticker.format_type ?? sticker.formatType);
    const unsupported = format === "lottie" || format === "unknown";
    return [{
      summary: {
        id,
        name,
        format,
        status: unsupported ? "unsupported" : "metadata_only",
        ...(unsupported ? {reason: "unsupported_format" as const} : {}),
      },
    }];
  });
}

export function readDiscordStickerSummaries(value: unknown): readonly DiscordStickerSummary[] {
  return collectDiscordStickerEntries(value).map((entry) => entry.summary);
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

class DiscordVisualDownloadError extends Error {
  readonly reason: DiscordMediaReason;

  constructor(reason: DiscordMediaReason) {
    super(reason);
    this.reason = reason;
  }
}

interface DiscordVisualDownloadInput {
  acceptedContentTypes?: readonly string[];
  hintFilename: string;
  metadata: Record<string, string | number>;
  url: string;
}

async function downloadDiscordVisualMedia(
  input: DiscordVisualDownloadInput,
  options: DownloadDiscordSupportedAttachmentsOptions,
): Promise<{descriptor: MediaDescriptor; contentType: string}> {
  const normalizedUrl = normalizeAttachmentUrl(input.url);
  if (!normalizedUrl) {
    throw new DiscordVisualDownloadError("untrusted_url");
  }
  const controller = new globalThis.AbortController();
  const timeout = setTimeout(() => controller.abort(), DISCORD_ATTACHMENT_DOWNLOAD_TIMEOUT_MS);
  timeout.unref?.();

  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(normalizedUrl.toString(), {
      redirect: "error",
      signal: controller.signal,
    });
  } catch {
    throw new DiscordVisualDownloadError("download_failed");
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new DiscordVisualDownloadError("download_failed");
  }

  const contentType = baseContentType(response.headers.get("content-type"));
  const accepted = input.acceptedContentTypes?.map((value) => value.toLowerCase());
  if (!contentType || (accepted
    ? !accepted.includes(contentType)
    : !contentType.startsWith("image/") && !contentType.startsWith("video/"))) {
    throw new DiscordVisualDownloadError("invalid_content_type");
  }
  const contentLength = readContentLength(response.headers);
  if (contentLength !== undefined && contentLength > DISCORD_ATTACHMENT_DOWNLOAD_LIMIT_BYTES) {
    throw new DiscordVisualDownloadError("too_large");
  }

  let bytes: Uint8Array;
  try {
    bytes = await readCappedResponseBytes(response, DISCORD_ATTACHMENT_DOWNLOAD_LIMIT_BYTES);
  } catch {
    throw new DiscordVisualDownloadError("too_large");
  }
  const descriptor = await options.mediaStore.writeMedia({
    bytes,
    source: DISCORD_SOURCE,
    connectorKey: options.connectorKey,
    mimeType: contentType,
    sizeBytes: bytes.byteLength,
    hintFilename: input.hintFilename,
    metadata: input.metadata,
  });
  return {descriptor, contentType};
}

function failedMediaStatus(reason: DiscordMediaReason): "metadata_only" | "unsupported" | "failed" {
  if (reason === "no_trusted_media" || reason === "untrusted_url") {
    return "metadata_only";
  }
  return reason === "unsupported_format" || reason === "invalid_content_type" ? "unsupported" : "failed";
}

function replaceEmbedMediaStatus(
  summary: DiscordEmbedSummary,
  status: DiscordEmbedMediaSummary["status"],
  contentType?: string,
  reason?: DiscordMediaReason,
): DiscordEmbedSummary {
  const current = summary.media[0];
  if (!current) {
    return summary;
  }
  return {
    ...summary,
    media: [{
      ...current,
      ...(contentType !== undefined ? {contentType} : {}),
      status,
      ...(reason !== undefined ? {reason} : {}),
    }],
  };
}

export async function downloadDiscordSupportedEmbeds(
  embeds: unknown,
  options: DownloadDiscordSupportedAttachmentsOptions,
): Promise<DiscordEmbedDownloadResult> {
  const media: MediaDescriptor[] = [];
  const summaries: DiscordEmbedSummary[] = [];
  for (const entry of collectDiscordEmbedEntries(embeds)) {
    const candidate = entry.candidate;
    if (!candidate?.url || !normalizeAttachmentUrl(candidate.url)) {
      summaries.push(entry.summary);
      continue;
    }
    try {
      const result = await downloadDiscordVisualMedia({
        url: candidate.url,
        hintFilename: `discord-embed-${String(entry.index + 1)}`,
        metadata: {
          discordMediaKind: "embed",
          discordEmbedIndex: entry.index,
          discordEmbedType: entry.summary.type,
        },
      }, options);
      media.push(result.descriptor);
      summaries.push(replaceEmbedMediaStatus(entry.summary, "downloaded", result.contentType));
    } catch (error) {
      const reason = error instanceof DiscordVisualDownloadError ? error.reason : "download_failed";
      summaries.push(replaceEmbedMediaStatus(entry.summary, failedMediaStatus(reason), undefined, reason));
    }
  }
  return {media, summaries};
}

function stickerDownloadInput(summary: DiscordStickerSummary): DiscordVisualDownloadInput | undefined {
  if (summary.format === "png" || summary.format === "apng") {
    return {
      url: `https://cdn.discordapp.com/stickers/${summary.id}.png`,
      acceptedContentTypes: ["image/png"],
      hintFilename: `discord-sticker-${summary.id}.png`,
      metadata: {
        discordMediaKind: "sticker",
        discordStickerId: summary.id,
        discordStickerFormat: summary.format,
      },
    };
  }
  if (summary.format === "gif") {
    return {
      url: `https://media.discordapp.net/stickers/${summary.id}.gif`,
      acceptedContentTypes: ["image/gif"],
      hintFilename: `discord-sticker-${summary.id}.gif`,
      metadata: {
        discordMediaKind: "sticker",
        discordStickerId: summary.id,
        discordStickerFormat: summary.format,
      },
    };
  }
  return undefined;
}

export async function downloadDiscordSupportedStickers(
  stickerItems: unknown,
  options: DownloadDiscordSupportedAttachmentsOptions,
): Promise<DiscordStickerDownloadResult> {
  const media: MediaDescriptor[] = [];
  const summaries: DiscordStickerSummary[] = [];
  for (const entry of collectDiscordStickerEntries(stickerItems)) {
    const input = stickerDownloadInput(entry.summary);
    if (!input) {
      summaries.push(entry.summary);
      continue;
    }
    try {
      const result = await downloadDiscordVisualMedia(input, options);
      media.push(result.descriptor);
      summaries.push({...entry.summary, status: "downloaded", reason: undefined});
    } catch (error) {
      const reason = error instanceof DiscordVisualDownloadError ? error.reason : "download_failed";
      summaries.push({...entry.summary, status: failedMediaStatus(reason), reason});
    }
  }
  return {media, summaries};
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
