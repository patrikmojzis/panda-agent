import type {IncomingMessage} from "node:http";

import {inferMediaExtension} from "../../domain/channels/media-store.js";
import type {GatewayAttachmentRecord, GatewaySourceRecord, GatewayAttachmentUploadInput} from "../../domain/gateway/types.js";
import {sameIdempotentAttachmentUpload, type PostgresGatewayStore} from "../../domain/gateway/postgres.js";
import {GatewayHttpError} from "./http-body.js";
import {readGatewayBearerToken} from "./event-request.js";
import {readGatewayAttachmentUploadHeaders, streamGatewayAttachmentUploadRequest} from "./attachment-request.js";
import {cleanGatewayUploadDirectory, createGatewayUploadDirectory} from "./attachment-storage.js";

type GatewayAttachmentAcceptanceStore = Pick<PostgresGatewayStore,
  "resolveAccessToken" | "resolveDeviceToken" | "touchDeviceSeen" | "reserveAttachmentUpload" | "completeAttachmentUpload"
  | "discardAttachmentUpload" | "removeAttachmentUploadReservation" | "getAttachmentByIdempotencyKey">;

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

async function requireGatewaySource(input: {
  request: IncomingMessage;
  store: Pick<GatewayAttachmentAcceptanceStore, "resolveAccessToken" | "resolveDeviceToken" | "touchDeviceSeen">;
}): Promise<{source: GatewaySourceRecord; device?: {deviceId: string; capabilities: readonly string[]}}> {
  const token = readGatewayBearerToken(input.request);
  const source = await input.store.resolveAccessToken(token);
  if (source) {
    return {source};
  }

  const resolved = await input.store.resolveDeviceToken(token);
  if (!resolved) {
    throw new GatewayHttpError(401, "Invalid bearer token.");
  }

  if (!resolved.device.capabilities.includes("upload_attachments")) {
    throw new GatewayHttpError(403, "Device token is missing the upload_attachments capability.");
  }

  await input.store.touchDeviceSeen({sourceId: resolved.source.sourceId, deviceId: resolved.device.deviceId});
  return {source: resolved.source, device: {deviceId: resolved.device.deviceId, capabilities: resolved.device.capabilities}};
}

export async function acceptGatewayAttachmentUploadRequest(input: {
  allowedMimeTypes: readonly string[];
  attachmentBytesPerHour: number;
  attachmentUploadTtlMs: number;
  attachmentRequestTimeoutMs: number;
  deadline?: number;
  maxConcurrentAttachmentUploads: number;
  env?: NodeJS.ProcessEnv;
  maxBytes: number;
  maxPendingAttachmentsPerSource: number;
  request: IncomingMessage;
  store: GatewayAttachmentAcceptanceStore;
}): Promise<{body: ReturnType<typeof serializeAttachmentResponse>; status: 200 | 201}> {
  const expiresAt = input.deadline ?? Date.now() + input.attachmentRequestTimeoutMs;
  const remainingMs = expiresAt - Date.now();
  if (remainingMs <= 0) throw new GatewayHttpError(408, "Attachment upload deadline exceeded.");
  // Cover authentication/admission waits too. A stalled DB must not keep the HTTP body open forever.
  const onRequestError = () => {};
  input.request.on("error", onRequestError);
  const timer = setTimeout(() => input.request.destroy(new GatewayHttpError(408, "Attachment upload deadline exceeded.")), remainingMs);
  timer.unref();
  try {
    const {source, device} = await requireGatewaySource(input);
    const headers = readGatewayAttachmentUploadHeaders(input);
    const connectorKey = device ? `${source.sourceId}__${device.deviceId}` : source.sourceId;
    const directory = await createGatewayUploadDirectory({sourceId: source.sourceId, agentKey: source.agentKey,
      connectorKey, expiresAt, env: input.env});
    let completedInput: GatewayAttachmentUploadInput | undefined;
    try {
      const reservation = await input.store.reserveAttachmentUpload({id: directory.id, sourceId: source.sourceId,
        directory: directory.directory, idempotencyKey: headers.idempotencyKey, reservedBytes: headers.contentLength ?? input.maxBytes,
        maxConcurrent: input.maxConcurrentAttachmentUploads, maxPending: input.maxPendingAttachmentsPerSource,
        byteLimit: input.attachmentBytesPerHour, expiresAt});
      const upload = await streamGatewayAttachmentUploadRequest({headers, localPath: directory.localPath,
        maxBytes: input.maxBytes, expiresAt: Math.min(expiresAt, reservation.expiresAt), request: input.request});
      const filename = upload.filename ?? `${directory.id}${inferMediaExtension(upload.mimeType)}`;
      completedInput = {sourceId: source.sourceId, idempotencyKey: upload.idempotencyKey,
        descriptor: {id: directory.id, source: "gateway", connectorKey, mimeType: upload.mimeType, sizeBytes: upload.sizeBytes,
          localPath: directory.localPath, originalFilename: filename, createdAt: Date.now(),
          metadata: {schemaVersion: 1, gateway: {sourceId: source.sourceId, ...(device ? {deviceId: device.deviceId} : {}),
            sha256: upload.sha256, scanStatus: "not_scanned", trust: "external_untrusted"}}},
        sha256: upload.sha256, mimeType: upload.mimeType, sniffedMimeType: upload.sniffedMimeType, filename,
        expiresAt: Date.now() + input.attachmentUploadTtlMs};
      const stored = await input.store.completeAttachmentUpload(directory.id, completedInput);
      await cleanGatewayUploadDirectory({upload: directory, store: input.store}).catch(reportCleanupError);
      return {status: stored.inserted ? 201 : 200, body: serializeAttachmentResponse(stored.attachment)};
    } catch (error) {
      // The transaction may have committed despite a lost acknowledgement. Read the durable receipt;
      // cleanup separately proves revocation/absence under the same lock used by metadata acceptance.
      const receipt = completedInput
        ? await input.store.getAttachmentByIdempotencyKey(source.sourceId, headers.idempotencyKey).catch(() => null)
        : null;
      await cleanGatewayUploadDirectory({upload: directory, store: input.store}).catch(reportCleanupError);
      if (receipt && completedInput && sameIdempotentAttachmentUpload(receipt, completedInput)) {
        return {status: receipt.id === directory.id ? 201 : 200, body: serializeAttachmentResponse(receipt)};
      }
      throw error;
    }
  } finally {
    clearTimeout(timer);
    input.request.off("error", onRequestError);
  }
}

function reportCleanupError(error: unknown): void {
  console.error("Gateway upload cleanup deferred", {error: error instanceof Error ? error.message : String(error)});
}
