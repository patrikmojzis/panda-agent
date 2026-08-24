import {validateIdentifier} from "../../lib/postgres-relations.js";
import {normalizeGatewayDeviceId, normalizeGatewaySourceId} from "./postgres-rows.js";

export interface GatewayDeviceCommandNotification {
  sourceId: string;
  deviceId: string;
}

/** Postgres notification channel for newly queued Gateway device commands. */
export function buildGatewayDeviceCommandNotificationChannel(): string {
  return validateIdentifier("runtime_gateway_device_command_events");
}

export function parseGatewayDeviceCommandNotification(
  payload: string,
): GatewayDeviceCommandNotification | null {
  try {
    const parsed = JSON.parse(payload) as Partial<GatewayDeviceCommandNotification>;
    if (typeof parsed.sourceId !== "string" || typeof parsed.deviceId !== "string") {
      return null;
    }
    return {
      sourceId: normalizeGatewaySourceId(parsed.sourceId),
      deviceId: normalizeGatewayDeviceId(parsed.deviceId),
    };
  } catch {
    return null;
  }
}
