import {createHash} from "node:crypto";
import type {IncomingMessage} from "node:http";

import {z} from "zod";

import {normalizeGatewayEventType} from "../../domain/gateway/postgres-rows.js";
import type {GatewayAttachmentRefInput, GatewayDeliveryMode} from "../../domain/gateway/types.js";
import {isRecord} from "../../lib/records.js";
import {trimToNull} from "../../lib/strings.js";
import {GatewayHttpError, readGatewayJsonBody, requireGatewayContentType} from "./http-body.js";

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const SHA256_PATTERN = /^[a-fA-F0-9]{64}$/;

const eventSchema = z.object({
  type: z.string().trim().min(1).max(120),
  delivery: z.enum(["queue", "wake"]),
  occurredAt: z.string().trim().datetime({offset: true}).optional(),
  text: z.string().min(1),
});

const eventWithAttachmentsSchema = eventSchema.extend({
  attachments: z.array(z.object({
    id: z.string().trim().uuid(),
    sha256: z.string().trim().regex(SHA256_PATTERN).optional(),
  })).optional(),
});

export interface GatewayEventRequest {
  idempotencyKey: string;
  type: string;
  delivery: GatewayDeliveryMode;
  occurredAt?: number;
  text: string;
  textBytes: number;
  textSha256: string;
  attachments?: readonly GatewayAttachmentRefInput[];
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

export function readGatewayIdempotencyKey(request: IncomingMessage): string {
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

function normalizeParsedEvent(input: {
  delivery: GatewayDeliveryMode;
  idempotencyKey: string;
  occurredAt?: string;
  text: string;
  type: string;
  attachments?: readonly GatewayAttachmentRefInput[];
}): GatewayEventRequest {
  let type: string;
  try {
    type = normalizeGatewayEventType(input.type);
  } catch (error) {
    throw new GatewayHttpError(400, error instanceof Error ? error.message : "Invalid event type.");
  }

  return {
    idempotencyKey: input.idempotencyKey,
    type,
    delivery: input.delivery,
    ...(input.occurredAt ? {occurredAt: Date.parse(input.occurredAt)} : {}),
    text: input.text,
    textBytes: textByteLength(input.text),
    textSha256: sha256Hex(input.text),
    ...(input.attachments ? {attachments: input.attachments} : {}),
  };
}

function parseGatewayEventBody(value: unknown): z.output<typeof eventSchema> {
  if (isRecord(value) && Object.hasOwn(value, "attachments")) {
    throw new GatewayHttpError(400, "Attachments require /v2/events.");
  }
  try {
    return eventSchema.parse(value);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new GatewayHttpError(400, "Invalid event body.");
    }
    throw error;
  }
}

function parseGatewayEventWithAttachmentsBody(
  value: unknown,
  maxAttachments: number,
): z.output<typeof eventWithAttachmentsSchema> {
  let parsed: z.output<typeof eventWithAttachmentsSchema>;
  try {
    parsed = eventWithAttachmentsSchema.parse(value);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new GatewayHttpError(400, "Invalid event body.");
    }
    throw error;
  }
  const attachments = parsed.attachments;
  if (attachments !== undefined && attachments.length === 0) {
    throw new GatewayHttpError(400, "attachments must contain at least one ref when present.");
  }
  if (attachments && attachments.length > maxAttachments) {
    throw new GatewayHttpError(400, `attachments must contain at most ${String(maxAttachments)} refs.`);
  }
  return parsed;
}

export async function readGatewayEventRequest(
  request: IncomingMessage,
  maxJsonBytes: number,
): Promise<GatewayEventRequest> {
  const idempotencyKey = readGatewayIdempotencyKey(request);
  requireGatewayContentType(request, ["application/json"]);
  const body = parseGatewayEventBody(await readGatewayJsonBody(request, maxJsonBytes));
  return normalizeParsedEvent({
    idempotencyKey,
    type: body.type,
    delivery: body.delivery,
    occurredAt: body.occurredAt,
    text: body.text,
  });
}

export async function readGatewayEventWithAttachmentsRequest(
  request: IncomingMessage,
  maxJsonBytes: number,
  maxAttachments: number,
): Promise<GatewayEventRequest> {
  const idempotencyKey = readGatewayIdempotencyKey(request);
  requireGatewayContentType(request, ["application/json"]);
  const body = parseGatewayEventWithAttachmentsBody(
    await readGatewayJsonBody(request, maxJsonBytes),
    maxAttachments,
  );
  return normalizeParsedEvent({
    idempotencyKey,
    type: body.type,
    delivery: body.delivery,
    occurredAt: body.occurredAt,
    text: body.text,
    attachments: body.attachments?.map((attachment) => ({
      id: attachment.id,
      ...(attachment.sha256 ? {sha256: attachment.sha256.toLowerCase()} : {}),
    })),
  });
}

export function resolveGatewayEffectiveDelivery(input: {
  allowedDelivery: GatewayDeliveryMode;
  requestedDelivery: GatewayDeliveryMode;
}): GatewayDeliveryMode {
  return input.allowedDelivery === "queue" ? "queue" : input.requestedDelivery;
}
