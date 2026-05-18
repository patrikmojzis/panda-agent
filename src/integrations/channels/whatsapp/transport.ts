import type {WASocket} from "baileys";

export interface WhatsAppLoggerLike {
  level: string;
  child(obj: Record<string, unknown>): WhatsAppLoggerLike;
  trace(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export const WHATSAPP_LOGGER: WhatsAppLoggerLike = {
  level: "silent",
  child() {
    return this;
  },
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export function assertWhatsAppConnectorKey(expected: string, actual: string, capability: "outbound" | "typing"): void {
  if (expected === actual) {
    return;
  }

  throw new Error(`WhatsApp ${capability} connector mismatch. Expected ${expected}, got ${actual}.`);
}

export function requireWhatsAppSocket<TSocket = WASocket>(
  getSocket: () => TSocket | null,
  capability: "outbound" | "typing",
): TSocket {
  const socket = getSocket();
  if (!socket) {
    throw new Error(`WhatsApp ${capability} is unavailable because the connector socket is not connected.`);
  }

  return socket;
}
