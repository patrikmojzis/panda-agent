import type {BaileysEventMap, ConnectionState, WASocket} from "baileys";

import type {WhatsAppAuthStateHandle} from "./auth-store.js";
import {
  describeWhatsAppDisconnectStatus,
  extractWhatsAppDisconnectStatusCode,
  shouldReconnectWhatsApp,
} from "./connection.js";
import {ingestWhatsAppMessagesUpsert, type WhatsAppMessageRequestQueue} from "./message-ingestion.js";
import {
  collectWhatsAppMediaParts,
  downloadWhatsAppSupportedMedia,
  type WhatsAppMediaStore,
} from "./media.js";

export interface WhatsAppSocketCycleOptions {
  connectorKey: string;
  socket: Pick<WASocket, "ev" | "updateMediaMessage">;
  authHandle: Pick<WhatsAppAuthStateHandle, "saveCreds">;
  requests: WhatsAppMessageRequestQueue;
  mediaStore: WhatsAppMediaStore;
  isStopping(): boolean;
  setStopWaiter?(waiter: (() => void) | null): void;
  markSocketState?(state: "open" | "closed"): void;
  onConnectionOpen?(): void;
  log(event: string, payload: Record<string, unknown>): void;
}

export type WhatsAppSocketCycleResult = {
  reconnect: boolean;
  reason?: string;
};

export async function waitForWhatsAppSocketCycle(
  options: WhatsAppSocketCycleOptions,
): Promise<WhatsAppSocketCycleResult> {
  return new Promise<WhatsAppSocketCycleResult>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      options.socket.ev.off("connection.update", onConnectionUpdate);
      options.socket.ev.off("messages.upsert", onMessagesUpsert);
      options.socket.ev.off("messaging-history.set", onHistorySet);
      options.setStopWaiter?.(null);
    };

    const finish = (outcome: WhatsAppSocketCycleResult) => {
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

    const onMessagesUpsert = (update: BaileysEventMap["messages.upsert"]) => {
      void ingestWhatsAppMessagesUpsert(update, {
        connectorKey: options.connectorKey,
        requests: options.requests,
        downloadMedia: async (message) => {
          const parts = collectWhatsAppMediaParts(message);
          if (parts.length === 0) {
            return [];
          }

          return downloadWhatsAppSupportedMedia(message, {
            connectorKey: options.connectorKey,
            mediaStore: options.mediaStore,
            reuploadRequest: options.socket.updateMediaMessage,
            parts,
          });
        },
        log: options.log,
      }).catch((error) => {
        options.log("upsert_error", {
          connectorKey: options.connectorKey,
          message: error instanceof Error ? error.message : String(error),
        });
        if (!options.isStopping()) {
          finish({reconnect: true, reason: "upsert_error"});
        }
      });
    };

    const onHistorySet = (update: BaileysEventMap["messaging-history.set"]) => {
      options.log("history_sync_ignored", {
        connectorKey: options.connectorKey,
        chatCount: update.chats.length,
        contactCount: update.contacts.length,
        messageCount: update.messages.length,
        syncType: update.syncType ?? null,
        isLatest: update.isLatest ?? null,
      });
    };

    const onConnectionUpdate = (update: Partial<ConnectionState>) => {
      if (update.connection) {
        if (update.connection === "open") {
          options.markSocketState?.("open");
        } else if (update.connection === "close" && !options.isStopping()) {
          options.markSocketState?.("closed");
        }
        options.log("connection_update", {
          connectorKey: options.connectorKey,
          connection: update.connection,
          receivedPendingNotifications: update.receivedPendingNotifications ?? null,
          isNewLogin: update.isNewLogin ?? null,
        });
      }

      if (update.connection === "open") {
        options.onConnectionOpen?.();
      }

      if (update.connection !== "close") {
        return;
      }

      const statusCode = extractWhatsAppDisconnectStatusCode(update.lastDisconnect?.error);
      const reason = describeWhatsAppDisconnectStatus(statusCode);

      options.log("connection_closed", {
        connectorKey: options.connectorKey,
        reason,
        statusCode,
        message: update.lastDisconnect?.error instanceof Error
          ? update.lastDisconnect.error.message
          : String(update.lastDisconnect?.error ?? ""),
      });

      if (options.isStopping()) {
        finish({reconnect: false, reason: "stopped"});
        return;
      }

      if (shouldReconnectWhatsApp(statusCode)) {
        finish({reconnect: true, reason});
        return;
      }

      fail(new Error(`WhatsApp connection closed permanently (${reason}).`));
    };

    options.setStopWaiter?.(() => {
      finish({reconnect: false, reason: "stopped"});
    });

    options.socket.ev.on("connection.update", onConnectionUpdate);
    options.socket.ev.on("messages.upsert", onMessagesUpsert);
    options.socket.ev.on("messaging-history.set", onHistorySet);
    options.authHandle.saveCreds().catch((error) => {
      fail(error instanceof Error ? error : new Error(String(error)));
    });
  });
}
