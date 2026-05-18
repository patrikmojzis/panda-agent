import {DisconnectReason} from "baileys";

const WHATSAPP_TRANSIENT_REJECTION_STATUS = 405;

export function extractWhatsAppDisconnectStatusCode(error: unknown): number | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  if ("output" in error && error.output && typeof error.output === "object") {
    const output = error.output as {statusCode?: unknown};
    if (typeof output.statusCode === "number") {
      return output.statusCode;
    }
  }

  if ("statusCode" in error && typeof (error as {statusCode?: unknown}).statusCode === "number") {
    return (error as {statusCode: number}).statusCode;
  }

  return null;
}

export function shouldReconnectWhatsApp(statusCode: number | null): boolean {
  switch (statusCode) {
    case DisconnectReason.connectionClosed:
    case DisconnectReason.connectionLost:
    case DisconnectReason.timedOut:
    case DisconnectReason.restartRequired:
    case DisconnectReason.unavailableService:
    case WHATSAPP_TRANSIENT_REJECTION_STATUS:
      return true;
    default:
      return false;
  }
}

export function shouldReconnectWhatsAppPairing(statusCode: number | null): boolean {
  return shouldReconnectWhatsApp(statusCode) || statusCode === DisconnectReason.loggedOut;
}

export function describeWhatsAppDisconnectStatus(statusCode: number | null): string {
  if (statusCode === null) {
    return "unknown";
  }

  return DisconnectReason[statusCode] ?? String(statusCode);
}
