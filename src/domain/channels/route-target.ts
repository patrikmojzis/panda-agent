import {isJsonObject, type JsonValue} from "../../lib/json.js";
import {isRecord} from "../../lib/records.js";
import {trimToUndefined} from "../../lib/strings.js";
import type {ChannelTypingTarget, DeliveryContext} from "./types.js";

interface RouteTargetCarrier {
  source?: unknown;
  metadata?: JsonValue;
}

export interface ResolvedChannelRouteTarget {
  channel: string;
  target: ChannelTypingTarget;
}


function readDeliveryContext(metadata: Record<string, unknown>, route: Record<string, unknown>): DeliveryContext | undefined {
  if (isJsonObject(metadata.deliveryContext)) {
    return metadata.deliveryContext;
  }

  return isJsonObject(route.deliveryContext) ? route.deliveryContext : undefined;
}

export function resolveChannelRouteTarget(
  value: RouteTargetCarrier | undefined,
): ResolvedChannelRouteTarget | null {
  if (!value) {
    return null;
  }

  const metadata = value.metadata;
  if (!isRecord(metadata)) {
    return null;
  }

  const route = metadata.route;
  if (!isRecord(route)) {
    return null;
  }

  const channel = trimToUndefined(value.source) ?? trimToUndefined(route.source);
  const connectorKey = trimToUndefined(route.connectorKey);
  const externalConversationId = trimToUndefined(route.externalConversationId);
  if (!channel || !connectorKey || !externalConversationId) {
    return null;
  }

  const deliveryContext = readDeliveryContext(metadata, route);

  return {
    channel,
    target: {
      source: channel,
      connectorKey,
      externalConversationId,
      externalActorId: trimToUndefined(route.externalActorId),
      ...(deliveryContext !== undefined ? {deliveryContext} : {}),
    },
  };
}
