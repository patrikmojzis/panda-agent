import {createServer, type Server} from "node:http";
import type {AddressInfo} from "node:net";

import {
  GatewayAttachmentConflictError,
  GatewayEventConflictError,
} from "../../domain/gateway/postgres.js";
import {writeJsonResponse} from "../../lib/http.js";
import {acceptGatewayAttachmentUploadRequest} from "./attachment-acceptance.js";
import {GatewayHttpError} from "./http-body.js";
import {
  DEFAULT_GATEWAY_ACCESS_TOKEN_TTL_MS,
  DEFAULT_GATEWAY_ATTACHMENT_ALLOWED_MIME_TYPES,
  DEFAULT_GATEWAY_ATTACHMENT_BYTES_PER_HOUR,
  DEFAULT_GATEWAY_ATTACHMENT_UPLOAD_TTL_MS,
  DEFAULT_GATEWAY_HOST,
  DEFAULT_GATEWAY_MAX_ACTIVE_TOKENS_PER_SOURCE,
  DEFAULT_GATEWAY_MAX_ATTACHMENT_BYTES,
  DEFAULT_GATEWAY_MAX_ATTACHMENTS_PER_EVENT,
  DEFAULT_GATEWAY_MAX_EVENT_ATTACHMENT_BYTES,
  DEFAULT_GATEWAY_MAX_PENDING_ATTACHMENTS_PER_SOURCE,
  DEFAULT_GATEWAY_MAX_TEXT_BYTES,
  DEFAULT_GATEWAY_PORT,
  DEFAULT_GATEWAY_RATE_LIMIT_PER_MINUTE,
  DEFAULT_GATEWAY_TEXT_BYTES_PER_HOUR,
  type GatewayServerOptions,
} from "./http-config.js";
import {resolveGatewayNetworkControls} from "./network-controls.js";
import {issueGatewayAccessToken} from "./oauth-token.js";
import {
  acceptGatewayEventRequest,
  acceptGatewayEventWithAttachmentsRequest,
} from "./event-acceptance.js";
import {admitGatewayHttpRequest} from "./request-admission.js";

export interface GatewayServer {
  readonly host: string;
  readonly port: number;
  readonly server: Server;
  close(): Promise<void>;
}

function formatHostForLog(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export async function startGatewayServer(options: GatewayServerOptions): Promise<GatewayServer> {
  const env = options.env ?? process.env;
  const host = options.host ?? DEFAULT_GATEWAY_HOST;
  const port = options.port ?? DEFAULT_GATEWAY_PORT;
  const tokenTtlMs = options.tokenTtlMs ?? DEFAULT_GATEWAY_ACCESS_TOKEN_TTL_MS;
  const maxActiveTokensPerSource = options.maxActiveTokensPerSource ?? DEFAULT_GATEWAY_MAX_ACTIVE_TOKENS_PER_SOURCE;
  const maxTextBytes = options.maxTextBytes ?? DEFAULT_GATEWAY_MAX_TEXT_BYTES;
  const maxJsonBytes = maxTextBytes + 8 * 1024;
  const rateLimitPerMinute = options.rateLimitPerMinute ?? DEFAULT_GATEWAY_RATE_LIMIT_PER_MINUTE;
  const textBytesPerHour = options.textBytesPerHour ?? DEFAULT_GATEWAY_TEXT_BYTES_PER_HOUR;
  const maxAttachmentBytes = options.maxAttachmentBytes ?? DEFAULT_GATEWAY_MAX_ATTACHMENT_BYTES;
  const maxAttachmentsPerEvent = options.maxAttachmentsPerEvent ?? DEFAULT_GATEWAY_MAX_ATTACHMENTS_PER_EVENT;
  const maxEventAttachmentBytes = options.maxEventAttachmentBytes ?? DEFAULT_GATEWAY_MAX_EVENT_ATTACHMENT_BYTES;
  const attachmentBytesPerHour = options.attachmentBytesPerHour ?? DEFAULT_GATEWAY_ATTACHMENT_BYTES_PER_HOUR;
  const maxPendingAttachmentsPerSource = options.maxPendingAttachmentsPerSource
    ?? DEFAULT_GATEWAY_MAX_PENDING_ATTACHMENTS_PER_SOURCE;
  const attachmentUploadTtlMs = options.attachmentUploadTtlMs ?? DEFAULT_GATEWAY_ATTACHMENT_UPLOAD_TTL_MS;
  const attachmentAllowedMimeTypes = options.attachmentAllowedMimeTypes ?? DEFAULT_GATEWAY_ATTACHMENT_ALLOWED_MIME_TYPES;
  const network = resolveGatewayNetworkControls({env, host});

  const server = createServer(async (request, response) => {
    try {
      await admitGatewayHttpRequest({
        network,
        rateLimitPerMinute,
        request,
        store: options.store,
      });

      const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "gateway.local"}`);
      if (request.method === "GET" && requestUrl.pathname === "/health") {
        writeJsonResponse(response, 200, {ok: true});
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/oauth/token") {
        writeJsonResponse(response, 200, await issueGatewayAccessToken({
          maxActiveTokensPerSource,
          request,
          response,
          store: options.store,
          tokenTtlMs,
        }));
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/v1/events") {
        const accessTokenOnlyStore = {
          getEventType: (sourceId: string, type: string) => options.store.getEventType(sourceId, type),
          recordStrikeAndMaybeSuspend: (input: {
            kind: "unexpected_type";
            metadata: {type: string};
            reason: string;
            sourceId: string;
            threshold: number;
            windowMs: number;
          }) => options.store.recordStrikeAndMaybeSuspend(input),
          resolveAccessToken: (token: string) => options.store.resolveAccessToken(token),
          resolveDeviceToken: async (_token: string) => null,
          touchDeviceSeen: async (_input: {sourceId: string; deviceId: string}) => {},
          storeEvent: (input: {
            deliveryEffective: "queue" | "wake";
            deliveryRequested: "queue" | "wake";
            idempotencyKey: string;
            occurredAt?: number;
            sourceId: string;
            text: string;
            textBytes: number;
            textSha256: string;
            type: string;
          }) => options.store.storeEvent(input),
          storeEventWithAttachments: (input: {
            attachments: readonly {id: string; sha256?: string}[];
            deliveryEffective: "queue" | "wake";
            deliveryRequested: "queue" | "wake";
            idempotencyKey: string;
            maxAttachmentBytes: number;
            occurredAt?: number;
            sourceId: string;
            text: string;
            textBytes: number;
            textSha256: string;
            type: string;
          }) => options.store.storeEventWithAttachments(input),
          useRateLimit: (input: {cost?: number; key: string; limit: number; windowMs: number}) => options.store.useRateLimit(input),
        };

        const accepted = await acceptGatewayEventRequest({
          maxJsonBytes,
          maxTextBytes,
          request,
          store: accessTokenOnlyStore,
          textBytesPerHour,
          worker: options.worker,
        });
        writeJsonResponse(response, accepted.status, accepted.body);
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/v2/attachments") {
        const accepted = await acceptGatewayAttachmentUploadRequest({
          allowedMimeTypes: attachmentAllowedMimeTypes,
          attachmentBytesPerHour,
          attachmentUploadTtlMs,
          env,
          maxBytes: maxAttachmentBytes,
          maxPendingAttachmentsPerSource,
          request,
          store: options.store,
        });
        writeJsonResponse(response, accepted.status, accepted.body);
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/v2/events") {
        const accepted = await acceptGatewayEventWithAttachmentsRequest({
          maxAttachmentsPerEvent,
          maxEventAttachmentBytes,
          maxJsonBytes,
          maxTextBytes,
          request,
          store: options.store,
          textBytesPerHour,
          worker: options.worker,
        });
        writeJsonResponse(response, accepted.status, accepted.body);
        return;
      }

      throw new GatewayHttpError(404, "Not found.");
    } catch (error) {
      if (error instanceof GatewayEventConflictError) {
        writeJsonResponse(response, 409, {
          ok: false,
          error: error.message,
          eventId: error.existing.id,
        });
        return;
      }
      if (error instanceof GatewayAttachmentConflictError) {
        writeJsonResponse(response, 409, {
          ok: false,
          error: error.message,
          attachmentId: error.existing.id,
        });
        return;
      }
      if (error instanceof GatewayHttpError) {
        writeJsonResponse(response, error.statusCode, {
          ok: false,
          error: error.message,
        });
        return;
      }
      console.error("Gateway request failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      writeJsonResponse(response, 500, {
        ok: false,
        error: "Internal server error.",
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  return {
    host,
    port: address && typeof address === "object" ? (address as AddressInfo).port : port,
    server,
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

export function formatGatewayListenUrl(server: Pick<GatewayServer, "host" | "port">): string {
  return `http://${formatHostForLog(server.host)}:${String(server.port)}`;
}
