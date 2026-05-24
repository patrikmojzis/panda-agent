import * as fs from "node:fs/promises";
import path from "node:path";
import type {IncomingMessage} from "node:http";

import {FileSystemMediaStore} from "../../domain/channels/media-store.js";
import type {GatewayAttachmentRecord, GatewaySourceRecord} from "../../domain/gateway/types.js";
import {
  GatewayAttachmentConflictError,
  sameIdempotentAttachmentUpload,
} from "../../domain/gateway/postgres.js";
import {resolveAgentMediaDir} from "../../lib/data-dir.js";
import type {JsonValue} from "../../lib/json.js";
import {GatewayHttpError} from "./http-body.js";
import {readGatewayBearerToken} from "./event-request.js";
import {readGatewayAttachmentUploadRequest} from "./attachment-request.js";

interface GatewayAttachmentAcceptanceStore {
  countPendingAttachmentsForSource(sourceId: string): Promise<number>;
  getAttachmentByIdempotencyKey(sourceId: string, idempotencyKey: string): Promise<GatewayAttachmentRecord | null>;
  resolveAccessToken(token: string): Promise<GatewaySourceRecord | null>;
  storeAttachmentUpload(input: {
    descriptor: {
      id: string;
      source: string;
      connectorKey: string;
      mimeType: string;
      sizeBytes: number;
      localPath: string;
      originalFilename?: string;
      metadata?: JsonValue;
      createdAt: number;
    };
    expiresAt: number;
    filename?: string;
    idempotencyKey: string;
    mimeType: string;
    sha256: string;
    sniffedMimeType?: string;
    sourceId: string;
  }): Promise<{
    attachment: GatewayAttachmentRecord;
    inserted: boolean;
  }>;
  useRateLimit(input: {
    cost?: number;
    key: string;
    limit: number;
    windowMs: number;
  }): Promise<{allowed: boolean}>;
}

function serializeAttachmentResponse(attachment: GatewayAttachmentRecord): {
  attachmentId: string;
  expiresAt: string;
  filename: string | null;
  mimeType: string;
  ok: true;
  sha256: string;
  sizeBytes: number;
  status: GatewayAttachmentRecord["status"];
} {
  return {
    ok: true,
    attachmentId: attachment.id,
    sha256: attachment.sha256,
    sizeBytes: attachment.sizeBytes,
    mimeType: attachment.mimeType,
    filename: attachment.filename ?? null,
    status: attachment.status,
    expiresAt: new Date(attachment.expiresAt).toISOString(),
  };
}

async function safeUnlink(localPath: string): Promise<void> {
  await fs.unlink(localPath).catch((error: unknown) => {
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

async function requireGatewaySource(input: {
  request: IncomingMessage;
  store: Pick<GatewayAttachmentAcceptanceStore, "resolveAccessToken">;
}): Promise<GatewaySourceRecord> {
  const token = readGatewayBearerToken(input.request);
  const source = await input.store.resolveAccessToken(token);
  if (!source) {
    throw new GatewayHttpError(401, "Invalid bearer token.");
  }
  return source;
}

export async function acceptGatewayAttachmentUploadRequest(input: {
  allowedMimeTypes: readonly string[];
  attachmentBytesPerHour: number;
  attachmentUploadTtlMs: number;
  env?: NodeJS.ProcessEnv;
  maxBytes: number;
  maxPendingAttachmentsPerSource: number;
  request: IncomingMessage;
  store: GatewayAttachmentAcceptanceStore;
}): Promise<{
  body: ReturnType<typeof serializeAttachmentResponse>;
  status: 200 | 201;
}> {
  const source = await requireGatewaySource({
    request: input.request,
    store: input.store,
  });
  const upload = await readGatewayAttachmentUploadRequest({
    allowedMimeTypes: input.allowedMimeTypes,
    maxBytes: input.maxBytes,
    request: input.request,
  });

  const existing = await input.store.getAttachmentByIdempotencyKey(source.sourceId, upload.idempotencyKey);
  if (existing) {
    if (!sameIdempotentAttachmentUpload(existing, {
      descriptor: {sizeBytes: upload.sizeBytes},
      mimeType: upload.mimeType,
      sha256: upload.sha256,
    })) {
      throw new GatewayAttachmentConflictError(existing);
    }
    return {
      status: 200,
      body: serializeAttachmentResponse(existing),
    };
  }

  const pending = await input.store.countPendingAttachmentsForSource(source.sourceId);
  if (pending >= input.maxPendingAttachmentsPerSource) {
    throw new GatewayHttpError(429, "Pending attachment limit exceeded.");
  }

  const byteBudget = await input.store.useRateLimit({
    key: `gateway:source:${source.sourceId}:attachment_bytes`,
    windowMs: 60 * 60_000,
    cost: upload.sizeBytes,
    limit: input.attachmentBytesPerHour,
  });
  if (!byteBudget.allowed) {
    throw new GatewayHttpError(429, "Attachment byte budget exceeded.");
  }

  const mediaStore = new FileSystemMediaStore({
    rootDir: resolveAgentMediaDir(source.agentKey, input.env),
  });
  const descriptor = await mediaStore.writeMedia({
    bytes: upload.bytes,
    source: "gateway",
    connectorKey: source.sourceId,
    mimeType: upload.mimeType,
    sizeBytes: upload.sizeBytes,
    hintFilename: upload.filename,
    metadata: {
      schemaVersion: 1,
      gateway: {
        sourceId: source.sourceId,
        sha256: upload.sha256,
        scanStatus: "not_scanned",
        trust: "external_untrusted",
      },
    },
  });
  const filename = upload.filename ?? path.basename(descriptor.localPath);
  try {
    const stored = await input.store.storeAttachmentUpload({
      sourceId: source.sourceId,
      idempotencyKey: upload.idempotencyKey,
      descriptor: {
        ...descriptor,
        originalFilename: filename,
      },
      sha256: upload.sha256,
      mimeType: upload.mimeType,
      sniffedMimeType: upload.sniffedMimeType,
      filename,
      expiresAt: Date.now() + Math.max(1, Math.floor(input.attachmentUploadTtlMs)),
    });
    if (!stored.inserted && stored.attachment.localPath !== descriptor.localPath) {
      await safeUnlink(descriptor.localPath);
    }
    return {
      status: stored.inserted ? 201 : 200,
      body: serializeAttachmentResponse(stored.attachment),
    };
  } catch (error) {
    await safeUnlink(descriptor.localPath).catch(() => undefined);
    throw error;
  }
}
