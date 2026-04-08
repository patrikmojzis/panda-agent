import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { JsonValue } from "../../agent-core/types.js";
import type { MediaDescriptor } from "./types.js";

const MIME_EXTENSION_MAP = new Map<string, string>([
  ["application/json", ".json"],
  ["application/pdf", ".pdf"],
  ["application/zip", ".zip"],
  ["audio/m4a", ".m4a"],
  ["audio/mp4", ".m4a"],
  ["audio/mpeg", ".mp3"],
  ["audio/ogg", ".ogg"],
  ["audio/opus", ".opus"],
  ["image/gif", ".gif"],
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
  ["text/plain", ".txt"],
  ["video/mp4", ".mp4"],
]);

export interface WriteMediaInput {
  bytes: Uint8Array;
  source: string;
  connectorKey: string;
  mimeType: string;
  sizeBytes?: number;
  hintFilename?: string;
  metadata?: JsonValue;
}

export interface FileSystemMediaStoreOptions {
  rootDir: string;
  now?: () => Date;
}

function requireTrimmedValue(field: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Media ${field} must not be empty.`);
  }

  return trimmed;
}

function sanitizePathSegment(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    || "unknown";

  return sanitized === "." || sanitized === ".." ? "unknown" : sanitized;
}

function sanitizeOriginalFilename(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = path.basename(value.trim());
  return trimmed || undefined;
}

function monthPartition(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function inferExtension(mimeType: string, hintFilename?: string): string {
  const normalizedMimeType = mimeType.toLowerCase();
  const known = MIME_EXTENSION_MAP.get(normalizedMimeType);
  if (known) {
    return known;
  }

  if (hintFilename) {
    const ext = path.extname(hintFilename).toLowerCase();
    if (ext && /^[.][a-z0-9]{1,10}$/.test(ext)) {
      return ext;
    }
  }

  return ".bin";
}

function assertPathWithinRoot(rootDir: string, candidatePath: string): void {
  const relative = path.relative(rootDir, candidatePath);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return;
  }

  throw new Error(`Media path escaped storage root: ${candidatePath}`);
}

export class FileSystemMediaStore {
  private readonly rootDir: string;
  private readonly now: () => Date;

  constructor(options: FileSystemMediaStoreOptions) {
    this.rootDir = path.resolve(requireTrimmedValue("root directory", options.rootDir));
    this.now = options.now ?? (() => new Date());
  }

  async writeMedia(input: WriteMediaInput): Promise<MediaDescriptor> {
    const source = requireTrimmedValue("source", input.source);
    const connectorKey = requireTrimmedValue("connector key", input.connectorKey);
    const mimeType = requireTrimmedValue("mime type", input.mimeType).toLowerCase();
    const originalFilename = sanitizeOriginalFilename(input.hintFilename);
    const actualSizeBytes = input.bytes.byteLength;
    if (input.sizeBytes !== undefined && input.sizeBytes !== actualSizeBytes) {
      throw new Error(`Media sizeBytes ${input.sizeBytes} does not match payload byte length ${actualSizeBytes}.`);
    }

    const sizeBytes = actualSizeBytes;
    if (sizeBytes < 0) {
      throw new Error("Media sizeBytes must not be negative.");
    }

    const createdAtDate = this.now();
    const createdAt = createdAtDate.getTime();
    const extension = inferExtension(mimeType, originalFilename);
    const id = randomUUID();
    const relativeDirectory = path.join(
      sanitizePathSegment(source),
      sanitizePathSegment(connectorKey),
      monthPartition(createdAtDate),
    );
    const absoluteDirectory = path.join(this.rootDir, relativeDirectory);
    const localPath = path.join(absoluteDirectory, `${id}${extension}`);
    assertPathWithinRoot(this.rootDir, localPath);

    await mkdir(absoluteDirectory, { recursive: true });
    await writeFile(localPath, input.bytes);

    return {
      id,
      source,
      connectorKey,
      mimeType,
      sizeBytes,
      localPath,
      originalFilename,
      metadata: input.metadata,
      createdAt,
    };
  }
}
