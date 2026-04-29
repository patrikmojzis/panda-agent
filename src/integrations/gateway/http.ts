import {createHash} from "node:crypto";
import {createServer, type IncomingMessage, type Server} from "node:http";
import type {AddressInfo} from "node:net";

import ipaddr from "ipaddr.js";
import {z} from "zod";

import {
  GatewayEventConflictError,
  type GatewayDeliveryMode,
  type GatewaySourceRecord,
  normalizeGatewayEventType,
  type PostgresGatewayStore,
} from "../../domain/gateway/index.js";
import {writeJsonResponse} from "../../lib/http.js";
import {isRecord} from "../../lib/records.js";
import {trimToNull} from "../../lib/strings.js";
import type {GatewayWorker} from "./worker.js";

const DEFAULT_GATEWAY_HOST = "127.0.0.1";
const DEFAULT_GATEWAY_PORT = 8094;
const DEFAULT_ACCESS_TOKEN_TTL_MS = 15 * 60_000;
const DEFAULT_MAX_ACTIVE_TOKENS_PER_SOURCE = 20;
const DEFAULT_MAX_TEXT_BYTES = 64 * 1024;
const DEFAULT_RATE_LIMIT_PER_MINUTE = 120;
const DEFAULT_TEXT_BYTES_PER_HOUR = 5 * 1024 * 1024;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const STRIKE_WINDOW_MS = 10 * 60_000;
const STRIKE_THRESHOLD = 3;

const eventSchema = z.object({
  type: z.string().trim().min(1).max(120),
  delivery: z.enum(["queue", "wake"]),
  occurredAt: z.string().trim().datetime({offset: true}).optional(),
  text: z.string().min(1),
});

export interface GatewayServerOptions {
  env?: NodeJS.ProcessEnv;
  host?: string;
  maxActiveTokensPerSource?: number;
  maxTextBytes?: number;
  port?: number;
  rateLimitPerMinute?: number;
  store: PostgresGatewayStore;
  textBytesPerHour?: number;
  tokenTtlMs?: number;
  worker?: GatewayWorker;
}

export interface GatewayServer {
  readonly host: string;
  readonly port: number;
  readonly server: Server;
  close(): Promise<void>;
}

class GatewayHttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "GatewayHttpError";
  }
}

function readPositiveInteger(value: string | null, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Expected positive integer, got ${value}.`);
  }
  return parsed;
}

function parsePort(value: string | null, fallback: number): number {
  const parsed = readPositiveInteger(value, fallback);
  if (parsed > 65_535) {
    throw new Error(`Invalid gateway port: ${String(parsed)}.`);
  }
  return parsed;
}

function normalizeRemoteAddress(value: string | undefined): string {
  if (!value) {
    return "unknown";
  }
  if (value.startsWith("::ffff:")) {
    return value.slice("::ffff:".length);
  }
  return value;
}

function parseIpAllowlist(raw: string | null): readonly string[] {
  return raw ? raw.split(",").map((entry) => entry.trim()).filter(Boolean) : [];
}

function isLoopbackBindHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[(.*)]$/, "$1");
  if (normalized === "localhost") {
    return true;
  }
  try {
    return ipaddr.process(normalized).range() === "loopback";
  } catch {
    return false;
  }
}

function allowPublicWithoutIpAllowlist(env: NodeJS.ProcessEnv): boolean {
  return trimToNull(env.GATEWAY_ALLOW_PUBLIC_WITHOUT_IP_ALLOWLIST)?.toLowerCase() === "true";
}

function isAddressInList(address: string, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0 || address === "unknown") {
    return false;
  }
  let parsedAddress: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsedAddress = ipaddr.process(address);
  } catch {
    return false;
  }
  return allowlist.some((entry) => {
    try {
      if (entry.includes("/")) {
        return parsedAddress.match(ipaddr.parseCIDR(entry));
      }
      return parsedAddress.toString() === ipaddr.process(entry).toString();
    } catch {
      return false;
    }
  });
}

function isAllowedIp(address: string, allowlist: readonly string[]): boolean {
  return allowlist.length === 0 || isAddressInList(address, allowlist);
}

function parseForwardedFor(value: string | string[] | undefined, trustedProxies: readonly string[]): string | null {
  const raw = Array.isArray(value) ? value.join(",") : value;
  if (!raw) {
    return null;
  }
  const addresses = raw.split(",").flatMap((candidate) => {
    const trimmed = normalizeRemoteAddress(candidate.trim());
    try {
      return [ipaddr.process(trimmed).toString()];
    } catch {
      return [];
    }
  });
  for (let index = addresses.length - 1; index >= 0; index -= 1) {
    const address = addresses[index];
    if (!address) {
      continue;
    }
    if (!isAddressInList(address, trustedProxies)) {
      return address;
    }
  }
  return addresses[0] ?? null;
}

function resolveClientAddress(request: IncomingMessage, trustedProxies: readonly string[]): string {
  const remoteAddress = normalizeRemoteAddress(request.socket.remoteAddress);
  if (!isAddressInList(remoteAddress, trustedProxies)) {
    return remoteAddress;
  }
  return parseForwardedFor(request.headers["x-forwarded-for"], trustedProxies) ?? remoteAddress;
}

function readBearerToken(request: IncomingMessage): string | null {
  const header = trimToNull(request.headers.authorization ?? null);
  if (!header) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() || null;
}

function readIdempotencyKey(request: IncomingMessage): string {
  const header = trimToNull(request.headers["idempotency-key"] ?? null);
  if (!header) {
    throw new GatewayHttpError(400, "Missing Idempotency-Key header.");
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(header)) {
    throw new GatewayHttpError(
      400,
      "Idempotency-Key must be 1-128 characters using letters, numbers, dots, colons, underscores, or hyphens.",
    );
  }
  return header;
}

async function readRawBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declaredLength = request.headers["content-length"];
  const contentLength = Array.isArray(declaredLength) ? declaredLength[0] : declaredLength;
  if (contentLength) {
    const parsed = Number(contentLength);
    if (Number.isFinite(parsed) && parsed > maxBytes) {
      throw new GatewayHttpError(413, "Request body is too large.");
    }
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) {
      throw new GatewayHttpError(413, "Request body is too large.");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const raw = (await readRawBody(request, maxBytes)).toString("utf8").trim();
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new GatewayHttpError(400, `Request body must be valid JSON: ${message}`);
  }
}

async function readTokenRequest(request: IncomingMessage): Promise<{clientId: string; clientSecret: string}> {
  const contentType = trimToNull(request.headers["content-type"] ?? null) ?? "";
  const raw = (await readRawBody(request, 16 * 1024)).toString("utf8").trim();
  let body: unknown;
  try {
    body = contentType.includes("application/json")
      ? (raw ? JSON.parse(raw) as unknown : {})
      : Object.fromEntries(new URLSearchParams(raw));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new GatewayHttpError(400, `Token request body is invalid: ${message}`);
  }
  if (!isRecord(body)) {
    throw new GatewayHttpError(400, "Token request body must be an object.");
  }
  const grantType = trimToNull(body.grant_type);
  if (grantType !== "client_credentials") {
    throw new GatewayHttpError(400, "Unsupported grant_type.");
  }
  const clientId = trimToNull(body.client_id);
  const clientSecret = trimToNull(body.client_secret);
  if (!clientId || !clientSecret) {
    throw new GatewayHttpError(400, "Missing client_id or client_secret.");
  }
  return {clientId, clientSecret};
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function textByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function resolveEffectiveDelivery(input: {
  allowedDelivery: GatewayDeliveryMode;
  requestedDelivery: GatewayDeliveryMode;
}): GatewayDeliveryMode {
  if (input.allowedDelivery === "queue") {
    return "queue";
  }
  return input.requestedDelivery;
}

function formatHostForLog(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export function resolveGatewayServerOptions(
  store: PostgresGatewayStore,
  worker: GatewayWorker | undefined,
  env: NodeJS.ProcessEnv = process.env,
): GatewayServerOptions {
  return {
    env,
    host: trimToNull(env.GATEWAY_HOST) ?? DEFAULT_GATEWAY_HOST,
    port: parsePort(trimToNull(env.GATEWAY_PORT), DEFAULT_GATEWAY_PORT),
    tokenTtlMs: readPositiveInteger(trimToNull(env.GATEWAY_ACCESS_TOKEN_TTL_MS), DEFAULT_ACCESS_TOKEN_TTL_MS),
    maxActiveTokensPerSource: readPositiveInteger(
      trimToNull(env.GATEWAY_MAX_ACTIVE_TOKENS_PER_SOURCE),
      DEFAULT_MAX_ACTIVE_TOKENS_PER_SOURCE,
    ),
    maxTextBytes: readPositiveInteger(trimToNull(env.GATEWAY_MAX_TEXT_BYTES), DEFAULT_MAX_TEXT_BYTES),
    rateLimitPerMinute: readPositiveInteger(
      trimToNull(env.GATEWAY_RATE_LIMIT_PER_MINUTE),
      DEFAULT_RATE_LIMIT_PER_MINUTE,
    ),
    textBytesPerHour: readPositiveInteger(
      trimToNull(env.GATEWAY_TEXT_BYTES_PER_HOUR),
      DEFAULT_TEXT_BYTES_PER_HOUR,
    ),
    store,
    ...(worker ? {worker} : {}),
  };
}

export async function startGatewayServer(options: GatewayServerOptions): Promise<GatewayServer> {
  const env = options.env ?? process.env;
  const host = options.host ?? DEFAULT_GATEWAY_HOST;
  const port = options.port ?? DEFAULT_GATEWAY_PORT;
  const tokenTtlMs = options.tokenTtlMs ?? DEFAULT_ACCESS_TOKEN_TTL_MS;
  const maxActiveTokensPerSource = options.maxActiveTokensPerSource ?? DEFAULT_MAX_ACTIVE_TOKENS_PER_SOURCE;
  const maxTextBytes = options.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES;
  const maxJsonBytes = maxTextBytes + 8 * 1024;
  const rateLimitPerMinute = options.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE;
  const textBytesPerHour = options.textBytesPerHour ?? DEFAULT_TEXT_BYTES_PER_HOUR;
  const allowlist = parseIpAllowlist(trimToNull(env.GATEWAY_IP_ALLOWLIST));
  const trustedProxies = parseIpAllowlist(trimToNull(env.GATEWAY_TRUSTED_PROXY_IPS));
  if (!isLoopbackBindHost(host) && allowlist.length === 0 && !allowPublicWithoutIpAllowlist(env)) {
    throw new Error("GATEWAY_IP_ALLOWLIST is required when binding Panda Gateway to a public host.");
  }

  async function requireSource(request: IncomingMessage): Promise<GatewaySourceRecord> {
    const token = readBearerToken(request);
    if (!token) {
      throw new GatewayHttpError(401, "Missing bearer token.");
    }
    const source = await options.store.resolveAccessToken(token);
    if (!source) {
      throw new GatewayHttpError(401, "Invalid bearer token.");
    }
    return source;
  }

  const server = createServer(async (request, response) => {
    try {
      const clientAddress = resolveClientAddress(request, trustedProxies);
      if (!isAllowedIp(clientAddress, allowlist)) {
        throw new GatewayHttpError(403, "Forbidden.");
      }
      const requestBudget = await options.store.useRateLimit({
        key: `gateway:ip:${clientAddress}:requests`,
        windowMs: 60_000,
        limit: rateLimitPerMinute,
      });
      if (!requestBudget.allowed) {
        throw new GatewayHttpError(429, "Rate limit exceeded.");
      }

      const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "gateway.local"}`);
      if (request.method === "GET" && requestUrl.pathname === "/health") {
        writeJsonResponse(response, 200, {ok: true});
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/oauth/token") {
        const tokenRequest = await readTokenRequest(request);
        const source = await options.store.verifyClientCredentials(tokenRequest);
        if (!source) {
          throw new GatewayHttpError(401, "Invalid client credentials.");
        }
        const access = await options.store.createAccessToken({
          sourceId: source.sourceId,
          expiresInMs: tokenTtlMs,
          maxActiveTokens: maxActiveTokensPerSource,
        });
        writeJsonResponse(response, 200, {
          access_token: access.token,
          token_type: "Bearer",
          expires_in: Math.floor((access.expiresAt - Date.now()) / 1000),
        });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/v1/events") {
        const source = await requireSource(request);
        const idempotencyKey = readIdempotencyKey(request);

        const body = eventSchema.parse(await readJsonBody(request, maxJsonBytes));
        let eventType: string;
        try {
          eventType = normalizeGatewayEventType(body.type);
        } catch (error) {
          throw new GatewayHttpError(400, error instanceof Error ? error.message : "Invalid event type.");
        }
        const allowedType = await options.store.getEventType(source.sourceId, eventType);
        if (!allowedType) {
          await options.store.recordStrikeAndMaybeSuspend({
            sourceId: source.sourceId,
            kind: "unexpected_type",
            reason: "unexpected gateway event type",
            threshold: STRIKE_THRESHOLD,
            windowMs: STRIKE_WINDOW_MS,
            metadata: {type: eventType},
          });
          throw new GatewayHttpError(403, "Event type is not allowed.");
        }

        const bytes = textByteLength(body.text);
        if (bytes > maxTextBytes) {
          throw new GatewayHttpError(413, "Event text is too large.");
        }
        const textBudget = await options.store.useRateLimit({
          key: `gateway:source:${source.sourceId}:text_bytes`,
          windowMs: 60 * 60_000,
          cost: bytes,
          limit: textBytesPerHour,
        });
        if (!textBudget.allowed) {
          throw new GatewayHttpError(429, "Text byte budget exceeded.");
        }

        const deliveryEffective = resolveEffectiveDelivery({
          allowedDelivery: allowedType.delivery,
          requestedDelivery: body.delivery,
        });
        const stored = await options.store.storeEvent({
          sourceId: source.sourceId,
          type: eventType,
          deliveryRequested: body.delivery,
          deliveryEffective,
          occurredAt: body.occurredAt ? Date.parse(body.occurredAt) : undefined,
          idempotencyKey,
          text: body.text,
          textBytes: bytes,
          textSha256: sha256Hex(body.text),
        });
        if (stored.inserted) {
          options.worker?.poke();
        }
        writeJsonResponse(response, stored.inserted ? 202 : 200, {
          ok: true,
          eventId: stored.event.id,
          accepted: true,
          delivery: stored.event.deliveryEffective,
        });
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
      if (error instanceof z.ZodError) {
        writeJsonResponse(response, 400, {
          ok: false,
          error: "Invalid event body.",
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
