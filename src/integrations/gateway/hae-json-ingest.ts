import {createHash, randomUUID, timingSafeEqual} from "node:crypto";
import * as fs from "node:fs/promises";
import type {IncomingMessage} from "node:http";
import path from "node:path";
import {TextDecoder} from "node:util";

import {readGatewayBearerToken} from "./event-request.js";
import {GatewayHttpError, readGatewayRawBody, requireGatewayContentType} from "./http-body.js";

export const GATEWAY_HAE_JSON_PATH = "/v1/health/hae";

const HAE_JSON_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const utf8Decoder = new TextDecoder("utf-8", {fatal: true});

export interface GatewayHaeJsonIngestConfig {
  clock?: () => Date;
  fileSystem?: GatewayHaeJsonFileSystem;
  idFactory?: () => string;
  inboxDir: string;
  maxBytes: number;
  source: string;
  token: string;
}

export interface GatewayHaeJsonFileSystem {
  mkdir(target: string, options: {recursive: true; mode: number}): Promise<unknown>;
  rename(oldPath: string, newPath: string): Promise<unknown>;
  unlink(target: string): Promise<unknown>;
  writeFile(target: string, data: Buffer, options: {flag: "wx"; mode: number}): Promise<unknown>;
}

export interface GatewayHaeJsonWriteResult {
  byteCount: number;
  filename: string;
  id: string;
  localPath: string;
  timestamp: string;
}

const nodeFileSystem: GatewayHaeJsonFileSystem = {
  mkdir: (target, options) => fs.mkdir(target, options),
  rename: (oldPath, newPath) => fs.rename(oldPath, newPath),
  unlink: (target) => fs.unlink(target),
  writeFile: (target, data, options) => fs.writeFile(target, data, options),
};

function sha256Bytes(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function tokenEquals(provided: string, expected: string): boolean {
  return timingSafeEqual(sha256Bytes(provided), sha256Bytes(expected));
}

function compactIsoTimestamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function createSafeId(idFactory: () => string): string {
  const id = idFactory().trim();
  if (!HAE_JSON_ID_PATTERN.test(id)) {
    throw new Error("HAE JSON id factory returned an unsafe id.");
  }
  return id;
}

function assertValidJson(rawBody: Buffer): void {
  try {
    JSON.parse(utf8Decoder.decode(rawBody));
  } catch {
    throw new GatewayHttpError(400, "HAE JSON payload must be valid JSON.");
  }
}

async function safeUnlink(fileSystem: GatewayHaeJsonFileSystem, target: string): Promise<void> {
  await fileSystem.unlink(target).catch((error: unknown) => {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return;
    }
    throw error;
  });
}

export async function writeHaeJsonInboxFile(input: {
  bytes: Buffer;
  fileSystem?: GatewayHaeJsonFileSystem;
  id?: string;
  inboxDir: string;
  now: Date;
}): Promise<GatewayHaeJsonWriteResult> {
  const fileSystem = input.fileSystem ?? nodeFileSystem;
  const id = input.id ? createSafeId(() => input.id ?? "") : createSafeId(randomUUID);
  const timestamp = input.now.toISOString();
  const filename = `${compactIsoTimestamp(input.now)}-${id}.json`;
  const finalPath = path.join(input.inboxDir, filename);
  const tempPath = path.join(input.inboxDir, `.${filename}.${process.pid}.tmp`);

  await fileSystem.mkdir(input.inboxDir, {recursive: true, mode: 0o700});
  try {
    await fileSystem.writeFile(tempPath, input.bytes, {flag: "wx", mode: 0o600});
    await fileSystem.rename(tempPath, finalPath);
  } catch (error) {
    await safeUnlink(fileSystem, tempPath).catch(() => undefined);
    throw error;
  }

  return {
    id,
    filename,
    localPath: finalPath,
    byteCount: input.bytes.length,
    timestamp,
  };
}

export async function acceptGatewayHaeJsonIngestRequest(input: {
  config: GatewayHaeJsonIngestConfig;
  request: IncomingMessage;
}): Promise<{
  body: {
    accepted: true;
    byteCount: number;
    filename: string;
    id: string;
    ok: true;
    source: string;
    timestamp: string;
  };
  status: 202;
}> {
  const token = readGatewayBearerToken(input.request);
  if (!tokenEquals(token, input.config.token)) {
    throw new GatewayHttpError(401, "Invalid bearer token.");
  }

  requireGatewayContentType(input.request, ["application/json"]);
  const bytes = await readGatewayRawBody(input.request, input.config.maxBytes);
  assertValidJson(bytes);

  const written = await writeHaeJsonInboxFile({
    bytes,
    inboxDir: input.config.inboxDir,
    now: input.config.clock?.() ?? new Date(),
    ...(input.config.fileSystem ? {fileSystem: input.config.fileSystem} : {}),
    ...(input.config.idFactory ? {id: createSafeId(input.config.idFactory)} : {}),
  });

  return {
    status: 202,
    body: {
      ok: true,
      accepted: true,
      id: written.id,
      filename: written.filename,
      byteCount: written.byteCount,
      timestamp: written.timestamp,
      source: input.config.source,
    },
  };
}
