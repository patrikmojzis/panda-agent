import type {WAMessage} from "baileys";
import {describe, expect, it, vi} from "vitest";

import {waitForWhatsAppSocketCycle} from "../src/integrations/channels/whatsapp/runtime-cycle.js";

vi.mock("baileys", () => ({
  DisconnectReason: {
    connectionClosed: 428,
    connectionLost: 408,
    timedOut: 408,
    restartRequired: 515,
    loggedOut: 401,
    unavailableService: 503,
  },
  isJidBroadcast: (jid?: string) => Boolean(jid?.endsWith("@broadcast")),
  isJidGroup: (jid?: string) => Boolean(jid?.endsWith("@g.us")),
  isJidNewsletter: (jid?: string) => Boolean(jid?.endsWith("@newsletter")),
  isJidStatusBroadcast: (jid?: string) => jid === "status@broadcast",
  jidNormalizedUser: (jid: string) => jid,
}));

vi.mock("baileys/lib/Utils/messages.js", () => ({
  downloadMediaMessage: vi.fn(async () => Buffer.from("media")),
  normalizeMessageContent: vi.fn((message) => message ?? undefined),
}));

function createSocket() {
  return {
    ev: {
      on: vi.fn(),
      off: vi.fn(),
    },
    updateMediaMessage: vi.fn(),
  };
}

function readHandler<T>(socket: ReturnType<typeof createSocket>, event: string): T {
  const handler = socket.ev.on.mock.calls.find(([candidate]) => candidate === event)?.[1];
  expect(handler).toBeTypeOf("function");
  return handler as T;
}

function createCycleOptions(overrides: Record<string, unknown> = {}) {
  return {
    connectorKey: "main",
    socket: createSocket(),
    authHandle: {
      saveCreds: vi.fn(async () => {}),
    },
    requests: {
      enqueueRequest: vi.fn(async () => ({
        id: "request-1",
      })),
    },
    mediaStore: {
      writeMedia: vi.fn(async () => ({
        id: "media-1",
        source: "whatsapp",
        connectorKey: "main",
        mimeType: "image/jpeg",
        sizeBytes: 128,
        localPath: "/tmp/media.bin",
        originalFilename: null,
        metadata: {},
        createdAt: 1,
      })),
    },
    isStopping: vi.fn(() => false),
    setStopWaiter: vi.fn(),
    markSocketState: vi.fn(),
    onConnectionOpen: vi.fn(),
    logs: [] as Array<{event: string; payload: Record<string, unknown>}>,
    log(event: string, payload: Record<string, unknown>) {
      this.logs.push({event, payload});
    },
    ...overrides,
  };
}

function createPrivateMessage(overrides: Partial<WAMessage> = {}): WAMessage {
  return {
    key: {
      remoteJid: "123@s.whatsapp.net",
      participant: undefined,
      id: "msg-1",
      fromMe: false,
    },
    message: {
      conversation: "hello from whatsapp",
    },
    pushName: "Alice",
    ...overrides,
  } as WAMessage;
}

describe("WhatsApp socket runtime cycle", () => {
  it("treats WhatsApp 405 closes as reconnectable", async () => {
    const options = createCycleOptions();

    const cycle = waitForWhatsAppSocketCycle(options);
    await Promise.resolve();

    const connectionHandler = readHandler<(update: Record<string, unknown>) => void>(options.socket, "connection.update");
    connectionHandler({
      connection: "close",
      lastDisconnect: {
        error: {
          output: {
            statusCode: 405,
          },
        },
      },
    });

    await expect(cycle).resolves.toEqual({
      reconnect: true,
      reason: "405",
    });
    expect(options.markSocketState).toHaveBeenCalledWith("closed");
    expect(options.socket.ev.off).toHaveBeenCalledWith("connection.update", connectionHandler);
    expect(options.setStopWaiter).toHaveBeenLastCalledWith(null);
  });

  it("ingests WhatsApp upserts through the runtime request queue", async () => {
    const options = createCycleOptions();

    const cycle = waitForWhatsAppSocketCycle(options);
    await Promise.resolve();

    const upsertHandler = readHandler<(update: {type: "notify"; messages: WAMessage[]}) => void>(
      options.socket,
      "messages.upsert",
    );
    upsertHandler({
      type: "notify",
      messages: [createPrivateMessage()],
    });
    await Promise.resolve();

    expect(options.requests.enqueueRequest).toHaveBeenCalledWith({
      kind: "whatsapp_message",
      payload: expect.objectContaining({
        connectorKey: "main",
        externalConversationId: "123@s.whatsapp.net",
        externalActorId: "123@s.whatsapp.net",
        externalMessageId: "msg-1",
        text: "hello from whatsapp",
      }),
    });

    const stopWaiter = options.setStopWaiter.mock.calls.find(([waiter]) => typeof waiter === "function")?.[0];
    expect(stopWaiter).toBeTypeOf("function");
    stopWaiter();
    await expect(cycle).resolves.toEqual({
      reconnect: false,
      reason: "stopped",
    });
  });

  it("reconnects when upsert ingestion fails before shutdown", async () => {
    const options = createCycleOptions();
    options.requests.enqueueRequest.mockRejectedValue(new Error("queue unavailable"));

    const cycle = waitForWhatsAppSocketCycle(options);
    await Promise.resolve();

    const upsertHandler = readHandler<(update: {type: "notify"; messages: WAMessage[]}) => void>(
      options.socket,
      "messages.upsert",
    );
    upsertHandler({
      type: "notify",
      messages: [createPrivateMessage()],
    });

    await expect(cycle).resolves.toEqual({
      reconnect: true,
      reason: "upsert_error",
    });
    expect(options.logs).toContainEqual({
      event: "upsert_error",
      payload: {
        connectorKey: "main",
        message: "queue unavailable",
      },
    });
  });
});
