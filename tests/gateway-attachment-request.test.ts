import {createHash} from "node:crypto";
import type {IncomingMessage} from "node:http";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {Readable} from "node:stream";

import {describe, expect, it} from "vitest";

import {readGatewayAttachmentUploadHeaders, streamGatewayAttachmentUploadRequest} from "../src/integrations/gateway/attachment-request.js";

async function readGatewayAttachmentUploadRequest(input: Parameters<typeof readGatewayAttachmentUploadHeaders>[0]) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gateway-stream-"));
  try {
    const headers = readGatewayAttachmentUploadHeaders(input);
    const localPath = path.join(directory, "upload");
    const result = await streamGatewayAttachmentUploadRequest({...input, headers, localPath, expiresAt: Date.now() + 10_000});
    return {...result, bytes: await readFile(localPath)};
  } finally { await rm(directory, {recursive: true, force: true}); }
}

const ALLOWED_MIME_TYPES = ["text/plain", "application/json", "image/png", "image/jpeg"];

function createRequest(body: string | Buffer, headers: IncomingMessage["headers"] = {}): IncomingMessage {
  return Object.assign(Readable.from([body]), {
    headers,
  }) as IncomingMessage;
}

function sha256Hex(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("gateway attachment upload requests", () => {
  it("parses valid bounded raw uploads", async () => {
    const body = Buffer.from("hello attachment", "utf8");
    await expect(readGatewayAttachmentUploadRequest({
      allowedMimeTypes: ALLOWED_MIME_TYPES,
      maxBytes: 1024,
      request: createRequest(body, {
        "content-type": "text/plain; charset=utf-8",
        "idempotency-key": "upload-1",
        "x-content-sha256": sha256Hex(body),
        "x-filename": "note.txt",
      }),
    })).resolves.toMatchObject({
      bytes: body,
      filename: "note.txt",
      idempotencyKey: "upload-1",
      mimeType: "text/plain",
      sha256: sha256Hex(body),
      sizeBytes: body.length,
      sniffedMimeType: "text/plain",
    });
  });

  it("rejects missing idempotency, bad digest headers, unsafe filenames, and empty bodies", async () => {
    await expect(readGatewayAttachmentUploadRequest({
      allowedMimeTypes: ALLOWED_MIME_TYPES,
      maxBytes: 1024,
      request: createRequest("hello", {"content-type": "text/plain"}),
    })).rejects.toMatchObject({statusCode: 400, message: "Missing Idempotency-Key header."});

    await expect(readGatewayAttachmentUploadRequest({
      allowedMimeTypes: ALLOWED_MIME_TYPES,
      maxBytes: 1024,
      request: createRequest("hello", {
        "content-type": "text/plain",
        "idempotency-key": "upload-1",
        "x-content-sha256": "bad",
      }),
    })).rejects.toMatchObject({statusCode: 400, message: "X-Content-Sha256 must be 64 hex characters."});

    await expect(readGatewayAttachmentUploadRequest({
      allowedMimeTypes: ALLOWED_MIME_TYPES,
      maxBytes: 1024,
      request: createRequest("hello", {
        "content-type": "text/plain",
        "idempotency-key": "upload-1",
        "x-filename": "../secret.txt",
      }),
    })).rejects.toMatchObject({statusCode: 400});

    await expect(readGatewayAttachmentUploadRequest({
      allowedMimeTypes: ALLOWED_MIME_TYPES,
      maxBytes: 1024,
      request: createRequest("", {
        "content-type": "text/plain",
        "idempotency-key": "upload-1",
      }),
    })).rejects.toMatchObject({statusCode: 400, message: "Attachment body must not be empty."});
  });

  it("rejects unsupported, ambiguous, mismatched, and oversized uploads", async () => {
    await expect(readGatewayAttachmentUploadRequest({
      allowedMimeTypes: ALLOWED_MIME_TYPES,
      maxBytes: 1024,
      request: createRequest("hello", {
        "content-type": "application/octet-stream",
        "idempotency-key": "upload-1",
      }),
    })).rejects.toMatchObject({statusCode: 415});

    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    await expect(readGatewayAttachmentUploadRequest({
      allowedMimeTypes: ALLOWED_MIME_TYPES,
      maxBytes: 1024,
      request: createRequest(pngBytes, {
        "content-type": "image/jpeg",
        "idempotency-key": "upload-1",
      }),
    })).rejects.toMatchObject({
      statusCode: 415,
      message: "Attachment Content-Type does not match the file signature.",
    });

    await expect(readGatewayAttachmentUploadRequest({
      allowedMimeTypes: ALLOWED_MIME_TYPES,
      maxBytes: 4,
      request: createRequest("hello", {
        "content-length": "5",
        "content-type": "text/plain",
        "idempotency-key": "upload-1",
      }),
    })).rejects.toMatchObject({statusCode: 413});
  });
  it("validates split signatures and UTF-8 across chunks without retaining the body", async () => {
    const bytes = Buffer.from("  {\"name\":\"café\"}");
    const request = Object.assign(Readable.from([...bytes].map((value) => Buffer.from([value]))), {
      headers: {"content-type": "application/json", "idempotency-key": "streamed"},
    }) as IncomingMessage;
    await expect(readGatewayAttachmentUploadRequest({allowedMimeTypes: ALLOWED_MIME_TYPES, maxBytes: 1024, request}))
      .resolves.toMatchObject({bytes, sha256: sha256Hex(bytes), sniffedMimeType: "application/json"});
  });

  it("rejects a chunked body once it exceeds the admitted bound", async () => {
    const request = Object.assign(Readable.from(["12", "34", "56"]), {
      headers: {"content-type": "text/plain", "idempotency-key": "large-chunked"},
    }) as IncomingMessage;
    await expect(readGatewayAttachmentUploadRequest({allowedMimeTypes: ALLOWED_MIME_TYPES, maxBytes: 4, request}))
      .rejects.toMatchObject({statusCode: 413});
  });

  it("ends stalled bodies at a finite deadline", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "gateway-timeout-"));
    const request = Object.assign(new Readable({read() {}}), {
      headers: {"content-type": "text/plain", "idempotency-key": "stalled"},
    }) as IncomingMessage;
    try {
      const headers = readGatewayAttachmentUploadHeaders({allowedMimeTypes: ALLOWED_MIME_TYPES, maxBytes: 1024, request});
      await expect(streamGatewayAttachmentUploadRequest({headers, localPath: path.join(directory, "upload"), maxBytes: 1024,
        expiresAt: Date.now() + 20, request})).rejects.toMatchObject({statusCode: 408});
      expect(request.destroyed).toBe(true);
    } finally { await rm(directory, {recursive: true, force: true}); }
  });

});
