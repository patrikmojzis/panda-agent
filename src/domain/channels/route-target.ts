import type {JsonValue} from "../../kernel/agent/types.js";
import type {ChannelTypingTarget} from "./types.js";

interface RouteTargetCarrier {
  source?: unknown;
  metadata?: JsonValue;
}

export interface ResolvedChannelRouteTarget {
  channel: string;
  target: ChannelTypingTarget;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
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

  const channel = readTrimmedString(value.source) ?? readTrimmedString(route.source);
  const connectorKey = readTrimmedString(route.connectorKey);
  const externalConversationId = readTrimmedString(route.externalConversationId);
  if (!channel || !connectorKey || !externalConversationId) {
    return null;
  }

  return {
    channel,
    target: {
      source: channel,
      connectorKey,
      externalConversationId,
      externalActorId: readTrimmedString(route.externalActorId),
    },
  };
}
