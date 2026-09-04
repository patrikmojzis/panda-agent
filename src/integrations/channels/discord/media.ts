import type {MediaReceiptOwner, WriteMediaInput} from "../../../domain/channels/media-store.js";
import type {MediaDescriptor} from "../../../domain/channels/types.js";
import type {
  DiscordAttachmentSummary,
  DiscordEmbedMediaSummary,
  DiscordEmbedSummary,
  DiscordMediaReason,
  DiscordMediaStatus,
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

export type DiscordAttachmentCandidateKind = "proxy" | "cdn";

export interface DiscordAttachmentDownloadCandidate {
  kind: DiscordAttachmentCandidateKind;
  url: string;
}

export interface DiscordAttachmentDownloadPart {
  id: string;
  candidates: readonly DiscordAttachmentDownloadCandidate[];
  mimeType: string;
  sizeBytes?: number;
  hintFilename?: string;
}

export interface DiscordAttachmentDownloadAttempt {
  candidate: DiscordAttachmentCandidateKind;
  reason: DiscordMediaReason;
  httpStatus?: number;
}

export interface DiscordUnavailableAttachment {
  id: string;
  contentType?: string;
  filename?: string;
  sizeBytes?: number;
  status: DiscordMediaStatus;
  reason: DiscordMediaReason;
  httpStatus?: number;
  attempts: readonly DiscordAttachmentDownloadAttempt[];
}

export interface DiscordAttachmentDownloadResult {
  media: readonly MediaDescriptor[];
  summaries: readonly DiscordAttachmentSummary[];
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
  /** Stable message identity. Required together with createdAt for replay-safe ingress media. */
  idempotencyKeyPrefix?: string;
  createdAt?: number;
  receiptOwner?: MediaReceiptOwner;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  onUnavailable?: (item: DiscordUnavailableAttachment) => void;
}

function buildDiscordMediaIdentity(
  options: DownloadDiscordSupportedAttachmentsOptions,
  partKey: string,
): Pick<WriteMediaInput, "idempotencyKey" | "createdAt" | "receiptOwner"> | Record<string, never> {
  if (options.idempotencyKeyPrefix === undefined && options.createdAt === undefined) {
    return {};
  }
  if (!options.idempotencyKeyPrefix?.trim()
    || !Number.isSafeInteger(options.createdAt)
    || (options.createdAt ?? -1) < 0) {
    throw new Error("Discord media idempotencyKeyPrefix and createdAt must be provided together.");
  }
  return {
    idempotencyKey: `${options.idempotencyKeyPrefix}:${partKey}`,
    createdAt: options.createdAt as number,
    ...(options.receiptOwner ? {receiptOwner: options.receiptOwner} : {}),
  };
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

function readAttachmentDownloadCandidates(
  attachment: Record<string, unknown>,
): readonly DiscordAttachmentDownloadCandidate[] {
  const raw: readonly DiscordAttachmentDownloadCandidate[] = [
    {kind: "proxy", url: firstNonEmptyString(attachment.proxy_url, attachment.proxyUrl) ?? ""},
    {kind: "cdn", url: firstNonEmptyString(attachment.url) ?? ""},
  ];
  const seen = new Set<string>();
  return raw.filter((candidate) => {
    if (!candidate.url || seen.has(candidate.url)) {
      return false;
    }
    seen.add(candidate.url);
    return true;
  });
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

function mediaStatusForReason(reason: DiscordMediaReason): Exclude<DiscordMediaStatus, "downloaded"> {
  if (reason === "no_trusted_media" || reason === "untrusted_url") {
    return "metadata_only";
  }
  if (reason === "unsupported_format" || reason === "invalid_content_type" || reason === "invalid_signature") {
    return "unsupported";
  }
  return "failed";
}

function buildUnavailableAttachment(
  part: Pick<DiscordAttachmentDownloadPart, "id" | "mimeType" | "sizeBytes" | "hintFilename">,
  reason: DiscordMediaReason,
  attempts: readonly DiscordAttachmentDownloadAttempt[] = [],
  httpStatus?: number,
): DiscordUnavailableAttachment {
  return {
    id: part.id,
    contentType: part.mimeType,
    filename: part.hintFilename,
    sizeBytes: part.sizeBytes,
    status: mediaStatusForReason(reason),
    reason,
    ...(httpStatus !== undefined ? {httpStatus} : {}),
    attempts,
  };
}

function markUnavailable(
  part: Pick<DiscordAttachmentDownloadPart, "id" | "mimeType" | "sizeBytes" | "hintFilename">,
  reason: DiscordMediaReason,
  options: DownloadDiscordSupportedAttachmentsOptions,
  attempts: readonly DiscordAttachmentDownloadAttempt[] = [],
  httpStatus?: number,
): {unavailable: DiscordUnavailableAttachment} {
  const unavailable = buildUnavailableAttachment(part, reason, attempts, httpStatus);
  options.onUnavailable?.(unavailable);
  return {unavailable};
}

class DiscordResponseTooLargeError extends Error {}

async function readCappedResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new DiscordResponseTooLargeError("Discord attachment response exceeded download limit.");
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
        throw new DiscordResponseTooLargeError("Discord attachment response exceeded download limit.");
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
  storagePartKey: string;
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
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DISCORD_ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
  );
  timeout.unref?.();

  try {
    let response: Response;
    try {
      response = await (options.fetchImpl ?? fetch)(normalizedUrl.toString(), {
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      throw new DiscordVisualDownloadError(controller.signal.aborted ? "timeout" : "download_failed");
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
    } catch (error) {
      throw new DiscordVisualDownloadError(
        controller.signal.aborted
          ? "timeout"
          : error instanceof DiscordResponseTooLargeError ? "too_large" : "download_failed",
      );
    }
    const descriptor = await options.mediaStore.writeMedia({
      bytes,
      source: DISCORD_SOURCE,
      connectorKey: options.connectorKey,
      mimeType: contentType,
      sizeBytes: bytes.byteLength,
      hintFilename: input.hintFilename,
      metadata: input.metadata,
      ...buildDiscordMediaIdentity(options, input.storagePartKey),
    });
    return {descriptor, contentType};
  } finally {
    clearTimeout(timeout);
  }
}

function failedMediaStatus(reason: DiscordMediaReason): "metadata_only" | "unsupported" | "failed" {
  return mediaStatusForReason(reason);
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
        storagePartKey: `embed:${entry.index}`,
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
      storagePartKey: `sticker:${summary.id}`,
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
      storagePartKey: `sticker:${summary.id}`,
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
    const candidates = readAttachmentDownloadCandidates(attachment);
    if (candidates.length === 0) {
      items.push({
        kind: "unavailable",
        unavailable: {
          id,
          ...(contentType !== undefined ? {contentType} : {}),
          ...(filename !== undefined ? {filename} : {}),
          ...(sizeBytes !== undefined ? {sizeBytes} : {}),
          status: "metadata_only",
          reason: "no_trusted_media",
          attempts: [],
        },
      });
      continue;
    }

    items.push({
      kind: "download",
      part: {
        id,
        candidates,
        mimeType: contentType ?? "application/octet-stream",
        ...(sizeBytes !== undefined ? {sizeBytes} : {}),
        ...(filename !== undefined ? {hintFilename: filename} : {}),
      },
    });
  }

  return items;
}

const JPEG_MIME_TYPE = "image/jpeg";
const SUPPORTED_ATTACHMENT_IMAGE_TYPES = new Set([
  JPEG_MIME_TYPE,
  "image/png",
  "image/gif",
  "image/webp",
]);

function normalizeImageMimeType(value: string | undefined): string | undefined {
  const normalized = baseContentType(value);
  if (normalized === "image/jpg" || normalized === "image/pjpeg") {
    return JPEG_MIME_TYPE;
  }
  return normalized;
}

function bytesStartWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function detectSupportedImageMimeType(bytes: Uint8Array): string | undefined {
  if (bytesStartWith(bytes, [0xff, 0xd8, 0xff])) {
    return JPEG_MIME_TYPE;
  }
  if (bytesStartWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (bytesStartWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61])
    || bytesStartWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) {
    return "image/gif";
  }
  if (bytesStartWith(bytes, [0x52, 0x49, 0x46, 0x46])
    && bytesStartWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])) {
    return "image/webp";
  }
  return undefined;
}

class DiscordAttachmentDownloadError extends Error {
  readonly reason: DiscordMediaReason;
  readonly httpStatus?: number;

  constructor(reason: DiscordMediaReason, httpStatus?: number) {
    super(reason);
    this.reason = reason;
    this.httpStatus = httpStatus;
  }
}

function resolveDownloadedAttachmentMimeType(
  declaredMimeType: string,
  responseContentType: string | null,
  bytes: Uint8Array,
): string {
  const declared = normalizeImageMimeType(declaredMimeType);
  if (!declared?.startsWith("image/")) {
    return declaredMimeType;
  }

  const response = normalizeImageMimeType(responseContentType ?? undefined);
  const detected = detectSupportedImageMimeType(bytes);
  if (response === "application/octet-stream") {
    if (!detected || detected !== declared) {
      throw new DiscordAttachmentDownloadError("invalid_signature");
    }
    return detected;
  }
  if (!response || !SUPPORTED_ATTACHMENT_IMAGE_TYPES.has(response)) {
    throw new DiscordAttachmentDownloadError("invalid_content_type");
  }
  if (!detected || detected !== response) {
    throw new DiscordAttachmentDownloadError("invalid_signature");
  }
  return response;
}

async function downloadDiscordAttachmentCandidate(
  part: DiscordAttachmentDownloadPart,
  candidate: DiscordAttachmentDownloadCandidate,
  signal: AbortSignal,
  options: DownloadDiscordSupportedAttachmentsOptions,
): Promise<{bytes: Uint8Array; mimeType: string}> {
  const normalizedUrl = normalizeAttachmentUrl(candidate.url);
  if (!normalizedUrl) {
    throw new DiscordAttachmentDownloadError("untrusted_url");
  }

  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(normalizedUrl.toString(), {
      redirect: "error",
      signal,
    });
  } catch {
    throw new DiscordAttachmentDownloadError(signal.aborted ? "timeout" : "download_failed");
  }
  if (!response.ok) {
    throw new DiscordAttachmentDownloadError("http_error", response.status);
  }
  const contentLength = readContentLength(response.headers);
  if (contentLength !== undefined && contentLength > DISCORD_ATTACHMENT_DOWNLOAD_LIMIT_BYTES) {
    throw new DiscordAttachmentDownloadError("too_large");
  }

  let bytes: Uint8Array;
  try {
    bytes = await readCappedResponseBytes(response, DISCORD_ATTACHMENT_DOWNLOAD_LIMIT_BYTES);
  } catch (error) {
    throw new DiscordAttachmentDownloadError(
      signal.aborted
        ? "timeout"
        : error instanceof DiscordResponseTooLargeError ? "too_large" : "download_failed",
    );
  }
  return {
    bytes,
    mimeType: resolveDownloadedAttachmentMimeType(part.mimeType, response.headers.get("content-type"), bytes),
  };
}

function isTerminalAttachmentFailure(reason: DiscordMediaReason): boolean {
  return reason === "too_large" || reason === "timeout" || reason === "storage_failed";
}

async function downloadDiscordAttachmentOrUnavailable(
  part: DiscordAttachmentDownloadPart,
  options: DownloadDiscordSupportedAttachmentsOptions,
): Promise<{media: MediaDescriptor} | {unavailable: DiscordUnavailableAttachment}> {
  if (part.sizeBytes !== undefined && part.sizeBytes > DISCORD_ATTACHMENT_DOWNLOAD_LIMIT_BYTES) {
    return markUnavailable(part, "too_large", options);
  }

  const candidates = part.candidates.filter((candidate) => normalizeAttachmentUrl(candidate.url));
  if (candidates.length === 0) {
    return markUnavailable(part, "untrusted_url", options);
  }

  const controller = new globalThis.AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DISCORD_ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
  );
  timeout.unref?.();
  const attempts: DiscordAttachmentDownloadAttempt[] = [];
  try {
    for (const candidate of candidates) {
      try {
        const downloaded = await downloadDiscordAttachmentCandidate(part, candidate, controller.signal, options);
        let media: MediaDescriptor;
        try {
          media = await options.mediaStore.writeMedia({
            bytes: downloaded.bytes,
            source: DISCORD_SOURCE,
            connectorKey: options.connectorKey,
            mimeType: downloaded.mimeType,
            sizeBytes: downloaded.bytes.byteLength,
            hintFilename: part.hintFilename,
            metadata: {
              discordAttachmentId: part.id,
            },
            ...buildDiscordMediaIdentity(options, `attachment:${part.id}`),
          });
        } catch {
          const attempt = {candidate: candidate.kind, reason: "storage_failed" as const};
          attempts.push(attempt);
          return markUnavailable(part, attempt.reason, options, attempts);
        }
        return {media};
      } catch (error) {
        const failure = error instanceof DiscordAttachmentDownloadError
          ? error
          : new DiscordAttachmentDownloadError("download_failed");
        const attempt = {
          candidate: candidate.kind,
          reason: failure.reason,
          ...(failure.httpStatus !== undefined ? {httpStatus: failure.httpStatus} : {}),
        };
        attempts.push(attempt);
        if (isTerminalAttachmentFailure(failure.reason)) {
          return markUnavailable(part, failure.reason, options, attempts, failure.httpStatus);
        }
      }
    }
    const finalAttempt = attempts.at(-1);
    return markUnavailable(
      part,
      finalAttempt?.reason ?? "download_failed",
      options,
      attempts,
      finalAttempt?.httpStatus,
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function downloadDiscordSupportedAttachments(
  attachments: unknown,
  options: DownloadDiscordSupportedAttachmentsOptions,
): Promise<DiscordAttachmentDownloadResult> {
  const media: MediaDescriptor[] = [];
  const summaries: DiscordAttachmentSummary[] = [];
  const unavailable: DiscordUnavailableAttachment[] = [];

  for (const item of collectDiscordAttachmentDownloadItems(attachments)) {
    if (item.kind === "unavailable") {
      options.onUnavailable?.(item.unavailable);
      unavailable.push(item.unavailable);
      summaries.push({
        id: item.unavailable.id,
        ...(item.unavailable.filename !== undefined ? {filename: item.unavailable.filename} : {}),
        ...(item.unavailable.contentType !== undefined ? {contentType: item.unavailable.contentType} : {}),
        ...(item.unavailable.sizeBytes !== undefined ? {sizeBytes: item.unavailable.sizeBytes} : {}),
        status: item.unavailable.status,
        reason: item.unavailable.reason,
        ...(item.unavailable.httpStatus !== undefined ? {httpStatus: item.unavailable.httpStatus} : {}),
      });
      continue;
    }

    const result = await downloadDiscordAttachmentOrUnavailable(item.part, options);
    if ("media" in result) {
      media.push(result.media);
      summaries.push({
        id: item.part.id,
        ...(item.part.hintFilename !== undefined ? {filename: item.part.hintFilename} : {}),
        ...(item.part.mimeType !== undefined ? {contentType: item.part.mimeType} : {}),
        ...(item.part.sizeBytes !== undefined ? {sizeBytes: item.part.sizeBytes} : {}),
        status: "downloaded",
      });
      continue;
    }

    unavailable.push(result.unavailable);
    summaries.push({
      id: result.unavailable.id,
      ...(result.unavailable.filename !== undefined ? {filename: result.unavailable.filename} : {}),
      ...(result.unavailable.contentType !== undefined ? {contentType: result.unavailable.contentType} : {}),
      ...(result.unavailable.sizeBytes !== undefined ? {sizeBytes: result.unavailable.sizeBytes} : {}),
      status: result.unavailable.status,
      reason: result.unavailable.reason,
      ...(result.unavailable.httpStatus !== undefined ? {httpStatus: result.unavailable.httpStatus} : {}),
    });
  }

  return {
    media,
    summaries,
    unavailable,
  };
}
