import {randomUUID} from "node:crypto";
import {open, mkdir, readFile, readdir, rename, rm, stat, writeFile} from "node:fs/promises";
import path from "node:path";

import type {
  CommandUploadDescriptor,
  CommandUploadScope,
  CommandUploadStore,
  ResolvedCommandUpload,
} from "../../domain/commands/uploads.js";
import {resolveAgentMediaDir} from "../../lib/data-dir.js";

export const MAX_COMMAND_UPLOAD_BYTES = 60 * 1024 * 1024;
export const DEFAULT_COMMAND_UPLOAD_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_SWEEP_ENTRIES = 1_000;
const UPLOAD_REF_PATTERN = /^upl_[a-f0-9]{32}$/;

interface StoredUploadMetadata extends CommandUploadDescriptor {
  agentKey: string;
  sessionId: string;
  createdAt: number;
}

export class CommandUploadError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = "CommandUploadError";
  }
}

export interface FileSystemCommandUploadStoreOptions {
  env?: NodeJS.ProcessEnv;
  maxBytes?: number;
  ttlMs?: number;
}

function safeSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) {
    throw new CommandUploadError(400, `${label} is invalid.`);
  }
  return value;
}

export function sanitizeCommandUploadFilename(value: string | undefined): string {
  const base = path.basename(value?.trim() || "attachment.bin")
    .replace(/[\x00-\x1f\x7f/\\]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 180);
  return base || "attachment.bin";
}

function normalizeMimeType(value: string | undefined): string {
  const normalized = value?.split(";", 1)[0]?.trim().toLowerCase();
  return normalized && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(normalized)
    ? normalized
    : "application/octet-stream";
}

export class FileSystemCommandUploadStore implements CommandUploadStore {
  private readonly env: NodeJS.ProcessEnv;
  private readonly maxBytes: number;
  private readonly ttlMs: number;

  constructor(options: FileSystemCommandUploadStoreOptions = {}) {
    this.env = options.env ?? process.env;
    this.maxBytes = options.maxBytes ?? MAX_COMMAND_UPLOAD_BYTES;
    this.ttlMs = options.ttlMs ?? DEFAULT_COMMAND_UPLOAD_TTL_MS;
  }

  async stage(input: {
    scope: CommandUploadScope;
    filename?: string;
    mimeType?: string;
    chunks: AsyncIterable<Uint8Array>;
  }): Promise<CommandUploadDescriptor> {
    const scope = this.normalizeScope(input.scope);
    const uploadRef = `upl_${randomUUID().replaceAll("-", "")}`;
    const directory = this.scopeDirectory(scope);
    const temporaryPath = path.join(directory, `.${uploadRef}.partial`);
    const dataPath = path.join(directory, `${uploadRef}.data`);
    const metadataPath = path.join(directory, `${uploadRef}.json`);
    const filename = sanitizeCommandUploadFilename(input.filename);
    const mimeType = normalizeMimeType(input.mimeType);
    await this.sweep(scope);
    await mkdir(directory, {recursive: true});

    let sizeBytes = 0;
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      for await (const chunk of input.chunks) {
        sizeBytes += chunk.byteLength;
        if (sizeBytes > this.maxBytes) {
          throw new CommandUploadError(413, `Command upload exceeds the ${this.maxBytes} byte limit.`);
        }
        await handle.write(chunk);
      }
      await handle.sync();
      await handle.close();
      await rename(temporaryPath, dataPath);
      const metadata: StoredUploadMetadata = {
        uploadRef,
        filename,
        mimeType,
        sizeBytes,
        agentKey: scope.agentKey,
        sessionId: scope.sessionId,
        createdAt: Date.now(),
      };
      await writeFile(metadataPath, JSON.stringify(metadata), {encoding: "utf8", mode: 0o600, flag: "wx"});
      return {uploadRef, filename, mimeType, sizeBytes};
    } catch (error) {
      await handle.close().catch(() => {});
      await rm(temporaryPath, {force: true});
      await rm(dataPath, {force: true});
      await rm(metadataPath, {force: true});
      throw error;
    }
  }

  async inspect(scope: CommandUploadScope, uploadRef: string): Promise<CommandUploadDescriptor> {
    const resolved = await this.resolve(scope, uploadRef);
    const {path: _path, ...descriptor} = resolved;
    return descriptor;
  }

  async resolve(scopeInput: CommandUploadScope, uploadRef: string): Promise<ResolvedCommandUpload> {
    const scope = this.normalizeScope(scopeInput);
    this.requireUploadRef(uploadRef);
    const directory = this.scopeDirectory(scope);
    let metadata: StoredUploadMetadata;
    try {
      metadata = JSON.parse(await readFile(path.join(directory, `${uploadRef}.json`), "utf8")) as StoredUploadMetadata;
    } catch {
      throw new CommandUploadError(404, "Command upload reference is unknown or not available to this sender.");
    }
    if (metadata.uploadRef !== uploadRef || metadata.agentKey !== scope.agentKey || metadata.sessionId !== scope.sessionId) {
      throw new CommandUploadError(403, "Command upload reference is not available to this sender.");
    }
    const dataPath = path.join(directory, `${uploadRef}.data`);
    const file = await stat(dataPath).catch(() => null);
    if (!file?.isFile() || file.size !== metadata.sizeBytes) {
      throw new CommandUploadError(404, "Command upload reference is incomplete or unavailable.");
    }
    return {
      uploadRef,
      filename: sanitizeCommandUploadFilename(metadata.filename),
      mimeType: normalizeMimeType(metadata.mimeType),
      sizeBytes: file.size,
      path: dataPath,
    };
  }

  async remove(scopeInput: CommandUploadScope, uploadRef: string): Promise<void> {
    const scope = this.normalizeScope(scopeInput);
    this.requireUploadRef(uploadRef);
    const directory = this.scopeDirectory(scope);
    await Promise.all([
      rm(path.join(directory, `${uploadRef}.data`), {force: true}),
      rm(path.join(directory, `${uploadRef}.json`), {force: true}),
    ]);
  }

  async sweep(scopeInput: CommandUploadScope, now = Date.now()): Promise<number> {
    const scope = this.normalizeScope(scopeInput);
    const directory = this.scopeDirectory(scope);
    const entries = await readdir(directory, {withFileTypes: true}).catch(() => []);
    let removed = 0;
    for (const entry of entries.slice(0, MAX_SWEEP_ENTRIES)) {
      if (!entry.isFile()) continue;
      const metadataMatch = /^(upl_[a-f0-9]{32})\.json$/.exec(entry.name);
      const dataMatch = /^(upl_[a-f0-9]{32})\.data$/.exec(entry.name);
      const partialMatch = /^\.(upl_[a-f0-9]{32})\.partial$/.exec(entry.name);
      const entryPath = path.join(directory, entry.name);
      const entryStat = await stat(entryPath).catch(() => null);
      if (!entryStat || now - entryStat.mtimeMs <= this.ttlMs) continue;

      if (metadataMatch) {
        await this.remove(scope, metadataMatch[1]!);
        removed += 1;
      } else if (partialMatch) {
        await rm(entryPath, {force: true});
        removed += 1;
      } else if (dataMatch) {
        const metadataExists = await stat(path.join(directory, `${dataMatch[1]}.json`)).then(
          () => true,
          () => false,
        );
        if (!metadataExists) {
          await rm(entryPath, {force: true});
          removed += 1;
        }
      }
    }
    return removed;
  }

  private normalizeScope(scope: CommandUploadScope): CommandUploadScope {
    return {
      agentKey: safeSegment(scope.agentKey, "Command upload agent key"),
      sessionId: safeSegment(scope.sessionId, "Command upload session id"),
    };
  }

  private scopeDirectory(scope: CommandUploadScope): string {
    return path.join(resolveAgentMediaDir(scope.agentKey, this.env), "command-upload", scope.sessionId);
  }

  private requireUploadRef(uploadRef: string): void {
    if (!UPLOAD_REF_PATTERN.test(uploadRef)) {
      throw new CommandUploadError(400, "Command upload reference is invalid.");
    }
  }
}
