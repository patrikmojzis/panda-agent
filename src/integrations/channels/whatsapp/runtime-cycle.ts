import type {BaileysEventMap, ConnectionState, WASocket} from "baileys";

import type {WhatsAppAuthStateHandle} from "./auth-store.js";
import type {WhatsAppActorAuthorization} from "./authorization.js";
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
import type {WhatsAppMediaWorkQueue} from "./media-work-queue.js";

const DEFAULT_WHATSAPP_MESSAGE_INGRESS_CONCURRENCY = 4;
const DEFAULT_WHATSAPP_MESSAGE_INGRESS_QUEUE_MAX = 64;

export interface WhatsAppSocketCycleOptions {
  connectorKey: string;
  socket: Pick<WASocket, "ev" | "updateMediaMessage">;
  authHandle: Pick<WhatsAppAuthStateHandle, "saveCreds">;
  requests: WhatsAppMessageRequestQueue;
  mediaStore: WhatsAppMediaStore;
  mediaQueue: WhatsAppMediaWorkQueue;
  authorizeActor(externalActorId: string): Promise<WhatsAppActorAuthorization>;
  ingressConcurrency?: number;
  ingressQueueMax?: number;
  maxMediaBytes: number;
  mediaDownloadTimeoutMs: number;
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
    const ingressConcurrency = options.ingressConcurrency ?? DEFAULT_WHATSAPP_MESSAGE_INGRESS_CONCURRENCY;
    const ingressQueueMax = options.ingressQueueMax ?? DEFAULT_WHATSAPP_MESSAGE_INGRESS_QUEUE_MAX;
    let settled = false;
    let activeIngress = 0;
    let ingressClosed = false;
    const ingressAbort = new AbortController();
    const ingressQueue: Array<BaileysEventMap["messages.upsert"]> = [];

    const runIngress = async (update: BaileysEventMap["messages.upsert"]): Promise<void> => {
      await ingestWhatsAppMessagesUpsert(update, {
        connectorKey: options.connectorKey,
        requests: options.requests,
        authorizeActor: options.authorizeActor,
        downloadMedia: async (message, receiptOwner) => {
          const parts = collectWhatsAppMediaParts(message);
          if (parts.length === 0) return [];
          return options.mediaQueue.run((signal) => downloadWhatsAppSupportedMedia(message, {
              connectorKey: options.connectorKey,
              mediaStore: {
                writeMediaFile: (input) => options.mediaStore.writeMediaFile({...input, receiptOwner}),
              },
              reuploadRequest: options.socket.updateMediaMessage,
              parts,
              maxBytes: options.maxMediaBytes,
              timeoutMs: options.mediaDownloadTimeoutMs,
              signal,
              onCleanupError: (error) => options.log("media_cleanup_failed", {
                connectorKey: options.connectorKey,
                message: error instanceof Error ? error.message : String(error),
              }),
            }), {
              signal: ingressAbort.signal,
              singleFlightKey: `${receiptOwner.requestKind}:${receiptOwner.requestIdempotencyKey}`,
            });
        },
        log: options.log,
      });
    };

    const drainIngress = (): void => {
      while (!ingressClosed && activeIngress < ingressConcurrency && ingressQueue.length > 0) {
        const update = ingressQueue.shift()!;
        activeIngress += 1;
        void runIngress(update).catch((error) => {
          options.log("upsert_error", {
            connectorKey: options.connectorKey,
            message: error instanceof Error ? error.message : String(error),
          });
        }).finally(() => {
          activeIngress -= 1;
          drainIngress();
        });
      }
    };

    const enqueueIngress = (update: BaileysEventMap["messages.upsert"]): boolean => {
      if (ingressClosed || ingressQueue.length >= ingressQueueMax) return false;
      ingressQueue.push(update);
      drainIngress();
      return true;
    };

    const cleanup = () => {
      ingressClosed = true;
      ingressQueue.length = 0;
      ingressAbort.abort(new Error("WhatsApp socket cycle ended."));
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
      if (update.type !== "notify") {
        options.log("message_ignored", {
          connectorKey: options.connectorKey,
          reason: "non_notify_upsert",
          upsertType: update.type,
          messageCount: update.messages.length,
        });
        return;
      }

      let dropped = 0;
      for (const message of update.messages) {
        if (!enqueueIngress({...update, messages: [message]})) dropped += 1;
      }
      if (dropped > 0) {
        options.log("message_dropped", {
          connectorKey: options.connectorKey,
          reason: "ingress_overloaded",
          messageCount: dropped,
        });
      }
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
