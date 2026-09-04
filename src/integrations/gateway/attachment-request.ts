import {createHash} from "node:crypto";
import {open} from "node:fs/promises";
import path from "node:path";
import type {IncomingMessage} from "node:http";

import {trimToNull} from "../../lib/strings.js";
import {GatewayHttpError} from "./http-body.js";
import {readGatewayIdempotencyKey} from "./event-request.js";
import {createGatewayAttachmentMimeValidator, requireGatewayAttachmentMimeType} from "./attachment-mime.js";

const SHA256_PATTERN = /^[a-fA-F0-9]{64}$/;

export interface GatewayAttachmentUploadRequest {
  filename?: string;
  idempotencyKey: string;
  mimeType: string;
  sha256: string;
  sizeBytes: number;
  sniffedMimeType?: string;
}

export interface GatewayAttachmentUploadHeaders {
  filename?: string;
  idempotencyKey: string;
  mimeType: string;
  expectedSha256?: string;
  contentLength?: number;
}

function readHeaderValue(request: IncomingMessage, key: string): string | null {
  const value = request.headers[key.toLowerCase()];
  return trimToNull(Array.isArray(value) ? value[0] : value);
}

function sanitizeGatewayAttachmentFilename(value: string | null): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 180) {
    throw new GatewayHttpError(400, "X-Filename must be 1-180 characters when present.");
  }
  if (/[\\/\u0000-\u001F\u007F]/.test(trimmed)) {
    throw new GatewayHttpError(400, "X-Filename must be a basename without path separators or control characters.");
  }
  const basename = path.basename(trimmed);
  if (!basename || basename === "." || basename === "..") {
    throw new GatewayHttpError(400, "X-Filename must be a safe basename.");
  }
  return basename;
}

function readExpectedSha256(request: IncomingMessage): string | undefined {
  const value = readHeaderValue(request, "x-content-sha256");
  if (!value) {
    return undefined;
  }
  if (!SHA256_PATTERN.test(value)) {
    throw new GatewayHttpError(400, "X-Content-Sha256 must be 64 hex characters.");
  }
  return value.toLowerCase();
}

export function readGatewayAttachmentUploadHeaders(input: {
  allowedMimeTypes: readonly string[];
  maxBytes: number;
  request: IncomingMessage;
}): GatewayAttachmentUploadHeaders {
  const idempotencyKey = readGatewayIdempotencyKey(input.request);
  const declaredMimeType = readHeaderValue(input.request, "content-type");
  if (!declaredMimeType) {
    throw new GatewayHttpError(415, "Attachment Content-Type is required.");
  }
  const filename = sanitizeGatewayAttachmentFilename(readHeaderValue(input.request, "x-filename"));
  const expectedSha256 = readExpectedSha256(input.request);
  const mimeType = requireGatewayAttachmentMimeType(declaredMimeType, input.allowedMimeTypes);
  const rawLength = readHeaderValue(input.request, "content-length");
  const contentLength = rawLength === null ? undefined : Number(rawLength);
  if (contentLength !== undefined && (!/^\d+$/.test(rawLength!) || !Number.isSafeInteger(contentLength) || contentLength < 0)) {
    throw new GatewayHttpError(400, "Content-Length must be a non-negative integer.");
  }
  if (contentLength !== undefined && contentLength > input.maxBytes) throw new GatewayHttpError(413, "Request body is too large.");
  return {idempotencyKey, filename, expectedSha256, mimeType, contentLength};
}

export async function streamGatewayAttachmentUploadRequest(input: {
  headers: GatewayAttachmentUploadHeaders;
  localPath: string;
  maxBytes: number;
  expiresAt: number;
  request: IncomingMessage;
}): Promise<GatewayAttachmentUploadRequest> {
  const remainingMs = input.expiresAt - Date.now();
  if (remainingMs <= 0) throw new GatewayHttpError(408, "Attachment upload deadline exceeded.");
  const timer = setTimeout(() => input.request.destroy(new GatewayHttpError(408, "Attachment upload deadline exceeded.")), remainingMs);
  timer.unref();
  const hash = createHash("sha256");
  const mime = createGatewayAttachmentMimeValidator(input.headers.mimeType);
  let sizeBytes = 0;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(input.localPath, "wx", 0o600);
    for await (const chunk of input.request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      sizeBytes += bytes.length;
      if (sizeBytes > Math.min(input.maxBytes, input.headers.contentLength ?? input.maxBytes)) throw new GatewayHttpError(413, "Request body is too large.");
      if (Date.now() >= input.expiresAt) throw new GatewayHttpError(408, "Attachment upload deadline exceeded.");
      hash.update(bytes);
      mime.update(bytes);
      await file.writeFile(bytes);
    }
  } finally {
    clearTimeout(timer);
    await file?.close();
  }
  if (Date.now() >= input.expiresAt) throw new GatewayHttpError(408, "Attachment upload deadline exceeded.");
  if (sizeBytes === 0) {
    throw new GatewayHttpError(400, "Attachment body must not be empty.");
  }
  if (input.headers.contentLength !== undefined && sizeBytes !== input.headers.contentLength) throw new GatewayHttpError(400, "Content-Length does not match the attachment body.");
  const sha256 = hash.digest("hex");
  if (input.headers.expectedSha256 && sha256 !== input.headers.expectedSha256) {
    throw new GatewayHttpError(400, "X-Content-Sha256 does not match the attachment body.");
  }
  return {
    filename: input.headers.filename,
    idempotencyKey: input.headers.idempotencyKey,
    ...mime.finish(),
    sha256,
    sizeBytes,
  };
}
