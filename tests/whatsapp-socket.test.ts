import {afterEach, describe, expect, it, vi} from "vitest";
import {initAuthCreds} from "baileys";

import type {WhatsAppAuthStateHandle} from "../src/integrations/channels/whatsapp/auth-store.js";
import {createWhatsAppSocket} from "../src/integrations/channels/whatsapp/socket.js";

const whatsappSocketMocks = vi.hoisted(() => {
  const socket = {
    ev: {
      on: vi.fn(),
    },
  };

  return {
    socket,
    makeWASocket: vi.fn(() => socket),
    makeCacheableSignalKeyStore: vi.fn((keys) => keys),
    addTransactionCapability: vi.fn((keys) => keys),
    ubuntuBrowser: vi.fn(() => ["Panda"]),
  };
});

vi.mock("baileys", async (importOriginal) => {
  const actual = await importOriginal<typeof import("baileys")>();
  return {
    ...actual,
    addTransactionCapability: whatsappSocketMocks.addTransactionCapability,
    Browsers: {
      ...actual.Browsers,
      ubuntu: whatsappSocketMocks.ubuntuBrowser,
    },
    makeCacheableSignalKeyStore: whatsappSocketMocks.makeCacheableSignalKeyStore,
    makeWASocket: whatsappSocketMocks.makeWASocket,
  };
});

function createAuthHandle(): WhatsAppAuthStateHandle {
  const creds = initAuthCreds();
  creds.registered = true;

  return {
    state: {
      creds,
      keys: {
        get: async () => ({}),
        set: async () => {},
      },
    },
    saveCreds: vi.fn(async () => {}),
  };
}

describe("WhatsApp socket factory", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("creates Baileys sockets with Panda's fixed browser and sync policy", async () => {
    const authHandle = createAuthHandle();

    createWhatsAppSocket({
      authHandle,
      socketVersion: [2, 3000, 1038819500],
    });

    expect(whatsappSocketMocks.ubuntuBrowser).toHaveBeenCalledWith("Chrome");
    const socketConfig = whatsappSocketMocks.makeWASocket.mock.calls[0]?.[0];
    expect(socketConfig).toEqual(expect.objectContaining({
      auth: expect.objectContaining({
        creds: authHandle.state.creds,
        keys: authHandle.state.keys,
      }),
      browser: ["Panda"],
      version: [2, 3000, 1038819500],
      syncFullHistory: false,
      markOnlineOnConnect: false,
    }));
    expect(await socketConfig.getMessage()).toBeUndefined();
    expect(socketConfig.shouldSyncHistoryMessage()).toBe(false);
  });

  it("persists creds on Baileys creds.update by default", async () => {
    const authHandle = createAuthHandle();

    createWhatsAppSocket({authHandle});

    const handler = whatsappSocketMocks.socket.ev.on.mock.calls.find(([event]) => {
      return event === "creds.update";
    })?.[1];
    expect(handler).toBeTypeOf("function");

    await handler();

    expect(authHandle.saveCreds).toHaveBeenCalledTimes(1);
  });

  it("can leave transient pairing creds unpersisted", () => {
    createWhatsAppSocket({
      authHandle: createAuthHandle(),
      persistCredsOnUpdate: false,
    });

    expect(whatsappSocketMocks.socket.ev.on).not.toHaveBeenCalledWith("creds.update", expect.any(Function));
  });
});
