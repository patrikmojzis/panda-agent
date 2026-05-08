import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, describe, expect, it, vi} from "vitest";
import {DataType, newDb} from "pg-mem";

import {DEFAULT_AGENT_PROMPT_TEMPLATES} from "../src/domain/agents/index.js";
import {A2ASessionBindingRepo} from "../src/domain/a2a/index.js";
import {A2AMessagingService} from "../src/domain/a2a/service.js";
import {FileSystemMediaStore, PostgresOutboundDeliveryStore,} from "../src/domain/channels/index.js";
import {stringToUserMessage} from "../src/kernel/agent/index.js";
import {buildA2AInboundPersistence, buildA2AInboundText} from "../src/integrations/channels/a2a/helpers.js";
import {createA2AOutboundAdapter} from "../src/integrations/channels/a2a/outbound.js";
import {createRuntimeStores} from "./helpers/runtime-store-setup.js";

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
      prompts: DEFAULT_AGENT_PROMPT_TEMPLATES,
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
      prompts: DEFAULT_AGENT_PROMPT_TEMPLATES,
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
      } as unknown as A2ASessionBindingRepo,
      outboundDeliveries: {
        enqueueDelivery,
      },
      sessions: {
        getMainSession: vi.fn(async (agentKey: string) => ({
          id: "session-b",
          agentKey,
          kind: "main",
          currentThreadId: "thread-b",
          createdAt: 0,
          updatedAt: 0,
        })),
      } as any,
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
    const service = new A2AMessagingService({
      bindings: {
        hasBinding: vi.fn(async () => true),
        countRecentMessages: vi.fn(async () => 1),
      } as unknown as A2ASessionBindingRepo,
      outboundDeliveries: {
        enqueueDelivery: vi.fn(),
      },
      sessions: {
        getSession: vi.fn(async () => ({
          id: "session-a",
          agentKey: "panda",
          kind: "main",
          currentThreadId: "thread-a",
          createdAt: 0,
          updatedAt: 0,
        })),
      } as any,
      maxMessagesPerHour: 1,
    });

    await expect(service.queueMessage({
      senderAgentKey: "panda",
      senderSessionId: "session-a",
      senderThreadId: "thread-a",
      sessionId: "session-a",
      items: [{type: "text", text: "self"}],
    })).rejects.toThrow("message_agent does not allow sending to the same session.");

    vi.mocked((service as any).sessions.getSession).mockResolvedValueOnce({
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

    const enqueueRequest = vi.fn(async (input) => ({
      id: "request-1",
      kind: input.kind,
      status: "pending",
      payload: input.payload,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }));
    const adapter = createA2AOutboundAdapter({
      requests: {
        enqueueRequest,
      } as any,
      sessionStore: {
        getSession: vi.fn(async () => ({
          id: "session-b",
          agentKey: "koala",
          kind: "main",
          currentThreadId: "thread-b",
          createdAt: 0,
          updatedAt: 0,
        })),
      } as any,
      createMediaStore: (rootDir) => new FileSystemMediaStore({
        rootDir,
        now: () => new Date("2026-04-08T12:00:00.000Z"),
      }),
      resolveAgentMediaDir: () => receiverDir,
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
        {type: "image", path: imagePath, caption: "photo"},
        {type: "file", path: filePath, filename: "report.txt", mimeType: "text/plain", caption: "report"},
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
      type: "image",
      caption: "photo",
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
    expect(payload.items[1].media.localPath.startsWith(receiverDir)).toBe(true);
    expect(payload.items[2].media.localPath.startsWith(receiverDir)).toBe(true);
    await expect(readFile(payload.items[1].media.localPath)).resolves.toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await expect(readFile(payload.items[2].media.localPath, "utf8")).resolves.toBe("hi from panda");
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
        {type: "image", externalMessageId: "a2a:123"},
        {type: "file", externalMessageId: "a2a:123"},
      ],
    });
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
    expect(text).toContain("- worker_artifacts_path: /artifacts");
    expect(text).toContain("status: done");
    expect(text).not.toContain("/root/.panda");
  });
});
