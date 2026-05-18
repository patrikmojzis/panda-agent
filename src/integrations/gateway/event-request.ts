import {createHash} from "node:crypto";
import type {IncomingMessage} from "node:http";

import {z} from "zod";

import {normalizeGatewayEventType} from "../../domain/gateway/postgres-rows.js";
import type {GatewayDeliveryMode} from "../../domain/gateway/types.js";
import {trimToNull} from "../../lib/strings.js";
import {GatewayHttpError, readGatewayJsonBody, requireGatewayContentType} from "./http-body.js";

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

const eventSchema = z.object({
  type: z.string().trim().min(1).max(120),
  delivery: z.enum(["queue", "wake"]),
  occurredAt: z.string().trim().datetime({offset: true}).optional(),
  text: z.string().min(1),
});

export interface GatewayEventRequest {
  idempotencyKey: string;
  type: string;
  delivery: GatewayDeliveryMode;
  occurredAt?: number;
  text: string;
  textBytes: number;
  textSha256: string;
}

export function readGatewayBearerToken(request: IncomingMessage): string {
  const header = trimToNull(request.headers.authorization ?? null);
  if (!header) {
    throw new GatewayHttpError(401, "Missing bearer token.");
  }
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const token = match?.[1]?.trim();
  if (!token) {
    throw new GatewayHttpError(401, "Missing bearer token.");
  }
  return token;
}

function readGatewayIdempotencyKey(request: IncomingMessage): string {
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

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function textByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function parseGatewayEventBody(value: unknown): z.output<typeof eventSchema> {
  try {
    return eventSchema.parse(value);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new GatewayHttpError(400, "Invalid event body.");
    }
    throw error;
  }
}

export async function readGatewayEventRequest(
  request: IncomingMessage,
  maxJsonBytes: number,
): Promise<GatewayEventRequest> {
  const idempotencyKey = readGatewayIdempotencyKey(request);
  requireGatewayContentType(request, ["application/json"]);
  const body = parseGatewayEventBody(await readGatewayJsonBody(request, maxJsonBytes));
  let type: string;
  try {
    type = normalizeGatewayEventType(body.type);
  } catch (error) {
    throw new GatewayHttpError(400, error instanceof Error ? error.message : "Invalid event type.");
  }

  return {
    idempotencyKey,
    type,
    delivery: body.delivery,
    ...(body.occurredAt ? {occurredAt: Date.parse(body.occurredAt)} : {}),
    text: body.text,
    textBytes: textByteLength(body.text),
    textSha256: sha256Hex(body.text),
  };
}

export function resolveGatewayEffectiveDelivery(input: {
  allowedDelivery: GatewayDeliveryMode;
  requestedDelivery: GatewayDeliveryMode;
}): GatewayDeliveryMode {
  return input.allowedDelivery === "queue" ? "queue" : input.requestedDelivery;
}
