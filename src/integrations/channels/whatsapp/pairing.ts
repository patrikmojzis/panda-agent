import type {ConnectionState, WASocket} from "baileys";

import {
  toWhatsAppWhoamiResult,
  type WhatsAppAccountCreds,
  type WhatsAppPairResult,
  type WhatsAppWhoamiResult,
} from "./account.js";
import {
  describeWhatsAppDisconnectStatus,
  extractWhatsAppDisconnectStatusCode,
  shouldReconnectWhatsAppPairing,
} from "./connection.js";

export const WHATSAPP_PAIRING_CODE_REQUEST_DELAY_MS = 1_500;
export const WHATSAPP_PAIRING_RECONNECT_DELAY_MS = 1_000;

export type WhatsAppPairSocketCycleResult =
  | {pairedIdentity: WhatsAppWhoamiResult}
  | {reconnect: true; reason: string};

export interface WhatsAppPairingAuthHandle {
  state: {
    creds: WhatsAppAccountCreds;
  };
  promoteTo(connectorKey: string): Promise<void>;
}

export interface WhatsAppPairingCycleOptions {
  connectorKey: string;
  phoneNumber: string;
  socket: Pick<WASocket, "ev" | "requestPairingCode">;
  authHandle: WhatsAppPairingAuthHandle;
  pairingCode?: string;
  pairingCodeRequestDelayMs?: number;
  onPairingCode?: (code: string) => void;
}

export interface WhatsAppPairingLoopOptions {
  connectorKey: string;
  phoneNumber: string;
  pairingCode: string;
  onPairingCode?: (code: string) => void;
  isStopping(): boolean;
  sleep(ms: number): Promise<void>;
  log(event: string, payload: Record<string, unknown>): void;
  runCycle(
    phoneNumber: string,
    onPairingCode: (code: string) => void,
    pairingCode: string,
  ): Promise<WhatsAppPairSocketCycleResult>;
}

export async function runWhatsAppPairingLoop(options: WhatsAppPairingLoopOptions): Promise<WhatsAppPairResult> {
  let pairingCodeAnnounced = false;
  const announcePairingCode = (code: string) => {
    if (pairingCodeAnnounced) {
      return;
    }

    pairingCodeAnnounced = true;
    options.onPairingCode?.(code);
  };

  while (!options.isStopping()) {
    const outcome = await options.runCycle(options.phoneNumber, announcePairingCode, options.pairingCode);
    if ("pairedIdentity" in outcome) {
      return {
        ...outcome.pairedIdentity,
        pairingCode: undefined,
        alreadyPaired: false,
      };
    }

    options.log("pairing_reconnect_scheduled", {
      connectorKey: options.connectorKey,
      reason: outcome.reason,
      delayMs: WHATSAPP_PAIRING_RECONNECT_DELAY_MS,
    });
    await options.sleep(WHATSAPP_PAIRING_RECONNECT_DELAY_MS);
  }

  throw new Error(`WhatsApp connector ${options.connectorKey} pairing stopped before login completed.`);
}

export async function waitForWhatsAppPairingCycle(
  options: WhatsAppPairingCycleOptions,
): Promise<WhatsAppPairSocketCycleResult> {
  return new Promise<WhatsAppPairSocketCycleResult>((resolve, reject) => {
    let settled = false;
    let pairingCodeRequested = false;
    let pairingCodeTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (pairingCodeTimer) {
        clearTimeout(pairingCodeTimer);
        pairingCodeTimer = null;
      }
      options.socket.ev.off("connection.update", onConnectionUpdate);
    };

    const finish = (outcome: WhatsAppPairSocketCycleResult) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve(outcome);
    };

    const fail = (error: Error) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(error);
    };

    const finishPaired = () => {
      options.authHandle.promoteTo(options.connectorKey)
        .then(() => {
          finish({
            pairedIdentity: toWhatsAppWhoamiResult(options.connectorKey, options.authHandle.state.creds),
          });
        })
        .catch((error) => {
          fail(error instanceof Error ? error : new Error(String(error)));
        });
    };

    const requestPairingCodeOnce = () => {
      if (pairingCodeRequested || settled) {
        return;
      }

      pairingCodeRequested = true;
      options.socket.requestPairingCode(options.phoneNumber, options.pairingCode)
        .then((issuedPairingCode) => {
          if (!settled) {
            options.onPairingCode?.(issuedPairingCode);
          }
        })
        .catch((error) => {
          const statusCode = extractWhatsAppDisconnectStatusCode(error);
          const reason = describeWhatsAppDisconnectStatus(statusCode);
          if (shouldReconnectWhatsAppPairing(statusCode)) {
            finish({reconnect: true, reason});
            return;
          }

          fail(error instanceof Error ? error : new Error(String(error)));
        });
    };

    const schedulePairingCodeRequest = () => {
      if (pairingCodeTimer || pairingCodeRequested || settled) {
        return;
      }

      pairingCodeTimer = setTimeout(() => {
        pairingCodeTimer = null;
        requestPairingCodeOnce();
      }, options.pairingCodeRequestDelayMs ?? WHATSAPP_PAIRING_CODE_REQUEST_DELAY_MS);
    };

    const onConnectionUpdate = (update: Partial<ConnectionState>) => {
      if (update.connection === "connecting" || update.qr) {
        schedulePairingCodeRequest();
      }

      if (update.isNewLogin === true && options.authHandle.state.creds.registered) {
        finishPaired();
        return;
      }

      if (update.connection === "open") {
        finishPaired();
        return;
      }

      if (update.connection === "close") {
        const statusCode = extractWhatsAppDisconnectStatusCode(update.lastDisconnect?.error);
        const reason = describeWhatsAppDisconnectStatus(statusCode);
        if (shouldReconnectWhatsAppPairing(statusCode)) {
          finish({reconnect: true, reason});
          return;
        }

        fail(update.lastDisconnect?.error instanceof Error
          ? update.lastDisconnect.error
          : new Error(`WhatsApp pairing closed before login completed (${reason}).`));
      }
    };

    options.socket.ev.on("connection.update", onConnectionUpdate);
    schedulePairingCodeRequest();
  });
}
