import {afterEach, describe, expect, it, vi} from "vitest";

import {
  runWhatsAppPairingLoop,
  type WhatsAppPairingAuthHandle,
  waitForWhatsAppPairingCycle,
} from "../src/integrations/channels/whatsapp/pairing.js";

vi.mock("baileys", () => ({
  DisconnectReason: {
    connectionClosed: 428,
    connectionLost: 408,
    timedOut: 408,
    restartRequired: 515,
    loggedOut: 401,
    unavailableService: 503,
  },
}));

function createSocket() {
  return {
    ev: {
      on: vi.fn(),
      off: vi.fn(),
    },
    requestPairingCode: vi.fn(async () => "123-456"),
  };
}

function readConnectionHandler(socket: ReturnType<typeof createSocket>) {
  const handler = socket.ev.on.mock.calls.find(([event]) => {
    return event === "connection.update";
  })?.[1];
  expect(handler).toBeTypeOf("function");
  return handler as (update: Record<string, unknown>) => void;
}

function createAuthHandle(
  creds: WhatsAppPairingAuthHandle["state"]["creds"] = {},
): WhatsAppPairingAuthHandle {
  return {
    state: {
      creds,
    },
    promoteTo: vi.fn(async () => {}),
  };
}

describe("WhatsApp pairing cycle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("requests a pairing code only after the socket starts connecting", async () => {
    vi.useFakeTimers();
    const socket = createSocket();
    const authHandle = createAuthHandle({
      registered: true,
      me: {
        id: "421944478544@s.whatsapp.net",
      },
    });
    const pairingCodes: string[] = [];

    const cycle = waitForWhatsAppPairingCycle({
      connectorKey: "main",
      phoneNumber: "421944478544",
      socket,
      authHandle,
      onPairingCode: (code) => pairingCodes.push(code),
    });
    await Promise.resolve();

    expect(socket.requestPairingCode).not.toHaveBeenCalled();

    const connectionHandler = readConnectionHandler(socket);
    connectionHandler({connection: "connecting"});

    expect(socket.requestPairingCode).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_500);

    expect(socket.requestPairingCode).toHaveBeenCalledWith("421944478544", undefined);
    expect(pairingCodes).toEqual(["123-456"]);

    connectionHandler({connection: "open"});

    await expect(cycle).resolves.toEqual({
      pairedIdentity: {
        connectorKey: "main",
        registered: true,
        accountId: "421944478544@s.whatsapp.net",
      },
    });
    expect(authHandle.promoteTo).toHaveBeenCalledWith("main");
    expect(socket.ev.off).toHaveBeenCalledWith("connection.update", connectionHandler);
  });

  it("treats pairing-code request 428 errors as reconnectable", async () => {
    vi.useFakeTimers();
    const socket = createSocket();
    socket.requestPairingCode.mockRejectedValue({
      output: {
        statusCode: 428,
      },
    });

    const cycle = waitForWhatsAppPairingCycle({
      connectorKey: "main",
      phoneNumber: "421944478544",
      socket,
      authHandle: createAuthHandle(),
    });
    await Promise.resolve();

    readConnectionHandler(socket)({connection: "connecting"});
    await vi.advanceTimersByTimeAsync(1_500);

    await expect(cycle).resolves.toEqual({
      reconnect: true,
      reason: "428",
    });
  });

  it("treats WhatsApp 401 closes as retryable while linking", async () => {
    vi.useFakeTimers();
    const socket = createSocket();

    const cycle = waitForWhatsAppPairingCycle({
      connectorKey: "main",
      phoneNumber: "421944478544",
      socket,
      authHandle: createAuthHandle(),
    });
    await Promise.resolve();

    readConnectionHandler(socket)({
      connection: "close",
      lastDisconnect: {
        error: {
          output: {
            statusCode: 401,
          },
        },
      },
    });

    await expect(cycle).resolves.toEqual({
      reconnect: true,
      reason: "401",
    });
  });

  it("promotes pairing auth when WhatsApp reports a new login before restart", async () => {
    const socket = createSocket();
    const authHandle = createAuthHandle({
      registered: true,
      me: {
        id: "421944478544:1@s.whatsapp.net",
      },
    });

    const cycle = waitForWhatsAppPairingCycle({
      connectorKey: "main",
      phoneNumber: "421944478544",
      socket,
      authHandle,
    });
    await Promise.resolve();

    readConnectionHandler(socket)({isNewLogin: true});

    await expect(cycle).resolves.toEqual({
      pairedIdentity: {
        connectorKey: "main",
        registered: true,
        accountId: "421944478544:1@s.whatsapp.net",
      },
    });
    expect(authHandle.promoteTo).toHaveBeenCalledWith("main");
  });
});

describe("WhatsApp pairing loop", () => {
  it("reuses one pairing code across reconnects and announces it once", async () => {
    const pairingCodes: string[] = [];
    const logs: Array<{event: string; payload: Record<string, unknown>}> = [];
    const runCycle = vi.fn()
      .mockImplementationOnce(async (_phoneNumber, onPairingCode, pairingCode) => {
        onPairingCode(pairingCode);
        return {reconnect: true, reason: "405"};
      })
      .mockImplementationOnce(async (_phoneNumber, onPairingCode, pairingCode) => {
        onPairingCode(pairingCode);
        return {
          pairedIdentity: {
            connectorKey: "main",
            registered: true,
            accountId: "421944478544@s.whatsapp.net",
          },
        };
      });

    await expect(runWhatsAppPairingLoop({
      connectorKey: "main",
      phoneNumber: "421944478544",
      pairingCode: "ABCDEFGH",
      onPairingCode: (code) => pairingCodes.push(code),
      isStopping: () => false,
      sleep: vi.fn(async () => {}),
      log: (event, payload) => logs.push({event, payload}),
      runCycle,
    })).resolves.toEqual({
      connectorKey: "main",
      registered: true,
      accountId: "421944478544@s.whatsapp.net",
      pairingCode: undefined,
      alreadyPaired: false,
    });

    expect(pairingCodes).toEqual(["ABCDEFGH"]);
    expect(runCycle).toHaveBeenNthCalledWith(1, "421944478544", expect.any(Function), "ABCDEFGH");
    expect(runCycle).toHaveBeenNthCalledWith(2, "421944478544", expect.any(Function), "ABCDEFGH");
    expect(logs).toEqual([{
      event: "pairing_reconnect_scheduled",
      payload: {
        connectorKey: "main",
        reason: "405",
        delayMs: 1000,
      },
    }]);
  });

  it("stops pairing when the connector is shutting down", async () => {
    await expect(runWhatsAppPairingLoop({
      connectorKey: "main",
      phoneNumber: "421944478544",
      pairingCode: "ABCDEFGH",
      isStopping: () => true,
      sleep: vi.fn(async () => {}),
      log: vi.fn(),
      runCycle: vi.fn(),
    })).rejects.toThrow("WhatsApp connector main pairing stopped before login completed.");
  });
});
