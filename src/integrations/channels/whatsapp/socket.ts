import {
  addTransactionCapability,
  Browsers,
  makeCacheableSignalKeyStore,
  makeWASocket,
  type WAVersion,
  type WASocket,
} from "baileys";

import type {WhatsAppAuthStateHandle} from "./auth-store.js";
import {WHATSAPP_LOGGER} from "./transport.js";

const TRANSACTION_OPTIONS = {
  maxCommitRetries: 5,
  delayBetweenTriesMs: 200,
} as const;

const WHATSAPP_BROWSER_NAME = "Chrome";

export interface CreateWhatsAppSocketOptions {
  authHandle: WhatsAppAuthStateHandle;
  socketVersion?: WAVersion;
  persistCredsOnUpdate?: boolean;
}

export function createWhatsAppSocket(options: CreateWhatsAppSocketOptions): WASocket {
  const socket = makeWASocket({
    auth: {
      creds: options.authHandle.state.creds,
      keys: addTransactionCapability(
        makeCacheableSignalKeyStore(options.authHandle.state.keys, WHATSAPP_LOGGER),
        WHATSAPP_LOGGER,
        TRANSACTION_OPTIONS,
      ),
    },
    logger: WHATSAPP_LOGGER,
    browser: Browsers.ubuntu(WHATSAPP_BROWSER_NAME),
    ...(options.socketVersion ? {version: options.socketVersion} : {}),
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    markOnlineOnConnect: false,
    getMessage: async () => undefined,
  });

  if (options.persistCredsOnUpdate ?? true) {
    socket.ev.on("creds.update", async () => {
      await options.authHandle.saveCreds();
    });
  }

  return socket;
}
