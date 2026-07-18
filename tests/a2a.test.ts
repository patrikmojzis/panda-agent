import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, describe, expect, it, vi} from "vitest";
import {DataType, newDb} from "pg-mem";

import {A2ASessionBindingRepo} from "../src/domain/a2a/repo.js";
import {A2AMessagingService} from "../src/domain/a2a/service.js";
import {FileSystemMediaStore, PostgresOutboundDeliveryStore,} from "../src/domain/channels/index.js";
import {stringToUserMessage} from "../src/kernel/agent/index.js";
import {buildA2AInboundPersistence, buildA2AInboundText} from "../src/integrations/channels/a2a/helpers.js";
import {
  createA2AOutboundAdapter,
  type CreateA2AOutboundAdapterOptions,
} from "../src/integrations/channels/a2a/outbound.js";
import {handleA2AMessageRequest} from "../src/integrations/channels/a2a/request-handler.js";
import type {SessionRecord} from "../src/domain/sessions/index.js";
import {createRuntimeStores} from "./helpers/runtime-store-setup.js";
import {FileSystemCommandUploadStore} from "../src/integrations/commands/file-uploads.js";

function createDisposableSenderEnvironment(id = "worker:session-a") {
  return {
    id,
    kind: "disposable_container" as const,
    envDir: "worker-a",
    parentRunnerPaths: {
      root: "/environments/worker-a",
      workspace: "/environments/worker-a/workspace",
      inbox: "/environments/worker-a/inbox",
      artifacts: "/environments/worker-a/artifacts",
    },
    workerPaths: {
      workspace: "/workspace",
      inbox: "/inbox",
      artifacts: "/artifacts",
    },
  };
}

describe("A2ASessionBindingRepo", () => {
  const pools: Array<{ end(): Promise<void> }> = [];

  afterEach(async () => {
    while (pools.length > 0) {
      const pool = pools.pop();
      if (pool) {
        await pool.end();
      }
    }
  });

  it("stores bindings and counts recent session-to-session messages", async () => {
    const db = newDb();
    db.public.registerFunction({
      name: "pg_notify",
      args: [DataType.text, DataType.text],
      returns: DataType.text,
      implementation: () => "",
    });
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);

    const {agentStore, sessionStore, threadStore} = await createRuntimeStores(pool);
    await agentStore.bootstrapAgent({
      agentKey: "koala",
      displayName: "Koala",
    });

    await sessionStore.createSession({
      id: "session-a",
      agentKey: "panda",
      kind: "main",
      currentThreadId: "thread-a",
    });
    await sessionStore.createSession({
      id: "session-b",
      agentKey: "koala",
      kind: "main",
      currentThreadId: "thread-b",
    });
    await sessionStore.createSession({
      id: "session-c",
      agentKey: "koala",
      kind: "branch",
      currentThreadId: "thread-c",
    });
    await threadStore.getThread("thread-a").catch(() => threadStore.createThread({
      id: "thread-a",
      sessionId: "session-a",
    }));
    await threadStore.getThread("thread-b").catch(() => threadStore.createThread({
      id: "thread-b",
      sessionId: "session-b",
    }));
    await threadStore.getThread("thread-c").catch(() => threadStore.createThread({
      id: "thread-c",
      sessionId: "session-c",
    }));

    const bindings = new A2ASessionBindingRepo({pool});
    const deliveries = new PostgresOutboundDeliveryStore({pool});
    await bindings.ensureSchema();
    await deliveries.ensureSchema();

    await bindings.bindSession({
      senderSessionId: "session-a",
      recipientSessionId: "session-b",
    });

    expect(await bindings.hasBinding({
      senderSessionId: "session-a",
      recipientSessionId: "session-b",
    })).toBe(true);
    await expect(bindings.listBindings()).resolves.toMatchObject([
      {
        senderSessionId: "session-a",
        recipientSessionId: "session-b",
      },
    ]);

    await deliveries.enqueueDelivery({
      threadId: "thread-a",
      channel: "a2a",
      target: {
        source: "a2a",
        connectorKey: "local",
        externalConversationId: "session-b",
        externalActorId: "koala",
      },
      items: [{type: "text", text: "hello"}],
      metadata: {
        a2a: {
          messageId: "a2a:1",
        },
      },
    });
    await deliveries.enqueueDelivery({
      threadId: "thread-a",
      channel: "a2a",
      target: {
        source: "a2a",
        connectorKey: "local",
        externalConversationId: "session-c",
        externalActorId: "koala",
      },
      items: [{type: "text", text: "branch hello"}],
    });
    await deliveries.enqueueDelivery({
      threadId: "thread-a",
      channel: "telegram",
      target: {
        source: "telegram",
        connectorKey: "bot-main",
        externalConversationId: "chat-1",
      },
      items: [{type: "text", text: "not a2a"}],
    });

    await expect(bindings.countRecentMessages({
      senderSessionId: "session-a",
      recipientSessionId: "session-b",
      since: Date.now() - 60_000,
    })).resolves.toBe(1);
  });

  it("inspects and lists A2A deliveries scoped to the current session", async () => {
    const db = newDb();
    db.public.registerFunction({
      name: "pg_notify",
      args: [DataType.text, DataType.text],
      returns: DataType.text,
      implementation: () => "",
    });
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);

    const {agentStore, sessionStore, threadStore} = await createRuntimeStores(pool);
    await agentStore.bootstrapAgent({
      agentKey: "koala",
      displayName: "Koala",
    });
    await agentStore.bootstrapAgent({
      agentKey: "otter",
      displayName: "Otter",
    });

    await sessionStore.createSession({
      id: "session-a",
      agentKey: "panda",
      kind: "main",
      currentThreadId: "thread-a",
    });
    await sessionStore.createSession({
      id: "session-b",
      agentKey: "koala",
      kind: "main",
      currentThreadId: "thread-b",
    });
    await sessionStore.createSession({
      id: "session-c",
      agentKey: "otter",
      kind: "main",
      currentThreadId: "thread-c",
    });
    await threadStore.createThread({
      id: "thread-a",
      sessionId: "session-a",
    });
    await threadStore.createThread({
      id: "thread-b",
      sessionId: "session-b",
    });
    await threadStore.createThread({
      id: "thread-c",
      sessionId: "session-c",
    });

    const bindings = new A2ASessionBindingRepo({pool});
    const deliveries = new PostgresOutboundDeliveryStore({pool});
    await bindings.ensureSchema();
    await deliveries.ensureSchema();

    const outbound = await deliveries.enqueueDelivery({
      threadId: "thread-a",
      channel: "a2a",
      target: {
        source: "a2a",
        connectorKey: "local",
        externalConversationId: "session-b",
        externalActorId: "koala",
      },
      items: [
        {type: "text", text: "hello from panda"},
        {type: "file", path: "/workspace/report.md", filename: "report.md"},
      ],
      metadata: {
        a2a: {
          messageId: "a2a:outbound",
          fromAgentKey: "panda",
          fromSessionId: "session-a",
          fromThreadId: "thread-a",
          fromRunId: "run-a",
          toAgentKey: "koala",
          toSessionId: "session-b",
          sentAt: Date.parse("2026-06-24T12:00:00.000Z"),
        },
      },
    });
    await deliveries.markDeliverySent({
      id: outbound.id,
      sent: [
        {type: "text", externalMessageId: "a2a:outbound"},
        {type: "file", externalMessageId: "a2a:outbound"},
      ],
    });
    await deliveries.enqueueDelivery({
      threadId: "thread-c",
      channel: "a2a",
      target: {
        source: "a2a",
        connectorKey: "local",
        externalConversationId: "session-b",
        externalActorId: "koala",
      },
      items: [{type: "text", text: "not visible"}],
      metadata: {
        a2a: {
          messageId: "a2a:hidden",
          fromAgentKey: "otter",
          fromSessionId: "session-c",
          fromThreadId: "thread-c",
          toAgentKey: "koala",
          toSessionId: "session-b",
          sentAt: Date.parse("2026-06-24T12:01:00.000Z"),
        },
      },
    });

    await expect(bindings.getA2ADelivery({
      sessionId: "session-a",
      deliveryId: outbound.id,
    })).resolves.toMatchObject({
      deliveryId: outbound.id,
      messageId: "a2a:outbound",
      direction: "outbound",
      status: "sent",
      fromSessionId: "session-a",
      toSessionId: "session-b",
      itemCount: 2,
      items: [
        {type: "text", textPreview: "hello from panda"},
        {type: "file", path: "/workspace/report.md", filename: "report.md"},
      ],
      sentItems: [
        {type: "text", externalMessageId: "a2a:outbound"},
        {type: "file", externalMessageId: "a2a:outbound"},
      ],
    });
    await expect(bindings.getA2ADelivery({
      sessionId: "session-c",
      deliveryId: outbound.id,
    })).resolves.toBeNull();
    await expect(bindings.listA2ADeliveries({
      sessionId: "session-a",
      peerSessionId: "session-b",
      direction: "outbound",
      limit: 10,
    })).resolves.toMatchObject([
      {
        deliveryId: outbound.id,
        direction: "outbound",
      },
    ]);
  });

  it("rejects malformed persisted session binding rows", async () => {
    const now = new Date();
    const bindings = new A2ASessionBindingRepo({
      pool: {
        connect: vi.fn(),
        query: vi.fn(async () => ({
          rows: [{
            sender_session_id: " ",
            recipient_session_id: "session-b",
            created_at: now,
            updated_at: now,
          }],
        })),
      },
    });

    await expect(bindings.listBindings()).rejects.toThrow("A2A sender session id must not be empty.");
  });

  it("rejects malformed persisted A2A delivery counts", async () => {
    const bindings = new A2ASessionBindingRepo({
      pool: {
        connect: vi.fn(),
        query: vi.fn(async () => ({
          rows: [{count: "unknown"}],
        })),
      },
    });

    await expect(bindings.countRecentMessages({
      senderSessionId: "session-a",
      recipientSessionId: "session-b",
      since: Date.now() - 60_000,
    })).rejects.toThrow("A2A recent message count must be a non-negative integer.");
  });

  it("rejects driver-shaped persisted A2A delivery counts", async () => {
    const bindings = new A2ASessionBindingRepo({
      pool: {
        connect: vi.fn(),
        query: vi.fn(async () => ({
          rows: [{count: "1"}],
        })),
      },
    });

    await expect(bindings.countRecentMessages({
      senderSessionId: "session-a",
      recipientSessionId: "session-b",
      since: Date.now() - 60_000,
    })).rejects.toThrow("A2A recent message count must be a non-negative integer.");
  });

  it("dedupes received A2A message ids across session resets", async () => {
    const db = newDb();
    db.public.registerFunction({
      name: "pg_notify",
      args: [DataType.text, DataType.text],
      returns: DataType.text,
      implementation: () => "",
    });
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);

    const {agentStore, sessionStore, threadStore} = await createRuntimeStores(pool);
    await agentStore.bootstrapAgent({
      agentKey: "koala",
      displayName: "Koala",
    });

    await sessionStore.createSession({
      id: "session-a",
      agentKey: "panda",
      kind: "main",
      currentThreadId: "thread-a",
    });
    await sessionStore.createSession({
      id: "session-b",
      agentKey: "koala",
      kind: "main",
      currentThreadId: "thread-b",
    });
    await threadStore.getThread("thread-a").catch(() => threadStore.createThread({
      id: "thread-a",
      sessionId: "session-a",
    }));
    await threadStore.getThread("thread-b").catch(() => threadStore.createThread({
      id: "thread-b",
      sessionId: "session-b",
    }));

    const bindings = new A2ASessionBindingRepo({pool});
    await bindings.ensureSchema();
    await threadStore.enqueueInput("thread-b", {
      source: "a2a",
      channelId: "session-a",
      externalMessageId: "a2a:dedupe",
      actorId: "panda",
      message: stringToUserMessage("hello"),
    });
    await threadStore.createThread({
      id: "thread-b-reset",
      sessionId: "session-b",
    });
    await sessionStore.updateCurrentThread({
      sessionId: "session-b",
      currentThreadId: "thread-b-reset",
    });

    await expect(bindings.hasReceivedMessage({
      recipientSessionId: "session-b",
      senderSessionId: "session-a",
      messageId: "a2a:dedupe",
    })).resolves.toBe(true);
  });
});

describe("A2AMessagingService", () => {
  it("resolves a main session target and queues A2A delivery metadata", async () => {
    const enqueueDelivery = vi.fn(async (input) => ({
      id: "delivery-1",
      status: "pending",
      attemptCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...input,
    }));
    const service = new A2AMessagingService({
      bindings: {
        hasBinding: vi.fn(async () => true),
        countRecentMessages: vi.fn(async () => 0),
      },
      outboundDeliveries: {
        enqueueDelivery,
      },
      sessions: {
        getSession: vi.fn(async () => {
          throw new Error("getSession should not be used for agent-targeted A2A.");
        }),
        getMainSession: vi.fn(async (agentKey: string) => ({
          id: "session-b",
          agentKey,
          kind: "main",
          currentThreadId: "thread-b",
          createdAt: 0,
          updatedAt: 0,
        })),
      },
    });

    const result = await service.queueMessage({
      senderAgentKey: "panda",
      senderSessionId: "session-a",
      senderThreadId: "thread-a",
      senderRunId: "run-a",
      agentKey: "koala",
      senderEnvironment: createDisposableSenderEnvironment(),
      items: [{type: "text", text: "hello"}],
    });

    expect(enqueueDelivery).toHaveBeenCalledWith({
      threadId: "thread-a",
      channel: "a2a",
      target: {
        source: "a2a",
        connectorKey: "local",
        externalConversationId: "session-b",
        externalActorId: "koala",
      },
      items: [{type: "text", text: "hello"}],
      metadata: {
        a2a: {
          messageId: expect.stringMatching(/^a2a:/),
          fromAgentKey: "panda",
          fromSessionId: "session-a",
          fromThreadId: "thread-a",
          fromRunId: "run-a",
          toAgentKey: "koala",
          toSessionId: "session-b",
          sentAt: expect.any(Number),
          senderEnvironment: createDisposableSenderEnvironment(),
        },
      },
    });
    expect(result).toMatchObject({
      delivery: {id: "delivery-1"},
      targetAgentKey: "koala",
      targetSessionId: "session-b",
      messageId: expect.stringMatching(/^a2a:/),
    });
  });

  it("blocks same-session sends and rate-limit overruns", async () => {
    const getSession = vi.fn(async () => ({
      id: "session-a",
      agentKey: "panda",
      kind: "main" as const,
      currentThreadId: "thread-a",
      createdAt: 0,
      updatedAt: 0,
    }));
    const service = new A2AMessagingService({
      bindings: {
        hasBinding: vi.fn(async () => true),
        countRecentMessages: vi.fn(async () => 1),
      },
      outboundDeliveries: {
        enqueueDelivery: vi.fn(),
      },
      sessions: {
        getMainSession: vi.fn(async () => {
          throw new Error("getMainSession should not be used for session-targeted A2A.");
        }),
        getSession,
      },
      maxMessagesPerHour: 1,
    });

    await expect(service.queueMessage({
      senderAgentKey: "panda",
      senderSessionId: "session-a",
      senderThreadId: "thread-a",
      sessionId: "session-a",
      items: [{type: "text", text: "self"}],
    })).rejects.toThrow("a2a.send does not allow sending to the same session.");

    getSession.mockResolvedValueOnce({
      id: "session-b",
      agentKey: "koala",
      kind: "main",
      currentThreadId: "thread-b",
      createdAt: 0,
      updatedAt: 0,
    });

    await expect(service.queueMessage({
      senderAgentKey: "panda",
      senderSessionId: "session-a",
      senderThreadId: "thread-a",
      sessionId: "session-b",
      items: [{type: "text", text: "too many"}],
    })).rejects.toThrow("A2A rate limit reached for session-a -> session-b (1/hour).");
  });

  it("rejects non-JSON sender environment metadata before queueing", async () => {
    const enqueueDelivery = vi.fn();
    const service = new A2AMessagingService({
      bindings: {
        hasBinding: vi.fn(async () => true),
        countRecentMessages: vi.fn(async () => 0),
      },
      outboundDeliveries: {
        enqueueDelivery,
      },
      sessions: {
        getSession: vi.fn(async () => {
          throw new Error("getSession should not be used for agent-targeted A2A.");
        }),
        getMainSession: vi.fn(async (agentKey: string) => ({
          id: "session-b",
          agentKey,
          kind: "main",
          currentThreadId: "thread-b",
          createdAt: 0,
          updatedAt: 0,
        })),
      },
    });

    await expect(service.queueMessage({
      senderAgentKey: "panda",
      senderSessionId: "session-a",
      senderThreadId: "thread-a",
      agentKey: "koala",
      senderEnvironment: {
        ...createDisposableSenderEnvironment(),
        parentRunnerPaths: {
          root: Number.NaN,
        },
      } as unknown as ReturnType<typeof createDisposableSenderEnvironment>,
      items: [{type: "text", text: "hello"}],
    })).rejects.toThrow("A2A sender environment metadata must be JSON-safe.");

    expect(enqueueDelivery).not.toHaveBeenCalled();
  });
});

describe("createA2AOutboundAdapter", () => {
  const directories = new Set<string>();

  afterEach(async () => {
    for (const directory of directories) {
      await rm(directory, {recursive: true, force: true});
    }
    directories.clear();
  });

  it("copies attachments into receiver media storage and enqueues an inbound request", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "panda-a2a-outbound-"));
    const receiverDir = path.join(tempDir, "receiver-media");
    directories.add(tempDir);

    const imagePath = path.join(tempDir, "photo.png");
    const filePath = path.join(tempDir, "report.txt");
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(filePath, "hi from panda", "utf8");
    const commandUploads = new FileSystemCommandUploadStore({
      env: {...process.env, DATA_DIR: path.join(tempDir, "sender-data")},
    });
    const sender = {agentKey: "panda", sessionId: "session-a"};
    const imageUpload = await commandUploads.stage({
      scope: sender,
      filename: "photo.png",
      mimeType: "image/png",
      chunks: (async function* () { yield await readFile(imagePath); })(),
    });
    const fileUpload = await commandUploads.stage({
      scope: sender,
      filename: "report.txt",
      mimeType: "text/plain",
      chunks: (async function* () { yield await readFile(filePath); })(),
    });
    const imageCopyUpload = await commandUploads.stage({
      scope: sender,
      filename: "photo-copy.png",
      mimeType: "image/png",
      chunks: (async function* () { yield await readFile(imagePath); })(),
    });
    await rm(imagePath);
    await rm(filePath);

    const enqueueRequest: CreateA2AOutboundAdapterOptions["requests"]["enqueueRequest"] = vi.fn(async (input) => ({
      id: "request-1",
      kind: input.kind,
      status: "pending",
      payload: input.payload,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }));
    const sessionStore: CreateA2AOutboundAdapterOptions["sessionStore"] = {
      getSession: vi.fn(async () => ({
        id: "session-b",
        agentKey: "koala",
        kind: "main",
        currentThreadId: "thread-b",
        createdAt: 0,
        updatedAt: 0,
      })),
    };
    const adapter = createA2AOutboundAdapter({
      requests: {
        enqueueRequest,
      },
      sessionStore,
      createMediaStore: (rootDir) => new FileSystemMediaStore({
        rootDir,
        now: () => new Date("2026-04-08T12:00:00.000Z"),
      }),
      resolveAgentMediaDir: () => receiverDir,
      commandUploads,
    });

    const result = await adapter.send({
      channel: "a2a",
      target: {
        source: "a2a",
        connectorKey: "local",
        externalConversationId: "session-b",
        externalActorId: "koala",
      },
      items: [
        {type: "text", text: "hello"},
        {type: "file", ...imageUpload, caption: "photo"},
        {type: "file", ...fileUpload, caption: "report"},
        {type: "file", ...imageCopyUpload, caption: "photo file"},
      ],
      metadata: {
        a2a: {
          messageId: "a2a:123",
          fromAgentKey: "panda",
          fromSessionId: "session-a",
          fromThreadId: "thread-a",
          toAgentKey: "koala",
          toSessionId: "session-b",
          sentAt: 1234567890,
          senderEnvironment: createDisposableSenderEnvironment(),
        },
      },
    });

    const payload = vi.mocked(enqueueRequest).mock.calls[0]?.[0]?.payload;
    expect(vi.mocked(enqueueRequest)).toHaveBeenCalledWith({
      kind: "a2a_message",
      payload: expect.objectContaining({
        externalMessageId: "a2a:123",
        fromAgentKey: "panda",
        fromSessionId: "session-a",
        toAgentKey: "koala",
        toSessionId: "session-b",
        senderEnvironment: createDisposableSenderEnvironment(),
      }),
    });
    expect(payload).not.toHaveProperty("externalConversationId");
    expect(payload).not.toHaveProperty("externalActorId");
    expect(payload.items[0]).toEqual({
      type: "text",
      text: "hello",
    });
    expect(payload.items[1]).toMatchObject({
      type: "file",
      caption: "photo",
      filename: "photo.png",
      media: {
        source: "a2a",
        connectorKey: "local",
        mimeType: "image/png",
      },
    });
    expect(payload.items[2]).toMatchObject({
      type: "file",
      caption: "report",
      filename: "report.txt",
      mimeType: "text/plain",
      media: {
        source: "a2a",
        connectorKey: "local",
        mimeType: "text/plain",
      },
    });
    expect(payload.items[3]).toMatchObject({
      type: "file",
      caption: "photo file",
      filename: "photo-copy.png",
      media: {
        source: "a2a",
        connectorKey: "local",
        mimeType: "image/png",
      },
    });
    expect(payload.items[1].media.localPath.startsWith(receiverDir)).toBe(true);
    expect(payload.items[2].media.localPath.startsWith(receiverDir)).toBe(true);
    expect(payload.items[3].media.localPath.startsWith(receiverDir)).toBe(true);
    await expect(readFile(payload.items[1].media.localPath)).resolves.toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await expect(readFile(payload.items[2].media.localPath, "utf8")).resolves.toBe("hi from panda");
    await expect(readFile(payload.items[3].media.localPath)).resolves.toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(result).toEqual({
      ok: true,
      channel: "a2a",
      target: {
        source: "a2a",
        connectorKey: "local",
        externalConversationId: "session-b",
        externalActorId: "koala",
      },
      sent: [
        {type: "text", externalMessageId: "a2a:123"},
        {type: "file", externalMessageId: "a2a:123"},
        {type: "file", externalMessageId: "a2a:123"},
        {type: "file", externalMessageId: "a2a:123"},
      ],
    });
    await expect(commandUploads.resolve(sender, fileUpload.uploadRef)).rejects.toThrow("unknown or not available");
  });

  it("cleans staged uploads only after a delivery becomes terminal", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "panda-a2a-terminal-"));
    directories.add(tempDir);
    const commandUploads = new FileSystemCommandUploadStore({
      env: {...process.env, DATA_DIR: path.join(tempDir, "sender-data")},
    });
    const sender = {agentKey: "panda", sessionId: "session-a"};
    const upload = await commandUploads.stage({
      scope: sender,
      filename: "retry-source.txt",
      mimeType: "text/plain",
      chunks: (async function* () { yield Buffer.from("retry me"); })(),
    });
    const adapter = createA2AOutboundAdapter({
      requests: {enqueueRequest: vi.fn()},
      sessionStore: {getSession: vi.fn()},
      createMediaStore: (rootDir) => new FileSystemMediaStore({rootDir}),
      resolveAgentMediaDir: () => path.join(tempDir, "receiver-media"),
      commandUploads,
    });
    const request = {
      channel: "a2a",
      target: {
        source: "a2a",
        connectorKey: "local",
        externalConversationId: "session-b",
      },
      items: [{type: "file" as const, ...upload}],
      metadata: {
        a2a: {
          messageId: "a2a:terminal",
          fromAgentKey: "panda",
          fromSessionId: "session-a",
          fromThreadId: "thread-a",
          toAgentKey: "koala",
          toSessionId: "session-b",
          sentAt: 1,
        },
      },
    };

    await expect(commandUploads.resolve(sender, upload.uploadRef)).resolves.toMatchObject({
      uploadRef: upload.uploadRef,
    });
    await adapter.onTerminalFailure?.(request);
    await expect(commandUploads.resolve(sender, upload.uploadRef)).rejects.toThrow("unknown or not available");
  });
});

describe("handleA2AMessageRequest", () => {
  it("delivers inbound messages to the recipient session current thread", async () => {
    const recipient: SessionRecord = {
      id: "session-b",
      agentKey: "koala",
      kind: "main",
      currentThreadId: "thread-before-reset",
      createdAt: 0,
      updatedAt: 0,
    };
    const submitInput = vi.fn(async () => undefined);

    const result = await handleA2AMessageRequest({
      connectorKey: "local",
      externalMessageId: "a2a:after-reset",
      fromAgentKey: "panda",
      fromSessionId: "session-a",
      fromThreadId: "thread-a",
      toAgentKey: "koala",
      toSessionId: "session-b",
      sentAt: 1234567890,
      items: [{type: "text", text: "hello after reset"}],
    }, {
      bindings: {
        hasBinding: async () => true,
        hasReceivedMessage: async () => {
          recipient.currentThreadId = "thread-after-reset";
          return false;
        },
      },
      coordinator: {submitInput},
      sessions: {
        getSession: async (sessionId) => {
          expect(sessionId).toBe("session-b");
          return recipient;
        },
      },
    });

    expect(result).toEqual({
      status: "queued",
      threadId: "thread-after-reset",
    });
    expect(submitInput).toHaveBeenCalledWith("thread-after-reset", expect.objectContaining({
      source: "a2a",
      channelId: "session-a",
      externalMessageId: "a2a:after-reset",
      actorId: "panda",
    }));
  });
});

describe("buildA2AInboundPersistence", () => {
  it("persists only A2A-specific metadata and keeps the message id", () => {
    const persistence = buildA2AInboundPersistence({
      connectorKey: "local",
      externalMessageId: "a2a:123",
      fromAgentKey: "panda",
      fromSessionId: "session-a",
      fromThreadId: "thread-a",
      toAgentKey: "koala",
      toSessionId: "session-b",
      sentAt: 1234567890,
      items: [{type: "text", text: "hello"}],
    });

    expect(persistence).toEqual({
      metadata: {
        a2a: {
          source: "a2a",
          connectorKey: "local",
          messageId: "a2a:123",
          fromAgentKey: "panda",
          fromSessionId: "session-a",
          fromThreadId: "thread-a",
          fromRunId: null,
          toAgentKey: "koala",
          toSessionId: "session-b",
          sentAt: 1234567890,
          items: [{type: "text", text: "hello"}],
        },
      },
    });
  });

  it("renders disposable sender paths for the receiver without core path leaks", () => {
    const text = buildA2AInboundText({
      connectorKey: "local",
      externalMessageId: "a2a:worker-done",
      fromAgentKey: "panda",
      fromSessionId: "worker-session",
      fromThreadId: "worker-thread",
      toAgentKey: "panda",
      toSessionId: "parent-session",
      sentAt: 1234567890,
      senderEnvironment: createDisposableSenderEnvironment("worker:worker-session"),
      items: [{type: "text", text: "status: done\nsummary: ready for review"}],
    });

    expect(text).toContain("sender_environment:");
    expect(text).toContain("- parent_workspace_path: /environments/worker-a/workspace");
    expect(text).toContain("- parent_artifacts_path: /environments/worker-a/artifacts");
    expect(text).toContain("- subagent_artifacts_path: /artifacts");
    expect(text).toContain("status: done");
    expect(text).not.toContain("/root/.panda");
  });
});
