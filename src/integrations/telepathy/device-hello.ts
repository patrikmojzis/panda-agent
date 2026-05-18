import type {WebSocket} from "ws";

import type {TelepathyDeviceRecord} from "../../domain/telepathy/types.js";
import {opaqueTokenMatches} from "../../lib/opaque-tokens.js";
import type {TelepathyDeviceHello} from "./protocol.js";

export interface ConnectedTelepathyDevice {
  agentKey: string;
  authenticatedTokenHash: string;
  connectedAt: number;
  deviceId: string;
  label?: string;
  lastSeenAt: number;
  socket: WebSocket;
}

export type TelepathyDeviceHelloResult =
  | {
    device: ConnectedTelepathyDevice;
    deviceKey: string;
    ok: true;
  }
  | {
    closeReason: string;
    ok: false;
  };

export function buildTelepathyDeviceKey(agentKey: string, deviceId: string): string {
  return `${agentKey}::${deviceId}`;
}

export interface TelepathyDeviceHelloStore {
  getDevice(agentKey: string, deviceId: string): Promise<TelepathyDeviceRecord>;
  markConnected(agentKey: string, deviceId: string, label?: string): Promise<TelepathyDeviceRecord>;
}

/**
 * Authenticates `device.hello` and records the connection in the device store.
 * Live-socket replacement stays in TelepathyHub because it owns the connection map.
 */
export async function acceptTelepathyDeviceHello(input: {
  message: TelepathyDeviceHello;
  socket: WebSocket;
  store: TelepathyDeviceHelloStore;
}): Promise<TelepathyDeviceHelloResult> {
  let registeredDevice;
  try {
    registeredDevice = await input.store.getDevice(input.message.agentKey, input.message.deviceId);
  } catch {
    return {
      ok: false,
      closeReason: "Unknown telepathy device",
    };
  }

  if (!registeredDevice.enabled || !opaqueTokenMatches(input.message.token, registeredDevice.tokenHash)) {
    return {
      ok: false,
      closeReason: "Invalid telepathy token",
    };
  }

  const storedDevice = await input.store.markConnected(
    input.message.agentKey,
    input.message.deviceId,
    input.message.label,
  );

  return {
    ok: true,
    deviceKey: buildTelepathyDeviceKey(input.message.agentKey, input.message.deviceId),
    device: {
      agentKey: storedDevice.agentKey,
      deviceId: storedDevice.deviceId,
      ...(storedDevice.label ? {label: storedDevice.label} : {}),
      authenticatedTokenHash: storedDevice.tokenHash,
      socket: input.socket,
      connectedAt: storedDevice.connectedAt ?? Date.now(),
      lastSeenAt: storedDevice.lastSeenAt ?? Date.now(),
    },
  };
}
