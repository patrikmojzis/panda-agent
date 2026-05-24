import {createHash} from "node:crypto";
import path from "node:path";
import type {IncomingMessage} from "node:http";

import {trimToNull} from "../../lib/strings.js";
import {GatewayHttpError, readGatewayRawBody} from "./http-body.js";
import {readGatewayIdempotencyKey} from "./event-request.js";
import {assertGatewayAttachmentMimeAccepted} from "./attachment-mime.js";

const SHA256_PATTERN = /^[a-fA-F0-9]{64}$/;

export interface GatewayAttachmentUploadRequest {
  bytes: Buffer;
  filename?: string;
  idempotencyKey: string;
  mimeType: string;
  sha256: string;
  sizeBytes: number;
  sniffedMimeType?: string;
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

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function readGatewayAttachmentUploadRequest(input: {
  allowedMimeTypes: readonly string[];
  maxBytes: number;
  request: IncomingMessage;
}): Promise<GatewayAttachmentUploadRequest> {
  const idempotencyKey = readGatewayIdempotencyKey(input.request);
  const declaredMimeType = readHeaderValue(input.request, "content-type");
  if (!declaredMimeType) {
    throw new GatewayHttpError(415, "Attachment Content-Type is required.");
  }
  const filename = sanitizeGatewayAttachmentFilename(readHeaderValue(input.request, "x-filename"));
  const expectedSha256 = readExpectedSha256(input.request);
  const bytes = await readGatewayRawBody(input.request, input.maxBytes);
  if (bytes.length === 0) {
    throw new GatewayHttpError(400, "Attachment body must not be empty.");
  }
  const sha256 = sha256Hex(bytes);
  if (expectedSha256 && sha256 !== expectedSha256) {
    throw new GatewayHttpError(400, "X-Content-Sha256 does not match the attachment body.");
  }
  const mime = assertGatewayAttachmentMimeAccepted({
    allowedMimeTypes: input.allowedMimeTypes,
    bytes,
    declaredMimeType,
  });
  return {
    bytes,
    filename,
    idempotencyKey,
    mimeType: mime.mimeType,
    sha256,
    sizeBytes: bytes.length,
    sniffedMimeType: mime.sniffedMimeType,
  };
}
