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

export type WhatsAppDiagnosticLog = (
  event: string,
  payload: Record<string, unknown>,
) => void;

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

function readDiagnosticRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {};
}

/** Emits only allowlisted pairing metadata from Baileys, never stanza contents or identifiers. */
export function createWhatsAppPairingLogger(log: WhatsAppDiagnosticLog): WhatsAppLoggerLike {
  const write = (value: unknown, message?: string): void => {
    if (message === "panda pairing notification") {
      const diagnostic = readDiagnosticRecord(value);
      log("pairing_protocol_notification", {
        notificationType: typeof diagnostic.notificationType === "string"
          ? diagnostic.notificationType
          : "unknown",
        childTags: Array.isArray(diagnostic.childTags)
          ? diagnostic.childTags.filter((tag): tag is string => typeof tag === "string").slice(0, 8)
          : [],
        registered: diagnostic.registered === true,
      });
      return;
    }

    if (message === "failed to ack notification") {
      log("pairing_protocol_ack_failed", {});
    }
  };

  return {
    level: "info",
    child() {
      return this;
    },
    trace: write,
    debug: write,
    info: write,
    warn: write,
    error: write,
  };
}

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
