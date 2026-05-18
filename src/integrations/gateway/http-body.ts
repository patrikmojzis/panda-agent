import type {IncomingMessage} from "node:http";

import {isRecord} from "../../lib/records.js";
import {trimToNull} from "../../lib/strings.js";
import {parseJsonHttpBody, readJsonHttpBody, readLimitedHttpBody} from "../http-body.js";

export class GatewayHttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "GatewayHttpError";
  }
}

export async function readGatewayRawBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return readLimitedHttpBody(request, {
    createError: createGatewayBodyError,
    maxBytes,
    tooLargeMessage: "Request body is too large.",
  });
}

export async function readGatewayJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  return readJsonHttpBody(request, {
    createError: createGatewayBodyError,
    invalidJsonPrefix: "Request body must be valid JSON",
    maxBytes,
    tooLargeMessage: "Request body is too large.",
  });
}

export async function readGatewayTokenRequest(request: IncomingMessage): Promise<{
  clientId: string;
  clientSecret: string;
}> {
  const contentType = requireGatewayContentType(request, [
    "application/json",
    "application/x-www-form-urlencoded",
  ]);
  const rawBody = await readGatewayRawBody(request, 16 * 1024);
  const body = contentType === "application/json"
    ? parseJsonHttpBody(rawBody, {
      createError: createGatewayBodyError,
      invalidJsonPrefix: "Token request body is invalid",
    })
    : Object.fromEntries(new URLSearchParams(rawBody.toString("utf8").trim()));
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

function createGatewayBodyError(statusCode: number, message: string): GatewayHttpError {
  return new GatewayHttpError(statusCode, message);
}

function readGatewayHeaderValue(value: string | string[] | undefined): string | null {
  return trimToNull(Array.isArray(value) ? value[0] : value);
}

function readGatewayContentType(request: IncomingMessage): string | null {
  const raw = readGatewayHeaderValue(request.headers["content-type"]);
  return raw?.split(";", 1)[0]?.trim().toLowerCase() ?? null;
}

export function requireGatewayContentType(
  request: IncomingMessage,
  allowed: readonly string[],
): string {
  const contentType = readGatewayContentType(request);
  if (contentType && allowed.includes(contentType)) {
    return contentType;
  }

  throw new GatewayHttpError(415, `Unsupported Content-Type. Expected ${allowed.join(" or ")}.`);
}
