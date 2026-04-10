import {randomUUID} from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import type {JsonValue} from "../../agent-core/types.js";
import type {MediaDescriptor} from "./types.js";

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

export interface RelocateMediaDescriptorOptions {
  rootDir: string;
}

export interface MediaMoveFileOps {
  rename(sourcePath: string, targetPath: string): Promise<void>;
  copyFile(sourcePath: string, targetPath: string): Promise<void>;
  unlink(targetPath: string): Promise<void>;
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

function buildRelativeMediaDirectory(source: string, connectorKey: string, createdAt: Date): string {
  return path.join(
    sanitizePathSegment(source),
    sanitizePathSegment(connectorKey),
    monthPartition(createdAt),
  );
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

function resolveStoredFilename(descriptor: MediaDescriptor): string {
  const localPath = descriptor.localPath.trim();
  const basename = localPath ? path.basename(localPath) : "";
  if (basename && basename !== "." && basename !== "..") {
    return basename;
  }

  return `${descriptor.id}${inferExtension(descriptor.mimeType, descriptor.originalFilename)}`;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function isCrossDeviceMoveError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "EXDEV";
}

export async function moveMediaFile(
  sourcePath: string,
  targetPath: string,
  fileOps: MediaMoveFileOps = fs,
): Promise<void> {
  try {
    await fileOps.rename(sourcePath, targetPath);
    return;
  } catch (error) {
    if (!isCrossDeviceMoveError(error)) {
      throw error;
    }
  }

  // Docker and split-volume deployments can cross filesystem boundaries, where
  // rename(2) fails with EXDEV even though a logical "move" is still safe.
  await fileOps.copyFile(sourcePath, targetPath);
  try {
    await fileOps.unlink(sourcePath);
  } catch (error) {
    await fileOps.unlink(targetPath).catch(() => {});
    throw error;
  }
}

export async function relocateMediaDescriptor(
  descriptor: MediaDescriptor,
  options: RelocateMediaDescriptorOptions,
): Promise<MediaDescriptor> {
  const rootDir = path.resolve(requireTrimmedValue("root directory", options.rootDir));
  const source = requireTrimmedValue("source", descriptor.source);
  const connectorKey = requireTrimmedValue("connector key", descriptor.connectorKey);
  const createdAt = new Date(descriptor.createdAt);
  const relativeDirectory = buildRelativeMediaDirectory(source, connectorKey, createdAt);
  const targetDirectory = path.join(rootDir, relativeDirectory);
  const targetPath = path.join(targetDirectory, resolveStoredFilename(descriptor));
  assertPathWithinRoot(rootDir, targetPath);

  const localPath = path.resolve(requireTrimmedValue("local path", descriptor.localPath));
  if (localPath === targetPath) {
    return {
      ...descriptor,
      localPath: targetPath,
    };
  }

  const [sourceExists, targetExists] = await Promise.all([
    pathExists(localPath),
    pathExists(targetPath),
  ]);

  if (!sourceExists) {
    if (!targetExists) {
      throw new Error(`Media file not found at ${localPath}`);
    }

    return {
      ...descriptor,
      localPath: targetPath,
    };
  }

  if (targetExists) {
    throw new Error(`Media relocation target already exists: ${targetPath}`);
  }

  await fs.mkdir(targetDirectory, { recursive: true });
  await moveMediaFile(localPath, targetPath);

  return {
    ...descriptor,
    localPath: targetPath,
  };
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
    const relativeDirectory = buildRelativeMediaDirectory(source, connectorKey, createdAtDate);
    const absoluteDirectory = path.join(this.rootDir, relativeDirectory);
    const localPath = path.join(absoluteDirectory, `${id}${extension}`);
    assertPathWithinRoot(this.rootDir, localPath);

    await fs.mkdir(absoluteDirectory, { recursive: true });
    await fs.writeFile(localPath, input.bytes);

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
