import type {IncomingMessage} from "node:http";

import type {GatewayDeliveryMode} from "../../domain/gateway/types.js";
import {GatewayHttpError} from "./http-body.js";
import {
  readGatewayBearerToken,
  readGatewayEventRequest,
  resolveGatewayEffectiveDelivery,
} from "./event-request.js";
import type {GatewayWorker} from "./worker.js";

const STRIKE_WINDOW_MS = 10 * 60_000;
const STRIKE_THRESHOLD = 3;

interface GatewayEventAcceptanceStore {
  getEventType(sourceId: string, type: string): Promise<{delivery: GatewayDeliveryMode} | null>;
  recordStrikeAndMaybeSuspend(input: {
    kind: "unexpected_type";
    metadata: {type: string};
    reason: string;
    sourceId: string;
    threshold: number;
    windowMs: number;
  }): Promise<unknown>;
  resolveAccessToken(token: string): Promise<{sourceId: string} | null>;
  storeEvent(input: {
    deliveryEffective: GatewayDeliveryMode;
    deliveryRequested: GatewayDeliveryMode;
    idempotencyKey: string;
    occurredAt?: number;
    sourceId: string;
    text: string;
    textBytes: number;
    textSha256: string;
    type: string;
  }): Promise<{
    event: {
      deliveryEffective: GatewayDeliveryMode;
      id: string;
    };
    inserted: boolean;
  }>;
  useRateLimit(input: {
    cost?: number;
    key: string;
    limit: number;
    windowMs: number;
  }): Promise<{allowed: boolean}>;
}

async function requireGatewaySource(input: {
  request: IncomingMessage;
  store: Pick<GatewayEventAcceptanceStore, "resolveAccessToken">;
}): Promise<{sourceId: string}> {
  const token = readGatewayBearerToken(input.request);
  const source = await input.store.resolveAccessToken(token);
  if (!source) {
    throw new GatewayHttpError(401, "Invalid bearer token.");
  }
  return source;
}

export async function acceptGatewayEventRequest(input: {
  maxJsonBytes: number;
  maxTextBytes: number;
  request: IncomingMessage;
  store: GatewayEventAcceptanceStore;
  textBytesPerHour: number;
  worker?: Pick<GatewayWorker, "poke">;
}): Promise<{
  body: {
    accepted: true;
    delivery: GatewayDeliveryMode;
    eventId: string;
    ok: true;
  };
  status: 200 | 202;
}> {
  const source = await requireGatewaySource({
    request: input.request,
    store: input.store,
  });
  const event = await readGatewayEventRequest(input.request, input.maxJsonBytes);
  const allowedType = await input.store.getEventType(source.sourceId, event.type);
  if (!allowedType) {
    await input.store.recordStrikeAndMaybeSuspend({
      sourceId: source.sourceId,
      kind: "unexpected_type",
      reason: "unexpected gateway event type",
      threshold: STRIKE_THRESHOLD,
      windowMs: STRIKE_WINDOW_MS,
      metadata: {type: event.type},
    });
    throw new GatewayHttpError(403, "Event type is not allowed.");
  }

  if (event.textBytes > input.maxTextBytes) {
    throw new GatewayHttpError(413, "Event text is too large.");
  }
  const textBudget = await input.store.useRateLimit({
    key: `gateway:source:${source.sourceId}:text_bytes`,
    windowMs: 60 * 60_000,
    cost: event.textBytes,
    limit: input.textBytesPerHour,
  });
  if (!textBudget.allowed) {
    throw new GatewayHttpError(429, "Text byte budget exceeded.");
  }

  const deliveryEffective = resolveGatewayEffectiveDelivery({
    allowedDelivery: allowedType.delivery,
    requestedDelivery: event.delivery,
  });
  const stored = await input.store.storeEvent({
    sourceId: source.sourceId,
    type: event.type,
    deliveryRequested: event.delivery,
    deliveryEffective,
    occurredAt: event.occurredAt,
    idempotencyKey: event.idempotencyKey,
    text: event.text,
    textBytes: event.textBytes,
    textSha256: event.textSha256,
  });
  if (stored.inserted) {
    input.worker?.poke();
  }

  return {
    status: stored.inserted ? 202 : 200,
    body: {
      ok: true,
      eventId: stored.event.id,
      accepted: true,
      delivery: stored.event.deliveryEffective,
    },
  };
}
