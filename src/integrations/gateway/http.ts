import {createServer, type Server} from "node:http";
import type {AddressInfo} from "node:net";

import {GatewayEventConflictError} from "../../domain/gateway/postgres.js";
import {writeJsonResponse} from "../../lib/http.js";
import {GatewayHttpError} from "./http-body.js";
import {
  DEFAULT_GATEWAY_ACCESS_TOKEN_TTL_MS,
  DEFAULT_GATEWAY_HOST,
  DEFAULT_GATEWAY_MAX_ACTIVE_TOKENS_PER_SOURCE,
  DEFAULT_GATEWAY_MAX_TEXT_BYTES,
  DEFAULT_GATEWAY_PORT,
  DEFAULT_GATEWAY_RATE_LIMIT_PER_MINUTE,
  DEFAULT_GATEWAY_TEXT_BYTES_PER_HOUR,
  type GatewayServerOptions,
} from "./http-config.js";
import {resolveGatewayNetworkControls} from "./network-controls.js";
import {issueGatewayAccessToken} from "./oauth-token.js";
import {acceptGatewayEventRequest} from "./event-acceptance.js";
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
        const accepted = await acceptGatewayEventRequest({
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
