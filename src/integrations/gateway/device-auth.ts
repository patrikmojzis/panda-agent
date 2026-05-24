import type {IncomingMessage} from "node:http";

import {gatewayDeviceAllowedCommandKinds} from "../../domain/gateway/postgres-rows.js";
import type {
  GatewayDeviceCapability,
  GatewayDeviceCommandKind,
  GatewayDeviceRecord,
  GatewaySourceRecord,
} from "../../domain/gateway/types.js";
import {GatewayHttpError} from "./http-body.js";
import {readGatewayBearerToken} from "./event-request.js";

interface GatewayDeviceAuthStore {
  resolveDeviceToken(token: string): Promise<{
    device: GatewayDeviceRecord;
    source: GatewaySourceRecord;
  } | null>;
  touchDeviceSeen(input: {sourceId: string; deviceId: string}): Promise<void>;
}

export async function requireGatewayDevicePrincipal(input: {
  request: IncomingMessage;
  store: GatewayDeviceAuthStore;
}): Promise<{source: GatewaySourceRecord; device: GatewayDeviceRecord}> {
  const token = readGatewayBearerToken(input.request);
  const resolved = await input.store.resolveDeviceToken(token);
  if (!resolved) {
    throw new GatewayHttpError(401, "Invalid bearer token.");
  }

  await input.store.touchDeviceSeen({
    sourceId: resolved.source.sourceId,
    deviceId: resolved.device.deviceId,
  });
  return resolved;
}

export function requireDeviceCapability(
  device: Pick<GatewayDeviceRecord, "capabilities">,
  capability: GatewayDeviceCapability,
): void {
  if (!device.capabilities.includes(capability)) {
    throw new GatewayHttpError(403, `Device token is missing the ${capability} capability.`);
  }
}

export function allowedCommandKindsForDevice(
  device: Pick<GatewayDeviceRecord, "capabilities">,
): readonly GatewayDeviceCommandKind[] {
  return gatewayDeviceAllowedCommandKinds(device.capabilities);
}
