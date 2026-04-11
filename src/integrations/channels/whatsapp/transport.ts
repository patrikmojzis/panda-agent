import type {WASocket} from "baileys";

export function assertWhatsAppConnectorKey(expected: string, actual: string, capability: "outbound" | "typing"): void {
  if (expected === actual) {
    return;
  }

  throw new Error(`WhatsApp ${capability} connector mismatch. Expected ${expected}, got ${actual}.`);
}

export function requireWhatsAppSocket(
  getSocket: () => WASocket | null,
  capability: "outbound" | "typing",
): WASocket {
  const socket = getSocket();
  if (!socket) {
    throw new Error(`WhatsApp ${capability} is unavailable because the connector socket is not connected.`);
  }

  return socket;
}
