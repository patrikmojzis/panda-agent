import {randomUUID} from "node:crypto";
import {mkdir, readFile, readdir, rename, rm, stat, writeFile} from "node:fs/promises";
import path from "node:path";

import {resolveAgentMediaDir} from "../../lib/data-dir.js";
import {readSafePathSegment} from "../../lib/path-segments.js";

const RESOURCE_REF_PATTERN = /^web_[a-f0-9]{32}$/;
const CURSOR_PATTERN = /^cur_[a-f0-9]{32}$/;
const MAX_RESOURCE_CURSORS = 1_000;
const MAX_SCOPE_RESOURCES = 1_000;
export const DEFAULT_WEB_RESOURCE_TTL_MS = 60 * 60 * 1_000;
export const DEFAULT_WEB_RESOURCE_SCOPE_BYTES = 100 * 1024 * 1024;

export interface WebResourceScope {
  agentKey: string;
  sessionId: string;
}

interface StoredWebResource {
  resourceRef: string;
  contentKind: string;
  contentFormat: string;
  contentType: string;
  filename: string;
  sizeBytes: number;
  createdAt: number;
  expiresAt: number;
  readable: boolean;
  cursors: Record<string, number>;
}

export class WebResourceError extends Error {
  constructor(
    readonly failureCode: "resource_expired" | "storage_failed",
    message: string,
  ) {
    super(message);
    this.name = "WebResourceError";
  }
}

function safeSegment(value: string, label: string): string {
  const segment = readSafePathSegment(value);
  if (!segment) {
    throw new WebResourceError("storage_failed", `${label} is invalid.`);
  }
  return segment;
}

function opaqueRef(prefix: "web" | "cur"): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

/** Stores short-lived web content and resolves opaque session-scoped continuation cursors. */
export class FileSystemWebResourceStore {
  private readonly env: NodeJS.ProcessEnv;
  private readonly ttlMs: number;
  private readonly maxScopeBytes: number;

  constructor(options: {
    env?: NodeJS.ProcessEnv;
    ttlMs?: number;
    maxScopeBytes?: number;
  } = {}) {
    this.env = options.env ?? process.env;
    this.ttlMs = Math.max(1, Math.floor(options.ttlMs ?? DEFAULT_WEB_RESOURCE_TTL_MS));
    this.maxScopeBytes = Math.max(
      1,
      Math.floor(options.maxScopeBytes ?? DEFAULT_WEB_RESOURCE_SCOPE_BYTES),
    );
  }

  async store(input: {
    scope: WebResourceScope;
    contentKind: string;
    contentFormat: string;
    contentType: string;
    filename: string;
    bytes: Uint8Array;
    readable: boolean;
  }): Promise<{resourceRef: string; path: string; filename: string; expiresAt: number}> {
    const scope = this.normalizeScope(input.scope);
    const directory = this.scopeDirectory(scope);
    await mkdir(directory, {recursive: true});
    await this.sweep(scope);
    const usage = await this.scopeUsage(directory);
    if (
      usage.count >= MAX_SCOPE_RESOURCES
      || usage.bytes + input.bytes.byteLength > this.maxScopeBytes
    ) {
      throw new WebResourceError(
        "storage_failed",
        "Temporary web resource storage is full for this session.",
      );
    }

    const resourceRef = opaqueRef("web");
    const dataPath = path.join(directory, `${resourceRef}.data`);
    const metadataPath = path.join(directory, `${resourceRef}.json`);
    const temporaryPath = `${dataPath}.partial`;
    const createdAt = Date.now();
    const expiresAt = createdAt + this.ttlMs;
    const metadata: StoredWebResource = {
      resourceRef,
      contentKind: input.contentKind,
      contentFormat: input.contentFormat,
      contentType: input.contentType,
      filename: path.basename(input.filename)
        .replace(/[\x00-\x1f\x7f/\\]/g, "_")
        .slice(0, 180) || "resource.bin",
      sizeBytes: input.bytes.byteLength,
      createdAt,
      expiresAt,
      readable: input.readable,
      cursors: {},
    };
    try {
      await writeFile(temporaryPath, input.bytes, {mode: 0o600, flag: "wx"});
      await rename(temporaryPath, dataPath);
      await writeFile(metadataPath, JSON.stringify(metadata), {encoding: "utf8", mode: 0o600, flag: "wx"});
    } catch {
      await Promise.all([
        rm(temporaryPath, {force: true}),
        rm(dataPath, {force: true}),
        rm(metadataPath, {force: true}),
      ]);
      throw new WebResourceError("storage_failed", "Temporary web resource storage failed.");
    }
    this.scheduleExpiry(scope, resourceRef, expiresAt);
    return {resourceRef, path: dataPath, filename: metadata.filename, expiresAt};
  }

  async read(input: {
    scope: WebResourceScope;
    resourceRef: string;
    cursor?: string;
    chunkChars: number;
  }): Promise<{
    contentKind: string;
    contentFormat: string;
    content: string;
    contentComplete: boolean;
    nextCursor?: string;
  }> {
    if (!Number.isSafeInteger(input.chunkChars) || input.chunkChars < 1) {
      throw new WebResourceError("storage_failed", "Web resource chunk size is invalid.");
    }
    const scope = this.normalizeScope(input.scope);
    const metadata = await this.load(scope, input.resourceRef);
    if (!metadata.readable) {
      throw new WebResourceError("storage_failed", "This web resource is an artifact and has no readable continuation.");
    }
    const offset = input.cursor ? this.cursorOffset(metadata, input.cursor) : 0;
    const dataPath = path.join(this.scopeDirectory(scope), `${metadata.resourceRef}.data`);
    const content = await readFile(dataPath, "utf8")
      .catch(() => {
        throw new WebResourceError("storage_failed", "Temporary web resource content could not be read.");
      });
    const end = Math.min(content.length, offset + input.chunkChars);
    const nextCursor = end < content.length ? opaqueRef("cur") : undefined;
    if (nextCursor) {
      const cursorKeys = Object.keys(metadata.cursors);
      if (cursorKeys.length >= MAX_RESOURCE_CURSORS) {
        delete metadata.cursors[cursorKeys[0]!];
      }
      metadata.cursors[nextCursor] = end;
      await this.writeMetadata(scope, metadata).catch(() => {
        throw new WebResourceError("storage_failed", "Temporary web resource cursor could not be stored.");
      });
    }
    return {
      contentKind: metadata.contentKind,
      contentFormat: metadata.contentFormat,
      content: content.slice(offset, end),
      contentComplete: end >= content.length,
      ...(nextCursor ? {nextCursor} : {}),
    };
  }

  async sweep(scopeInput: WebResourceScope, now = Date.now()): Promise<number> {
    const scope = this.normalizeScope(scopeInput);
    const directory = this.scopeDirectory(scope);
    const entries: string[] = await readdir(directory, {encoding: "utf8"})
      .catch(() => []);
    let removed = 0;
    for (const name of entries.slice(0, 1_000)) {
      const match = /^(web_[a-f0-9]{32})\.json$/.exec(name);
      if (!match) continue;
      const metadata = await this.readMetadataFile(path.join(directory, name)).catch(() => null);
      if (!metadata) {
        await this.remove(scope, match[1]!);
        removed += 1;
        continue;
      }
      if (metadata.expiresAt <= now) {
        await this.remove(scope, match[1]!);
        removed += 1;
      }
    }
    for (const name of entries.slice(0, 1_000)) {
      const match = /^(web_[a-f0-9]{32})\.data$/.exec(name);
      if (!match || entries.includes(`${match[1]}.json`)) continue;
      const dataStat = await stat(path.join(directory, name)).catch(() => null);
      if (dataStat && dataStat.mtimeMs + this.ttlMs <= now) {
        await rm(path.join(directory, name), {force: true});
        removed += 1;
      }
    }
    return removed;
  }

  private async load(scope: WebResourceScope, resourceRef: string): Promise<StoredWebResource> {
    if (!RESOURCE_REF_PATTERN.test(resourceRef)) {
      throw new WebResourceError("resource_expired", "Web resource reference is unknown or expired.");
    }
    const metadataPath = path.join(this.scopeDirectory(scope), `${resourceRef}.json`);
    const metadata = await this.readMetadataFile(metadataPath).catch(() => null);
    if (!metadata || metadata.resourceRef !== resourceRef) {
      throw new WebResourceError("resource_expired", "Web resource reference is unknown or expired.");
    }
    if (metadata.expiresAt <= Date.now()) {
      await this.remove(scope, resourceRef);
      throw new WebResourceError("resource_expired", "Web resource reference has expired.");
    }
    return metadata;
  }

  private cursorOffset(metadata: StoredWebResource, cursor: string): number {
    if (!CURSOR_PATTERN.test(cursor) || !Number.isSafeInteger(metadata.cursors[cursor])) {
      throw new WebResourceError("resource_expired", "Web resource cursor is unknown or expired.");
    }
    return metadata.cursors[cursor]!;
  }

  private async writeMetadata(scope: WebResourceScope, metadata: StoredWebResource): Promise<void> {
    const metadataPath = path.join(this.scopeDirectory(scope), `${metadata.resourceRef}.json`);
    const temporaryPath = `${metadataPath}.partial`;
    await writeFile(temporaryPath, JSON.stringify(metadata), {encoding: "utf8", mode: 0o600});
    await rename(temporaryPath, metadataPath);
  }

  private async remove(scope: WebResourceScope, resourceRef: string): Promise<void> {
    const directory = this.scopeDirectory(scope);
    await Promise.all([
      rm(path.join(directory, `${resourceRef}.data`), {force: true}),
      rm(path.join(directory, `${resourceRef}.json`), {force: true}),
    ]);
  }

  private async scopeUsage(directory: string): Promise<{bytes: number; count: number}> {
    const entries: string[] = await readdir(directory, {encoding: "utf8"})
      .catch(() => []);
    const resources = entries.filter((name) =>
      name.endsWith(".data") && RESOURCE_REF_PATTERN.test(name.slice(0, -".data".length))
    );
    const sizes = await Promise.all(resources.map(async (name) =>
      (await stat(path.join(directory, name)).catch(() => null))?.size ?? 0
    ));
    return {
      bytes: sizes.reduce((total, size) => total + size, 0),
      count: resources.length,
    };
  }

  private scheduleExpiry(scope: WebResourceScope, resourceRef: string, expiresAt: number): void {
    const timer = setTimeout(() => {
      void this.remove(scope, resourceRef).catch(() => undefined);
    }, Math.max(1, expiresAt - Date.now()));
    timer.unref();
  }

  private async readMetadataFile(metadataPath: string): Promise<StoredWebResource> {
    return JSON.parse(await readFile(metadataPath, "utf8")) as StoredWebResource;
  }

  private normalizeScope(scope: WebResourceScope): WebResourceScope {
    return {
      agentKey: safeSegment(scope.agentKey, "Web resource agent key"),
      sessionId: safeSegment(scope.sessionId, "Web resource session id"),
    };
  }

  private scopeDirectory(scope: WebResourceScope): string {
    return path.join(resolveAgentMediaDir(scope.agentKey, this.env), "web-resource", scope.sessionId);
  }
}
