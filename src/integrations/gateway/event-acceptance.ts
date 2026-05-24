import type {IncomingMessage} from "node:http";

import type {GatewayAttachmentRefInput, GatewayDeliveryMode} from "../../domain/gateway/types.js";
import {GatewayAttachmentReferenceError} from "../../domain/gateway/postgres.js";
import {GatewayHttpError} from "./http-body.js";
import {
  readGatewayBearerToken,
  readGatewayEventRequest,
  readGatewayEventWithAttachmentsRequest,
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
  resolveDeviceToken(token: string): Promise<{
    device: {
      capabilities: readonly string[];
      deviceId: string;
      sourceId: string;
    };
    source: {sourceId: string};
  } | null>;
  touchDeviceSeen(input: {sourceId: string; deviceId: string}): Promise<void>;
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
  storeEventWithAttachments(input: {
    attachments: readonly GatewayAttachmentRefInput[];
    deliveryEffective: GatewayDeliveryMode;
    deliveryRequested: GatewayDeliveryMode;
    idempotencyKey: string;
    maxAttachmentBytes: number;
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
  store: Pick<GatewayEventAcceptanceStore, "resolveAccessToken" | "resolveDeviceToken" | "touchDeviceSeen">;
}): Promise<{sourceId: string}> {
  const token = readGatewayBearerToken(input.request);
  const source = await input.store.resolveAccessToken(token);
  if (source) {
    return source;
  }

  const resolved = await input.store.resolveDeviceToken(token);
  if (!resolved) {
    throw new GatewayHttpError(401, "Invalid bearer token.");
  }

  if (!resolved.device.capabilities.includes("push_context")) {
    throw new GatewayHttpError(403, "Device token is missing the push_context capability.");
  }

  await input.store.touchDeviceSeen({sourceId: resolved.source.sourceId, deviceId: resolved.device.deviceId});
  return {sourceId: resolved.source.sourceId};
}

async function assertEventTypeAllowed(input: {
  eventType: string;
  sourceId: string;
  store: GatewayEventAcceptanceStore;
}): Promise<{delivery: GatewayDeliveryMode}> {
  const allowedType = await input.store.getEventType(input.sourceId, input.eventType);
  if (!allowedType) {
    await input.store.recordStrikeAndMaybeSuspend({
      sourceId: input.sourceId,
      kind: "unexpected_type",
      reason: "unexpected gateway event type",
      threshold: STRIKE_THRESHOLD,
      windowMs: STRIKE_WINDOW_MS,
      metadata: {type: input.eventType},
    });
    throw new GatewayHttpError(403, "Event type is not allowed.");
  }
  return allowedType;
}

async function enforceTextBudgets(input: {
  eventTextBytes: number;
  maxTextBytes: number;
  sourceId: string;
  store: Pick<GatewayEventAcceptanceStore, "useRateLimit">;
  textBytesPerHour: number;
}): Promise<void> {
  if (input.eventTextBytes > input.maxTextBytes) {
    throw new GatewayHttpError(413, "Event text is too large.");
  }
  const textBudget = await input.store.useRateLimit({
    key: `gateway:source:${input.sourceId}:text_bytes`,
    windowMs: 60 * 60_000,
    cost: input.eventTextBytes,
    limit: input.textBytesPerHour,
  });
  if (!textBudget.allowed) {
    throw new GatewayHttpError(429, "Text byte budget exceeded.");
  }
}

function acceptedBody(input: {
  delivery: GatewayDeliveryMode;
  eventId: string;
}): {
  accepted: true;
  delivery: GatewayDeliveryMode;
  eventId: string;
  ok: true;
} {
  return {
    ok: true,
    eventId: input.eventId,
    accepted: true,
    delivery: input.delivery,
  };
}

export async function acceptGatewayEventRequest(input: {
  maxJsonBytes: number;
  maxTextBytes: number;
  request: IncomingMessage;
  store: GatewayEventAcceptanceStore;
  textBytesPerHour: number;
  worker?: Pick<GatewayWorker, "poke">;
}): Promise<{
  body: ReturnType<typeof acceptedBody>;
  status: 200 | 202;
}> {
  const source = await requireGatewaySource({
    request: input.request,
    store: input.store,
  });
  const event = await readGatewayEventRequest(input.request, input.maxJsonBytes);
  const allowedType = await assertEventTypeAllowed({
    eventType: event.type,
    sourceId: source.sourceId,
    store: input.store,
  });
  await enforceTextBudgets({
    eventTextBytes: event.textBytes,
    maxTextBytes: input.maxTextBytes,
    sourceId: source.sourceId,
    store: input.store,
    textBytesPerHour: input.textBytesPerHour,
  });

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
    body: acceptedBody({eventId: stored.event.id, delivery: stored.event.deliveryEffective}),
  };
}

export async function acceptGatewayEventWithAttachmentsRequest(input: {
  maxAttachmentsPerEvent: number;
  maxEventAttachmentBytes: number;
  maxJsonBytes: number;
  maxTextBytes: number;
  request: IncomingMessage;
  store: GatewayEventAcceptanceStore;
  textBytesPerHour: number;
  worker?: Pick<GatewayWorker, "poke">;
}): Promise<{
  body: ReturnType<typeof acceptedBody>;
  status: 200 | 202;
}> {
  const source = await requireGatewaySource({
    request: input.request,
    store: input.store,
  });
  const event = await readGatewayEventWithAttachmentsRequest(
    input.request,
    input.maxJsonBytes,
    input.maxAttachmentsPerEvent,
  );
  const allowedType = await assertEventTypeAllowed({
    eventType: event.type,
    sourceId: source.sourceId,
    store: input.store,
  });
  await enforceTextBudgets({
    eventTextBytes: event.textBytes,
    maxTextBytes: input.maxTextBytes,
    sourceId: source.sourceId,
    store: input.store,
    textBytesPerHour: input.textBytesPerHour,
  });

  const deliveryEffective = resolveGatewayEffectiveDelivery({
    allowedDelivery: allowedType.delivery,
    requestedDelivery: event.delivery,
  });
  try {
    const stored = await input.store.storeEventWithAttachments({
      sourceId: source.sourceId,
      type: event.type,
      deliveryRequested: event.delivery,
      deliveryEffective,
      occurredAt: event.occurredAt,
      idempotencyKey: event.idempotencyKey,
      text: event.text,
      textBytes: event.textBytes,
      textSha256: event.textSha256,
      attachments: event.attachments ?? [],
      maxAttachmentBytes: input.maxEventAttachmentBytes,
    });
    if (stored.inserted) {
      input.worker?.poke();
    }
    return {
      status: stored.inserted ? 202 : 200,
      body: acceptedBody({eventId: stored.event.id, delivery: stored.event.deliveryEffective}),
    };
  } catch (error) {
    if (error instanceof GatewayAttachmentReferenceError) {
      throw new GatewayHttpError(error.statusCode, error.message);
    }
    throw error;
  }
}
