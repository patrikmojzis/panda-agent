import {createHash, randomUUID} from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import {pathExists} from "../../lib/fs.js";
import {isJsonValue, type JsonValue} from "../../lib/json.js";
import {requireNonEmptyString} from "../../lib/strings.js";
import type {MediaDescriptor} from "./types.js";

const MIME_EXTENSION_MAP = new Map<string, string>([
  ["application/json", ".json"],
  ["application/pdf", ".pdf"],
  ["application/zip", ".zip"],
  ["application/x-tgsticker", ".tgs"],
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
  ["video/webm", ".webm"],
]);

const DEFAULT_MEDIA_RECEIPT_RETENTION_MS = 31 * 24 * 60 * 60_000;
const DEFAULT_MEDIA_ORPHAN_RETENTION_MS = 60 * 60_000;
const DEFAULT_MEDIA_ORPHAN_SWEEP_INTERVAL_MS = 15 * 60_000;
const DEFAULT_MEDIA_RECEIPT_SWEEP_DELETE_LIMIT = 512;
const DEFAULT_MEDIA_RECEIPT_SWEEP_SCAN_LIMIT = 2_048;

export interface WriteMediaInput {
  bytes: Uint8Array;
  source: string;
  connectorKey: string;
  mimeType: string;
  sizeBytes?: number;
  hintFilename?: string;
  metadata?: JsonValue;
  /** Stable transport-event/part identity used to make redelivery idempotent. */
  idempotencyKey?: string;
  /** Stable source event time paired with idempotencyKey. */
  createdAt?: number;
  /** Durable runtime-request identity that owns idempotent staging bytes. */
  receiptOwner?: MediaReceiptOwner;
}

export interface MediaReceiptOwner {
  requestKind: string;
  requestIdempotencyKey: string;
}

export type MediaReceiptOwnerState = "active" | "completed" | "failed" | "missing";

export interface WriteMediaFileInput extends Omit<WriteMediaInput, "bytes"> {
  path: string;
}

export interface FileSystemMediaStoreOptions {
  rootDir: string;
  now?: () => Date;
  receiptRetentionMs?: number;
  orphanRetentionMs?: number;
  /** Hard-cut retention for pre-owner staging receipts written by older releases. */
  ownerlessRetentionMs?: number;
  orphanSweepIntervalMs?: number;
  resolveReceiptOwners?(owners: readonly MediaReceiptOwner[]): Promise<readonly MediaReceiptOwnerState[]>;
  onReceiptSweepError?(error: unknown): void;
  receiptSweepDeleteLimit?: number;
  receiptSweepScanLimit?: number;
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
  return requireNonEmptyString(value, `Media ${field} must not be empty.`);
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

function resolveIdempotentMediaIdentity(
  input: Pick<WriteMediaInput, "idempotencyKey" | "createdAt">,
  source: string,
  connectorKey: string,
): {
  id: string;
  createdAt: number;
  createdAtDate: Date;
} {
  const key = requireTrimmedValue("idempotency key", input.idempotencyKey ?? "");
  if (!Number.isSafeInteger(input.createdAt) || (input.createdAt ?? -1) < 0) {
    throw new Error("Idempotent media createdAt must be a non-negative safe integer.");
  }
  const digest = createHash("sha256")
    .update(JSON.stringify([source, connectorKey, key]))
    .digest("hex");
  const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  const createdAt = input.createdAt as number;
  const createdAtDate = new Date(createdAt);
  if (!Number.isFinite(createdAtDate.getTime())) {
    throw new Error("Idempotent media createdAt must be a valid timestamp.");
  }
  return {id, createdAt, createdAtDate};
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && ["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "");
}

async function assertExistingMediaMatches(localPath: string, expected: Uint8Array): Promise<void> {
  const existing = await fs.readFile(localPath);
  if (!existing.equals(Buffer.from(expected))) {
    throw new Error(`Idempotent media key is already bound to different bytes: ${localPath}`);
  }
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

function parseCanonicalMediaDescriptor(value: unknown): MediaDescriptor {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Idempotent media descriptor manifest must contain an object.");
  }
  const record = value as Record<string, unknown>;
  const requiredString = (field: string): string => {
    if (typeof record[field] !== "string" || !(record[field] as string).trim()) {
      throw new Error(`Idempotent media descriptor ${field} must be a non-empty string.`);
    }
    return record[field] as string;
  };
  if (!Number.isSafeInteger(record.sizeBytes) || (record.sizeBytes as number) < 0) {
    throw new Error("Idempotent media descriptor sizeBytes must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(record.createdAt) || (record.createdAt as number) < 0) {
    throw new Error("Idempotent media descriptor createdAt must be a non-negative safe integer.");
  }
  if (record.originalFilename !== undefined && typeof record.originalFilename !== "string") {
    throw new Error("Idempotent media descriptor originalFilename must be a string.");
  }
  if (record.metadata !== undefined && !isJsonValue(record.metadata)) {
    throw new Error("Idempotent media descriptor metadata must be JSON-serializable.");
  }
  return {
    id: requiredString("id"),
    source: requiredString("source"),
    connectorKey: requiredString("connectorKey"),
    mimeType: requiredString("mimeType"),
    sizeBytes: record.sizeBytes as number,
    localPath: requiredString("localPath"),
    ...(record.originalFilename === undefined ? {} : {originalFilename: record.originalFilename}),
    ...(record.metadata === undefined ? {} : {metadata: record.metadata}),
    createdAt: record.createdAt as number,
  };
}

async function installIdempotentMedia(input: {
  rootDir: string;
  identity: ReturnType<typeof resolveIdempotentMediaIdentity>;
  source: string;
  connectorKey: string;
  mimeType: string;
  sizeBytes: number;
  originalFilename?: string;
  metadata?: JsonValue;
  populate(path: string): Promise<void>;
  expectedBytes(): Promise<Uint8Array>;
  accessedAt: Date;
  receiptOwner?: MediaReceiptOwner;
}): Promise<MediaDescriptor> {
  const receiptRoot = path.join(
    input.rootDir,
    sanitizePathSegment(input.source),
    sanitizePathSegment(input.connectorKey),
    ".idempotent",
  );
  const parentDirectory = path.join(receiptRoot, input.identity.id.slice(0, 2));
  const finalDirectory = path.join(parentDirectory, input.identity.id);
  const localPath = path.join(
    finalDirectory,
    `media${inferExtension(input.mimeType, input.originalFilename)}`,
  );
  const manifestPath = path.join(finalDirectory, "descriptor.json");
  assertPathWithinRoot(input.rootDir, localPath);
  assertPathWithinRoot(input.rootDir, manifestPath);
  const descriptor: MediaDescriptor = {
    id: input.identity.id,
    source: input.source,
    connectorKey: input.connectorKey,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    localPath,
    originalFilename: input.originalFilename,
    metadata: input.metadata,
    createdAt: input.identity.createdAt,
  };

  await fs.mkdir(parentDirectory, {recursive: true});
  const temporaryDirectory = path.join(parentDirectory, `${input.identity.id}.${randomUUID()}.tmp`);
  await fs.mkdir(temporaryDirectory);
  try {
    const temporaryMediaPath = path.join(temporaryDirectory, path.basename(localPath));
    await input.populate(temporaryMediaPath);
    await fs.writeFile(
      path.join(temporaryDirectory, "descriptor.json"),
      JSON.stringify({...descriptor, ...(input.receiptOwner ? {receiptOwner: input.receiptOwner} : {})}),
      {flag: "wx"},
    );
    try {
      // A directory rename publishes bytes plus their canonical descriptor as
      // one unit; concurrent redeliveries can only observe the winning pair.
      await fs.rename(temporaryDirectory, finalDirectory);
      await fs.utimes(manifestPath, input.accessedAt, input.accessedAt);
      return descriptor;
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
    }
  } finally {
    await fs.rm(temporaryDirectory, {recursive: true, force: true});
  }

  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const canonical = parseCanonicalMediaDescriptor(manifest);
  if (
    canonical.id !== input.identity.id
    || canonical.source !== input.source
    || canonical.connectorKey !== input.connectorKey
    || !path.isAbsolute(canonical.localPath)
  ) {
    throw new Error(`Idempotent media descriptor is bound to a different identity: ${manifestPath}`);
  }
  const canonicalOwner = parseMediaReceiptOwner(manifest);
  if (input.receiptOwner && canonicalOwner && (
    canonicalOwner.requestKind !== input.receiptOwner.requestKind
    || canonicalOwner.requestIdempotencyKey !== input.receiptOwner.requestIdempotencyKey
  )) {
    throw new Error(`Idempotent media descriptor is bound to a different request owner: ${manifestPath}`);
  }
  await assertExistingMediaMatches(canonical.localPath, await input.expectedBytes());
  await fs.utimes(manifestPath, input.accessedAt, input.accessedAt);
  if (path.dirname(canonical.localPath) !== finalDirectory) {
    // Relocation turns this directory into a descriptor-only receipt. Clean a
    // byte left behind by a crash after the atomic manifest switch.
    const entries = await fs.readdir(finalDirectory);
    await Promise.all(entries
      .filter((entry) => entry !== "descriptor.json")
      .map((entry) => fs.rm(path.join(finalDirectory, entry), {recursive: true, force: true})));
  }
  // Request payloads keep the immutable staging path. Relocation may rewrite
  // the private manifest to an agent-owned path, but transport redelivery must
  // still produce byte-for-byte identical JSON for request idempotency.
  const stableLocalPath = path.join(
    finalDirectory,
    `media${inferExtension(canonical.mimeType, canonical.originalFilename)}`,
  );
  return {...canonical, localPath: stableLocalPath};
}

function parseMediaReceiptOwner(value: unknown): MediaReceiptOwner | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const owner = (value as {receiptOwner?: unknown}).receiptOwner;
  if (typeof owner !== "object" || owner === null || Array.isArray(owner)) return null;
  const record = owner as Record<string, unknown>;
  if (
    typeof record.requestKind !== "string"
    || !record.requestKind.trim()
    || typeof record.requestIdempotencyKey !== "string"
    || !record.requestIdempotencyKey.trim()
  ) return null;
  return {
    requestKind: record.requestKind,
    requestIdempotencyKey: record.requestIdempotencyKey,
  };
}

function assertPathWithinRoot(rootDir: string, candidatePath: string): void {
  const relative = path.relative(rootDir, candidatePath);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return;
  }

  throw new Error(`Media path escaped storage root: ${candidatePath}`);
}

function resolveStoredFilename(descriptor: MediaDescriptor): string {
  if (isCanonicalIdempotentMediaPath(descriptor.localPath)) {
    return `${descriptor.id}${inferExtension(descriptor.mimeType, descriptor.originalFilename)}`;
  }
  const localPath = descriptor.localPath.trim();
  const basename = localPath ? path.basename(localPath) : "";
  if (basename && basename !== "." && basename !== "..") {
    return basename;
  }

  return `${descriptor.id}${inferExtension(descriptor.mimeType, descriptor.originalFilename)}`;
}

function isCanonicalIdempotentMediaPath(localPath: string): boolean {
  return path.basename(path.dirname(path.dirname(path.dirname(localPath)))) === ".idempotent";
}

function sameStagedMediaIdentity(left: MediaDescriptor, right: MediaDescriptor): boolean {
  return sameMediaIdentity(left, right)
    && path.resolve(left.localPath) === path.resolve(right.localPath);
}

function sameMediaIdentity(left: MediaDescriptor, right: MediaDescriptor): boolean {
  return left.id === right.id
    && left.source === right.source
    && left.connectorKey === right.connectorKey
    && left.createdAt === right.createdAt;
}

/**
 * Releases a transport-staged byte after its durable runtime request becomes
 * terminal. Relocated media is represented by a manifest pointing outside the
 * receipt directory and is deliberately retained as a replay receipt.
 */
export async function discardStagedMediaDescriptor(descriptor: MediaDescriptor): Promise<boolean> {
  const localPath = path.resolve(requireTrimmedValue("local path", descriptor.localPath));
  if (!isCanonicalIdempotentMediaPath(localPath)) return false;

  const receiptDirectory = path.dirname(localPath);
  const manifestPath = path.join(receiptDirectory, "descriptor.json");
  let canonical: MediaDescriptor;
  try {
    canonical = parseCanonicalMediaDescriptor(JSON.parse(await fs.readFile(manifestPath, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
  if (!sameStagedMediaIdentity(canonical, {...descriptor, localPath})) return false;
  if (path.dirname(path.resolve(canonical.localPath)) !== receiptDirectory) return false;

  // Rename first so a concurrent transport redelivery can publish a fresh
  // receipt instead of writing into a directory being removed.
  const discardedDirectory = `${receiptDirectory}.${randomUUID()}.discarding`;
  try {
    await fs.rename(receiptDirectory, discardedDirectory);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
  await fs.rm(discardedDirectory, {recursive: true, force: true});
  return true;
}

export async function discardStagedMediaDescriptors(
  descriptors: readonly MediaDescriptor[],
): Promise<number> {
  const discarded = await Promise.all(descriptors.map(discardStagedMediaDescriptor));
  return discarded.filter(Boolean).length;
}

function requireNonNegativeInteger(field: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Media ${field} must be a non-negative safe integer.`);
  }
  return value;
}

type ReceiptJanitorCandidate =
  | {kind: "staging"; descriptor: MediaDescriptor; owner: MediaReceiptOwner | null; receiptExpired: boolean}
  | {kind: "relocated"; descriptor: MediaDescriptor; owner: MediaReceiptOwner; receiptDirectory: string; receiptExpired: boolean}
  | {kind: "retained"; receiptDirectory: string};

function rotateEntries<T>(entries: readonly T[], seed: number): readonly T[] {
  if (entries.length < 2) return entries;
  const offset = Math.abs(seed) % entries.length;
  return [...entries.slice(offset), ...entries.slice(0, offset)];
}

async function readDirectories(directory: string): Promise<readonly import("node:fs").Dirent[]> {
  try {
    return (await fs.readdir(directory, {withFileTypes: true})).filter((entry) => entry.isDirectory());
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function collectReceiptJanitorCandidates(input: {
  rootDir: string;
  orphanCutoffMs: number;
  ownerlessCutoffMs: number;
  receiptCutoffMs: number;
  scanLimit: number;
}): Promise<readonly ReceiptJanitorCandidate[]> {
  const candidates: ReceiptJanitorCandidate[] = [];
  let scanned = 0;
  const seed = Math.floor(Date.now() / Math.max(1, DEFAULT_MEDIA_ORPHAN_SWEEP_INTERVAL_MS));
  const scanReceiptRoot = async (receiptRoot: string, depth: number): Promise<void> => {
    const shards = rotateEntries(await readDirectories(receiptRoot), seed + depth);
    for (const shard of shards) {
      if (scanned >= input.scanLimit) return;
      scanned += 1;
      const shardDirectory = path.join(receiptRoot, shard.name);
      const receipts = rotateEntries(await readDirectories(shardDirectory), seed + depth + 1);
      for (const receipt of receipts) {
        if (scanned >= input.scanLimit) return;
        scanned += 1;
        const receiptDirectory = path.join(shardDirectory, receipt.name);
        const manifestPath = path.join(receiptDirectory, "descriptor.json");
        const stat = await fs.stat(manifestPath).catch(() => null);
        if (!stat) {
          const directoryStat = await fs.stat(receiptDirectory).catch(() => null);
          if (directoryStat && directoryStat.mtimeMs <= input.receiptCutoffMs) {
            candidates.push({kind: "retained", receiptDirectory});
          }
          continue;
        }
        try {
          const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
          const descriptor = parseCanonicalMediaDescriptor(manifest);
          const owner = parseMediaReceiptOwner(manifest);
          if (path.dirname(path.resolve(descriptor.localPath)) === receiptDirectory) {
            if (stat.mtimeMs <= (owner ? input.orphanCutoffMs : input.ownerlessCutoffMs)) {
              candidates.push({
                kind: "staging",
                descriptor,
                owner,
                receiptExpired: stat.mtimeMs <= input.receiptCutoffMs,
              });
            }
          } else if (owner && stat.mtimeMs <= input.orphanCutoffMs) {
            candidates.push({
              kind: "relocated",
              descriptor,
              owner,
              receiptDirectory,
              receiptExpired: stat.mtimeMs <= input.receiptCutoffMs,
            });
          } else if (stat.mtimeMs <= input.receiptCutoffMs) {
            candidates.push({kind: "retained", receiptDirectory});
          }
        } catch {
          if (stat.mtimeMs <= input.receiptCutoffMs) {
            candidates.push({kind: "retained", receiptDirectory});
          }
        }
      }
    }
  };
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 8 || scanned >= input.scanLimit) return;
    const entries = rotateEntries(await readDirectories(directory), seed + depth);
    for (const entry of entries) {
      if (scanned >= input.scanLimit) return;
      scanned += 1;
      const child = path.join(directory, entry.name);
      if (entry.name === ".idempotent") {
        await scanReceiptRoot(child, depth);
      } else {
        await walk(child, depth + 1);
      }
    }
  };
  await walk(input.rootDir, 0);
  return candidates;
}

async function discardRetainedReceipt(receiptDirectory: string, cutoffMs: number): Promise<boolean> {
  const manifestPath = path.join(receiptDirectory, "descriptor.json");
  const stat = await fs.stat(manifestPath).catch(() => null);
  if (stat?.mtimeMs !== undefined && stat.mtimeMs > cutoffMs) return false;
  if (!stat) {
    const directoryStat = await fs.stat(receiptDirectory).catch(() => null);
    if (!directoryStat || directoryStat.mtimeMs > cutoffMs) return false;
  } else {
    try {
      const descriptor = parseCanonicalMediaDescriptor(JSON.parse(await fs.readFile(manifestPath, "utf8")));
      if (path.dirname(path.resolve(descriptor.localPath)) === receiptDirectory) return false;
    } catch {
      // A corrupt receipt cannot be replayed. The long retention window is its
      // hard-cut recovery boundary, so it may be removed after the age recheck.
    }
  }
  await fs.rm(receiptDirectory, {recursive: true, force: true});
  return true;
}

async function discardExpiredStagedMediaDescriptor(
  descriptor: MediaDescriptor,
  cutoffMs: number,
  expectedOwner: MediaReceiptOwner | null,
): Promise<boolean> {
  const localPath = path.resolve(requireTrimmedValue("local path", descriptor.localPath));
  if (!isCanonicalIdempotentMediaPath(localPath)) return false;
  const receiptDirectory = path.dirname(localPath);
  const manifestPath = path.join(receiptDirectory, "descriptor.json");
  try {
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    const canonical = parseCanonicalMediaDescriptor(manifest);
    const owner = parseMediaReceiptOwner(manifest);
    const stat = await fs.stat(manifestPath);
    if (
      stat.mtimeMs > cutoffMs
      || !sameStagedMediaIdentity(canonical, {...descriptor, localPath})
      || path.dirname(path.resolve(canonical.localPath)) !== receiptDirectory
      || (owner?.requestKind ?? null) !== (expectedOwner?.requestKind ?? null)
      || (owner?.requestIdempotencyKey ?? null) !== (expectedOwner?.requestIdempotencyKey ?? null)
    ) {
      return false;
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
  return discardStagedMediaDescriptor(descriptor);
}

async function publishCanonicalRelocation(
  descriptor: MediaDescriptor,
  sourcePath: string,
  targetPath: string,
): Promise<MediaDescriptor> {
  const receiptDirectory = path.dirname(sourcePath);
  const manifestPath = path.join(receiptDirectory, "descriptor.json");
  const relocated = {...descriptor, localPath: targetPath};
  const temporaryManifest = path.join(receiptDirectory, `descriptor.${randomUUID()}.tmp`);
  try {
    // The source byte remains readable until the descriptor atomically points
    // at the agent-owned target. A crash can leave a temporary duplicate, but
    // the next replay removes it from this descriptor-only receipt directory.
    await fs.writeFile(temporaryManifest, JSON.stringify(relocated), {flag: "wx"});
    await fs.rename(temporaryManifest, manifestPath);
  } finally {
    await fs.rm(temporaryManifest, {force: true});
  }
  await fs.unlink(sourcePath);
  return relocated;
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
    if (!isCanonicalIdempotentMediaPath(localPath)) {
      throw new Error(`Media relocation target already exists: ${targetPath}`);
    }
    await assertExistingMediaMatches(targetPath, await fs.readFile(localPath));
    return publishCanonicalRelocation(descriptor, localPath, targetPath);
  }

  await fs.mkdir(targetDirectory, { recursive: true });
  if (isCanonicalIdempotentMediaPath(localPath)) {
    // The staging manifest becomes a descriptor-only replay receipt. The
    // durable byte has one owner: the agent media root.
    await fs.copyFile(localPath, targetPath, fs.constants.COPYFILE_EXCL);
    return publishCanonicalRelocation(descriptor, localPath, targetPath);
  } else {
    await moveMediaFile(localPath, targetPath);
  }

  return {
    ...descriptor,
    localPath: targetPath,
  };
}

export class FileSystemMediaStore {
  private readonly rootDir: string;
  private readonly now: () => Date;
  private readonly receiptRetentionMs: number;
  private readonly orphanRetentionMs: number;
  private readonly ownerlessRetentionMs: number;
  private readonly orphanSweepIntervalMs: number;
  private readonly resolveReceiptOwners?: FileSystemMediaStoreOptions["resolveReceiptOwners"];
  private readonly onReceiptSweepError?: FileSystemMediaStoreOptions["onReceiptSweepError"];
  private readonly receiptSweepDeleteLimit: number;
  private readonly receiptSweepScanLimit: number;
  private receiptJanitorTimer: NodeJS.Timeout | null = null;
  private receiptJanitorRun: Promise<void> | null = null;

  constructor(options: FileSystemMediaStoreOptions) {
    this.rootDir = path.resolve(requireTrimmedValue("root directory", options.rootDir));
    this.now = options.now ?? (() => new Date());
    this.receiptRetentionMs = requireNonNegativeInteger(
      "receipt retention",
      options.receiptRetentionMs ?? DEFAULT_MEDIA_RECEIPT_RETENTION_MS,
    );
    this.orphanRetentionMs = requireNonNegativeInteger(
      "orphan retention",
      options.orphanRetentionMs ?? DEFAULT_MEDIA_ORPHAN_RETENTION_MS,
    );
    this.ownerlessRetentionMs = requireNonNegativeInteger(
      "ownerless retention",
      options.ownerlessRetentionMs ?? DEFAULT_MEDIA_RECEIPT_RETENTION_MS,
    );
    this.orphanSweepIntervalMs = requireNonNegativeInteger(
      "orphan sweep interval",
      options.orphanSweepIntervalMs ?? DEFAULT_MEDIA_ORPHAN_SWEEP_INTERVAL_MS,
    );
    this.resolveReceiptOwners = options.resolveReceiptOwners;
    this.onReceiptSweepError = options.onReceiptSweepError;
    this.receiptSweepDeleteLimit = requireNonNegativeInteger(
      "receipt sweep delete limit",
      options.receiptSweepDeleteLimit ?? DEFAULT_MEDIA_RECEIPT_SWEEP_DELETE_LIMIT,
    );
    this.receiptSweepScanLimit = requireNonNegativeInteger(
      "receipt sweep scan limit",
      options.receiptSweepScanLimit ?? DEFAULT_MEDIA_RECEIPT_SWEEP_SCAN_LIMIT,
    );
  }

  startReceiptJanitor(): void {
    if (!this.resolveReceiptOwners || this.receiptJanitorTimer || this.orphanSweepIntervalMs === 0) return;
    const run = () => {
      if (this.receiptJanitorRun) return;
      this.receiptJanitorRun = this.reconcileOrphanedReceipts()
        .then(() => undefined)
        .catch((error) => { this.onReceiptSweepError?.(error); })
        .finally(() => { this.receiptJanitorRun = null; });
    };
    run();
    this.receiptJanitorTimer = setInterval(run, this.orphanSweepIntervalMs);
    this.receiptJanitorTimer.unref?.();
  }

  async stopReceiptJanitor(): Promise<void> {
    if (this.receiptJanitorTimer) clearInterval(this.receiptJanitorTimer);
    this.receiptJanitorTimer = null;
    await this.receiptJanitorRun;
  }

  async reconcileOrphanedReceipts(): Promise<number> {
    if (!this.resolveReceiptOwners || this.receiptSweepScanLimit === 0 || this.receiptSweepDeleteLimit === 0) {
      return 0;
    }
    const nowMs = this.now().getTime();
    const receiptCutoffMs = nowMs - this.receiptRetentionMs;
    const candidates = await collectReceiptJanitorCandidates({
      rootDir: this.rootDir,
      orphanCutoffMs: nowMs - this.orphanRetentionMs,
      ownerlessCutoffMs: nowMs - this.ownerlessRetentionMs,
      receiptCutoffMs,
      scanLimit: this.receiptSweepScanLimit,
    });
    if (candidates.length === 0) return 0;
    const owned = candidates.flatMap((candidate, index) => {
      if (candidate.kind === "staging" && candidate.owner) return [{index, owner: candidate.owner}];
      if (candidate.kind === "relocated") return [{index, owner: candidate.owner}];
      return [];
    });
    const states = await this.resolveReceiptOwners(owned.map((candidate) => candidate.owner));
    if (states.length !== owned.length) {
      throw new Error("Media receipt owner resolver returned an invalid result count.");
    }
    const stateByCandidate = new Map(owned.map((candidate, index) => [candidate.index, states[index]]));
    let deleted = 0;
    for (const [index, candidate] of candidates.entries()) {
      if (deleted >= this.receiptSweepDeleteLimit) break;
      if (candidate.kind === "retained") {
        if (await discardRetainedReceipt(candidate.receiptDirectory, receiptCutoffMs)) deleted += 1;
        continue;
      }
      const state = stateByCandidate.get(index);
      if (candidate.kind === "relocated") {
        // Agent-owned targets can already be referenced by a prior transcript
        // after redelivery. Without durable reference ownership, only the
        // replay receipt is reclaimable; the target itself is immutable.
        if ((state === "completed" || state === "failed" || state === "missing") && candidate.receiptExpired) {
          if (await discardRetainedReceipt(candidate.receiptDirectory, receiptCutoffMs)) deleted += 1;
        }
        continue;
      }
      if (candidate.owner && (state === "completed" || state === "failed")) {
        if (await discardStagedMediaDescriptor(candidate.descriptor)) deleted += 1;
        continue;
      }
      // A missing owner can be the small stage-before-enqueue window. Require
      // the conservative receipt cutoff and recheck manifest age/ownership
      // after the database lookup so redelivery cannot lose freshly touched
      // bytes. The same rule protects pre-owner receipts from older releases.
      if ((!candidate.owner || state === "missing") && candidate.receiptExpired) {
        if (await discardExpiredStagedMediaDescriptor(
          candidate.descriptor,
          receiptCutoffMs,
          candidate.owner,
        )) deleted += 1;
      }
    }
    return deleted;
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

    const identity = input.idempotencyKey === undefined
      ? (() => {
          const createdAtDate = this.now();
          return {id: randomUUID(), createdAt: createdAtDate.getTime(), createdAtDate};
        })()
      : resolveIdempotentMediaIdentity(input, source, connectorKey);
    if (input.idempotencyKey !== undefined) {
      const accessedAt = this.now();
      const descriptor = await installIdempotentMedia({
        rootDir: this.rootDir,
        identity,
        source,
        connectorKey,
        mimeType,
        sizeBytes,
        originalFilename,
        metadata: input.metadata,
        populate: (temporaryPath) => fs.writeFile(temporaryPath, input.bytes, {flag: "wx"}),
        expectedBytes: async () => input.bytes,
        accessedAt,
        receiptOwner: input.receiptOwner,
      });
      return descriptor;
    }
    const extension = inferExtension(mimeType, originalFilename);
    const relativeDirectory = buildRelativeMediaDirectory(source, connectorKey, identity.createdAtDate);
    const absoluteDirectory = path.join(this.rootDir, relativeDirectory);
    const localPath = path.join(absoluteDirectory, `${identity.id}${extension}`);
    assertPathWithinRoot(this.rootDir, localPath);

    await fs.mkdir(absoluteDirectory, { recursive: true });
    await fs.writeFile(localPath, input.bytes);

    return {
      id: identity.id,
      source,
      connectorKey,
      mimeType,
      sizeBytes,
      localPath,
      originalFilename,
      metadata: input.metadata,
      createdAt: identity.createdAt,
    };
  }

  async writeMediaFile(input: WriteMediaFileInput): Promise<MediaDescriptor> {
    const source = requireTrimmedValue("source", input.source);
    const connectorKey = requireTrimmedValue("connector key", input.connectorKey);
    const mimeType = requireTrimmedValue("mime type", input.mimeType).toLowerCase();
    const originalFilename = sanitizeOriginalFilename(input.hintFilename);
    const sourcePath = path.resolve(requireTrimmedValue("source path", input.path));
    const sourceStat = await fs.stat(sourcePath);
    if (!sourceStat.isFile()) {
      throw new Error("Media source path must be a file.");
    }
    if (input.sizeBytes !== undefined && input.sizeBytes !== sourceStat.size) {
      throw new Error(`Media sizeBytes ${input.sizeBytes} does not match source file size ${sourceStat.size}.`);
    }

    const identity = input.idempotencyKey === undefined
      ? (() => {
          const createdAtDate = this.now();
          return {id: randomUUID(), createdAt: createdAtDate.getTime(), createdAtDate};
        })()
      : resolveIdempotentMediaIdentity(input, source, connectorKey);
    if (input.idempotencyKey !== undefined) {
      const accessedAt = this.now();
      const descriptor = await installIdempotentMedia({
        rootDir: this.rootDir,
        identity,
        source,
        connectorKey,
        mimeType,
        sizeBytes: sourceStat.size,
        originalFilename,
        metadata: input.metadata,
        populate: (temporaryPath) => fs.copyFile(sourcePath, temporaryPath, fs.constants.COPYFILE_EXCL),
        expectedBytes: () => fs.readFile(sourcePath),
        accessedAt,
        receiptOwner: input.receiptOwner,
      });
      return descriptor;
    }
    const relativeDirectory = buildRelativeMediaDirectory(source, connectorKey, identity.createdAtDate);
    const absoluteDirectory = path.join(this.rootDir, relativeDirectory);
    const localPath = path.join(absoluteDirectory, `${identity.id}${inferExtension(mimeType, originalFilename)}`);
    assertPathWithinRoot(this.rootDir, localPath);
    await fs.mkdir(absoluteDirectory, {recursive: true});
    await fs.copyFile(sourcePath, localPath, fs.constants.COPYFILE_EXCL);

    return {
      id: identity.id,
      source,
      connectorKey,
      mimeType,
      sizeBytes: sourceStat.size,
      localPath,
      originalFilename,
      metadata: input.metadata,
      createdAt: identity.createdAt,
    };
  }
}
