import type {JsonValue} from "../../kernel/agent/types.js";
import {isRecord} from "../../lib/records.js";
import {trimToUndefined} from "../../lib/strings.js";
import type {ChannelTypingTarget} from "./types.js";

interface RouteTargetCarrier {
  source?: unknown;
  metadata?: JsonValue;
}

export interface ResolvedChannelRouteTarget {
  channel: string;
  target: ChannelTypingTarget;
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

  return {
    channel,
    target: {
      source: channel,
      connectorKey,
      externalConversationId,
      externalActorId: trimToUndefined(route.externalActorId),
    },
  };
}
