import * as fs from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {describe, expect, it, vi} from "vitest";

import {
  createDaemonRequestProcessor,
  type DaemonRequestProcessorContext,
  type DaemonRequestThreadHelpers,
} from "../src/app/runtime/daemon-requests.js";
import {
  discardSettledRuntimeRequestMedia,
  resolveRuntimeRequestMediaReceiptOwners,
} from "../src/app/runtime/runtime-request-media.js";
import type {IdentityBindingRecord, IdentityRecord} from "../src/domain/identity/index.js";
import type {SessionRecord} from "../src/domain/sessions/index.js";
import type {ThreadRecord} from "../src/domain/threads/runtime/index.js";
import {ThreadInputAdmissionBlockedError} from "../src/domain/threads/runtime/store.js";
import type {
  A2AMessageRequestPayload,
  DiscordMessageRequestPayload,
  RuntimeRequestRepo,
  RuntimeRequestRecord,
  TelegramMessageRequestPayload,
  TuiInputRequestPayload,
  WhatsAppReactionRequestPayload,
} from "../src/domain/threads/requests/index.js";
import {TestThreadRuntimeStore} from "./helpers/test-runtime-store.js";
import {stringToUserMessage} from "../src/kernel/agent/helpers/input.js";
import {RetryableRuntimeRequestError} from "../src/domain/threads/requests/errors.js";
import {FileSystemMediaStore, relocateMediaDescriptor} from "../src/domain/channels/media-store.js";

function whatsappReactionRequest(
  overrides: Partial<WhatsAppReactionRequestPayload> = {},
): RuntimeRequestRecord<"whatsapp_reaction"> {
  return {
    id: "request-1",
    kind: "whatsapp_reaction",
    status: "pending",
    executionAttempts: 1,
    createdAt: 1,
    updatedAt: 1,
    payload: {
      connectorKey: "main",
      externalConversationId: "421900000000@s.whatsapp.net",
      externalActorId: "421900000000@s.whatsapp.net",
      externalMessageId: "reaction-1",
      remoteJid: "421900000000@s.whatsapp.net",
      chatType: "private",
      targetMessageId: "target-1",
      emoji: "👍",
      pushName: "Patrik",
      ...overrides,
    },
  };
}

function telegramMessageRequest(
  overrides: Partial<TelegramMessageRequestPayload> = {},
): RuntimeRequestRecord<"telegram_message"> {
  return {
    id: "request-telegram",
    kind: "telegram_message",
    status: "pending",
    executionAttempts: 1,
    createdAt: 1,
    updatedAt: 1,
    payload: {
      connectorKey: "main",
      botUsername: "panda_bot",
      externalConversationId: "777",
      chatId: "777",
      chatType: "private",
      externalActorId: "123",
      externalMessageId: "555",
      text: "hello from telegram",
      username: "patrik",
      firstName: "Patrik",
      media: [],
      ...overrides,
    },
  };
}

function discordMessageRequest(
  overrides: Partial<DiscordMessageRequestPayload> = {},
): RuntimeRequestRecord<"discord_message"> {
  return {
    id: "request-discord",
    kind: "discord_message",
    status: "pending",
    executionAttempts: 1,
    createdAt: 1,
    updatedAt: 1,
    payload: {
      connectorKey: "bot-1",
      externalConversationId: "channel-1",
      externalActorId: "user-1",
      externalMessageId: "message-1",
      actualChannelId: "channel-1",
      text: "hello from discord",
      authorUsername: "patrik",
      authorDisplayName: "Patrik Display",
      attachmentSummaries: [],
      embedSummaries: [],
      stickerSummaries: [],
      media: [],
      ...overrides,
    },
  };
}

function tuiInputRequest(
  overrides: Partial<TuiInputRequestPayload> = {},
): RuntimeRequestRecord<"tui_input"> {
  return {
    id: "request-tui",
    kind: "tui_input",
    status: "pending",
    executionAttempts: 1,
    createdAt: 1,
    updatedAt: 1,
    payload: {
      identityId: "identity-1",
      threadId: "thread-1",
      actorId: "terminal-user",
      externalMessageId: "tui-1",
      identityHandle: "patrik",
      text: "hello from tui",
      ...overrides,
    },
  };
}

function createIdentity(): IdentityRecord {
  return {
    id: "identity-1",
    handle: "patrik",
    displayName: "Patrik",
    status: "active",
    createdAt: 1,
    updatedAt: 1,
  };
}

function createIdentityBinding(identityId = "identity-1"): IdentityBindingRecord {
  return {
    id: "binding-1",
    source: "test",
    connectorKey: "main",
    externalActorId: "actor-1",
    identityId,
    createdAt: 1,
    updatedAt: 1,
  };
}

function createSession(sessionId: string, currentThreadId: string, agentKey = "panda"): SessionRecord {
  return {
    id: sessionId,
    agentKey,
    kind: "main",
    currentThreadId,
    createdAt: 1,
    updatedAt: 1,
  };
}

function createCoordinator(
  submitInput = vi.fn(async () => {}),
  getSession = vi.fn(async (sessionId: string) => createSession(sessionId, "thread-1")),
): DaemonRequestProcessorContext["runtime"]["coordinator"] {
  return {
    abort: vi.fn(async () => true),
    resolveThreadRunConfig: vi.fn(async () => ({
      model: "openai/gpt-5.1",
    })),
    runExclusively: vi.fn(async (_threadId, operation) => operation()),
    submitInput,
    submitSessionInput: vi.fn(async (sessionId, payload, mode = "wake", options) => {
      const session = await getSession(sessionId);
      await submitInput(session.currentThreadId, payload);
      return {
        input: {
          id: options?.inputId ?? "input-1",
          threadId: session.currentThreadId,
          order: 1,
          deliveryMode: mode,
          status: "pending" as const,
          connectorKey: "",
          source: payload.source,
          channelId: payload.channelId,
          externalMessageId: payload.externalMessageId,
          actorId: payload.actorId,
          identityId: payload.identityId,
          createdAt: 1,
        },
        disposition: "inserted" as const,
      };
    }),
  };
}

function createRequestContext(input: {
  binding?: IdentityBindingRecord | null;
  currentThreadId?: string;
  getSession?: (sessionId: string) => Promise<SessionRecord>;
  store?: TestThreadRuntimeStore;
  submitInput?: ReturnType<typeof vi.fn>;
} = {}): DaemonRequestProcessorContext {
  const currentThreadId = input.currentThreadId ?? "thread-1";
  const getSession = input.getSession ?? vi.fn(async (sessionId: string) => createSession(sessionId, currentThreadId));
  return {
    runtime: {
      coordinator: createCoordinator(input.submitInput, getSession),
      identityStore: {
        getIdentity: vi.fn(async () => createIdentity()),
        resolveIdentityBinding: vi.fn(async () => input.binding === undefined ? createIdentityBinding() : input.binding),
      },
      sessionStore: {
        getSession,
        getSessionRuntimeConfigOperation: vi.fn(async () => null),
        updateSessionRuntimeConfigOnce: vi.fn(async (_operationId, _threadId, update) => ({
          config: {
            sessionId: update.sessionId,
            thinkingConfigured: update.thinking !== undefined,
          },
          replayed: false,
        })),
      },
      sessionCompaction: {
        compactSession: vi.fn(async (sessionId: string) => ({
          compacted: true,
          sessionId,
          threadId: currentThreadId,
          tokensBefore: 100,
          tokensAfter: 40,
        })),
        compactThread: vi.fn(async (threadId: string) => ({
          compacted: true,
          sessionId: "session-1",
          threadId,
          tokensBefore: 100,
          tokensAfter: 40,
        })),
      },
      store: input.store ?? new TestThreadRuntimeStore(),
    },
    a2aBindings: {
      hasBinding: vi.fn(async () => true),
      hasReceivedMessage: vi.fn(async () => false),
    },
    liveVoice: {} as DaemonRequestProcessorContext["liveVoice"],
  };
}

function createThreadHelpers(overrides: Partial<DaemonRequestThreadHelpers> = {}): DaemonRequestThreadHelpers {
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected daemon thread helper call.");
  };
  return {
    createBranchSession: unexpected,
    createSubagentSession: unexpected,
    ensureIdentity: unexpected,
    handleResetSession: unexpected,
    findSystemReply: vi.fn(async () => null),
    openMainSession: unexpected,
    queueSystemReply: unexpected,
    reconcileResetSession: vi.fn(async () => null),
    relocateAgentMedia: vi.fn(async (_agentKey, media) => media),
    relocateThreadMedia: vi.fn(async (_thread, media) => media),
    resolveBoundConversationThread: unexpected,
    resolveOrCreateConversationThread: unexpected,
    ...overrides,
  };
}

function createHarness(options: {
  binding?: {identityId: string} | null;
  currentThreadId?: string;
  resetReplayed?: boolean;
  thread?: {id: string; sessionId: string} | null;
} = {}) {
  const binding = options.binding === undefined
    ? createIdentityBinding()
    : options.binding
      ? createIdentityBinding(options.binding.identityId)
      : null;
  const thread = options.thread === undefined ? {id: "thread-1", sessionId: "session-1"} : options.thread;
  const currentThreadId = options.currentThreadId ?? thread?.id ?? "thread-1";
  const submitInput = vi.fn(async () => {});
  const getSession = vi.fn(async (sessionId: string) => createSession(sessionId, currentThreadId));
  const resolveThread = async (): Promise<ThreadRecord | null> => {
    return thread
      ? {
        id: thread.id,
        sessionId: thread.sessionId,
        createdAt: 1,
        updatedAt: 1,
      }
      : null;
  };
  const resolveBoundConversationThread = vi.fn(resolveThread);
  const resolveOrCreateConversationThread = vi.fn(resolveThread);
  const queueSystemReply = vi.fn(async () => {});
  const handleResetSession = vi.fn(async () => ({
    threadId: "thread-reset",
    previousThreadId: "thread-before-reset",
    sessionId: "session-1",
    ...(options.resetReplayed ? {replayed: true} : {}),
  }));
  const context = createRequestContext({
    binding,
    currentThreadId,
    getSession,
    submitInput,
  });
  const threads = createThreadHelpers({
    resolveBoundConversationThread,
    resolveOrCreateConversationThread,
    queueSystemReply,
    handleResetSession,
  });

  return {
    context,
    getSession,
    handleResetSession,
    queueSystemReply,
    resolveBoundConversationThread,
    resolveOrCreateConversationThread,
    submitInput,
    threads,
  };
}

describe("daemon request processor", () => {
  it("routes session compaction through the session-targeted runtime service", async () => {
    const context = createRequestContext();
    const processor = createDaemonRequestProcessor(context, createThreadHelpers());

    await expect(processor({
      id: "request-compact-session",
      kind: "compact_session",
      status: "pending",
      createdAt: 1,
      updatedAt: 1,
      payload: {
        sessionId: "session-1",
        customInstructions: "Keep the incident timeline.",
      },
    })).resolves.toEqual({
      compacted: true,
      sessionId: "session-1",
      threadId: "thread-1",
      tokensBefore: 100,
      tokensAfter: 40,
    });

    expect(context.runtime.sessionCompaction.compactSession).toHaveBeenCalledWith(
      "session-1",
      "Keep the incident timeline.",
      "request-compact-session",
      undefined,
    );
  });

  it("routes TUI input through the terminal channel adapter", async () => {
    const store = new TestThreadRuntimeStore();
    await store.createThread({
      id: "thread-1",
      sessionId: "session-1",
    });
    const submitInput = vi.fn(async () => {});
    const getThread = vi.spyOn(store, "getThread");
    const context = createRequestContext({
      getSession: vi.fn(async (sessionId: string) => createSession(sessionId, "thread-1")),
      store,
      submitInput,
    });
    const processor = createDaemonRequestProcessor(context, createThreadHelpers());

    await expect(processor(tuiInputRequest())).resolves.toEqual({
      status: "queued",
      threadId: "thread-1",
    });

    expect(getThread).toHaveBeenCalledWith("thread-1");
    expect(submitInput).toHaveBeenCalledWith("thread-1", expect.objectContaining({
      source: "tui",
      channelId: "terminal",
      externalMessageId: "tui-1",
      actorId: "terminal-user",
      identityId: "identity-1",
      message: expect.objectContaining({
        content: expect.stringContaining("hello from tui"),
      }),
      metadata: expect.objectContaining({
        tui: expect.objectContaining({
          conversationId: "terminal",
          actorId: "terminal-user",
        }),
      }),
    }));
    expect(context.runtime.coordinator.submitSessionInput).toHaveBeenCalledWith(
      "session-1",
      expect.anything(),
      "wake",
      expect.objectContaining({
        rememberedRoute: expect.objectContaining({
          identityId: "identity-1",
          route: expect.objectContaining({source: "tui", capturedAt: 1}),
        }),
      }),
    );
  });

  it("defers a runtime input when its persistence outcome is ambiguous", async () => {
    const store = new TestThreadRuntimeStore();
    await store.createThread({id: "thread-1", sessionId: "session-1"});
    const context = createRequestContext({
      store,
      submitInput: vi.fn(async () => {
        throw Object.assign(new Error("database response lost"), {code: "08006"});
      }),
    });
    const processor = createDaemonRequestProcessor(context, createThreadHelpers());

    await expect(processor(tuiInputRequest())).rejects.toBeInstanceOf(RetryableRuntimeRequestError);
  });

  it("does not retry a deterministic input admission rejection forever", async () => {
    const store = new TestThreadRuntimeStore();
    await store.createThread({id: "thread-1", sessionId: "session-1"});
    const rejection = new Error("Unknown session session-1.");
    const context = createRequestContext({
      store,
      submitInput: vi.fn(async () => {
        throw rejection;
      }),
    });
    const processor = createDaemonRequestProcessor(context, createThreadHelpers());

    await expect(processor(tuiInputRequest())).rejects.toBe(rejection);
  });

  it("reconciles an ambiguous runtime config commit before reading mutable thread state", async () => {
    const store = new TestThreadRuntimeStore();
    await store.createThread({id: "thread-1", sessionId: "session-1"});
    const getThread = vi.spyOn(store, "getThread");
    const context = createRequestContext({store});
    vi.mocked(context.runtime.sessionStore.updateSessionRuntimeConfigOnce)
      .mockRejectedValueOnce(new Error("database response lost after commit"));
    vi.mocked(context.runtime.sessionStore.getSessionRuntimeConfigOperation)
      .mockResolvedValue({
        operationId: "request-update",
        sessionId: "session-1",
        threadId: "thread-1",
        createdAt: 1,
      });
    const processor = createDaemonRequestProcessor(context, createThreadHelpers());
    const request: RuntimeRequestRecord<"update_thread"> = {
      id: "request-update",
      kind: "update_thread",
      status: "running",
      executionAttempts: 1,
      createdAt: 1,
      updatedAt: 1,
      payload: {
        threadId: "thread-1",
        update: {model: "openai/gpt-5.1"},
      },
    };

    await expect(processor(request)).rejects.toBeInstanceOf(RetryableRuntimeRequestError);
    await expect(processor({...request, executionAttempts: 2})).resolves.toEqual({threadId: "thread-1"});

    expect(context.runtime.sessionStore.updateSessionRuntimeConfigOnce).toHaveBeenCalledTimes(1);
    expect(context.runtime.sessionStore.getSessionRuntimeConfigOperation).toHaveBeenCalledTimes(1);
    expect(getThread).toHaveBeenCalledTimes(1);
  });

  it("keeps a later-attempt runtime config commit replayable when its response is lost", async () => {
    const store = new TestThreadRuntimeStore();
    await store.createThread({id: "thread-late-config", sessionId: "session-1"});
    const context = createRequestContext({store});
    let committed = false;
    vi.mocked(context.runtime.sessionStore.getSessionRuntimeConfigOperation)
      .mockImplementation(async () => committed ? {
        operationId: "request-late-config",
        sessionId: "session-1",
        threadId: "thread-late-config",
        createdAt: 1,
      } : null);
    vi.mocked(context.runtime.sessionStore.updateSessionRuntimeConfigOnce)
      .mockImplementationOnce(async () => {
        committed = true;
        throw new Error("database response lost after second-attempt commit");
      });
    const processor = createDaemonRequestProcessor(context, createThreadHelpers());
    const request: RuntimeRequestRecord<"update_thread"> = {
      id: "request-late-config",
      kind: "update_thread",
      status: "running",
      executionAttempts: 2,
      createdAt: 1,
      updatedAt: 1,
      payload: {
        threadId: "thread-late-config",
        update: {model: "openai/gpt-5.1"},
      },
    };

    await expect(processor(request)).rejects.toBeInstanceOf(RetryableRuntimeRequestError);
    await expect(processor({...request, executionAttempts: 3}))
      .resolves.toEqual({threadId: "thread-late-config"});

    expect(context.runtime.sessionStore.updateSessionRuntimeConfigOnce).toHaveBeenCalledTimes(1);
  });

  it("replays a committed abort receipt without issuing another abort", async () => {
    const store = new TestThreadRuntimeStore();
    await store.createThread({id: "thread-abort", sessionId: "session-1"});
    await store.requestRunAbort(
      "thread-abort",
      "Stop now.",
      "request-abort",
    );
    const context = createRequestContext({store});
    const processor = createDaemonRequestProcessor(context, createThreadHelpers());

    await expect(processor({
      id: "request-abort",
      kind: "abort_thread",
      status: "running",
      executionAttempts: 2,
      createdAt: 1,
      updatedAt: 1,
      payload: {threadId: "thread-abort", reason: "Stop now."},
    })).resolves.toEqual({aborted: false});

    expect(context.runtime.coordinator.abort).not.toHaveBeenCalled();
  });

  it("recovers a committed channel input before consulting mutable identity bindings", async () => {
    const store = new TestThreadRuntimeStore();
    await store.createThread({id: "thread-1", sessionId: "session-1"});
    await store.enqueueInput("thread-1", {
      source: "telegram",
      connectorKey: "main",
      channelId: "777",
      externalMessageId: "555",
      actorId: "123",
      identityId: "identity-1",
      message: stringToUserMessage("already committed"),
      metadata: {
        route: {
          source: "telegram",
          connectorKey: "main",
          externalConversationId: "777",
        },
      },
    }, "wake", {inputId: "request-telegram"});
    const context = createRequestContext({store});
    vi.mocked(context.runtime.identityStore.resolveIdentityBinding)
      .mockRejectedValue(new Error("pairing was revoked"));
    const processor = createDaemonRequestProcessor(context, createThreadHelpers());

    await expect(processor({
      ...telegramMessageRequest(),
      executionAttempts: 2,
    })).resolves.toEqual({status: "queued", threadId: "thread-1"});

    expect(context.runtime.identityStore.resolveIdentityBinding).not.toHaveBeenCalled();
  });

  it("routes create_subagent_session requests through the durable subagent helper", async () => {
    const createSubagentSession = vi.fn(async () => ({
      session: {
        id: "subagent-session",
        agentKey: "panda",
        kind: "subagent" as const,
        currentThreadId: "subagent-thread",
        createdAt: 1,
        updatedAt: 1,
      },
      thread: {
        id: "subagent-thread",
        sessionId: "subagent-session",
        createdAt: 1,
        updatedAt: 1,
      },
    }));
    const processor = createDaemonRequestProcessor(
      createRequestContext(),
      createThreadHelpers({
        ensureIdentity: vi.fn(async () => createIdentity()),
        createSubagentSession,
      }),
    );

    await expect(processor({
      id: "request-subagent",
      kind: "create_subagent_session",
      status: "pending",
      createdAt: 1,
      updatedAt: 1,
      payload: {
        identityId: "identity-1",
        sessionId: "subagent-session",
        threadId: "subagent-thread",
        agentKey: "panda",
        parentSessionId: "parent-session",
        prompt: "Inspect the repo.",
        context: "Use read-only tools.",
        profile: "workspace",
        execution: "agent_workspace",
      },
    })).resolves.toMatchObject({
      threadId: "subagent-thread",
      sessionId: "subagent-session",
      profile: "workspace",
      execution: "agent_workspace",
    });

    expect(createSubagentSession).toHaveBeenCalledWith(expect.objectContaining({
      identityId: "identity-1",
      agentKey: "panda",
      parentSessionId: "parent-session",
      prompt: "Inspect the repo.",
      context: "Use read-only tools.",
      profile: "workspace",
      execution: "agent_workspace",
    }));
  });

  it("queues bound A2A messages to the recipient session current thread", async () => {
    const submitInput = vi.fn(async () => {});
    const getSession = vi.fn(async (sessionId: string) => createSession(sessionId, "thread-after-reset", "koala"));
    const context = createRequestContext({
      getSession,
      submitInput,
    });
    const processor = createDaemonRequestProcessor(context, createThreadHelpers());

    await expect(processor({
      id: "request-a2a",
      kind: "a2a_message",
      status: "pending",
      createdAt: 1,
      updatedAt: 1,
      payload: {
        connectorKey: "local",
        externalMessageId: "a2a:reset-thread",
        fromAgentKey: "panda",
        fromSessionId: "session-a",
        fromThreadId: "thread-a",
        toAgentKey: "koala",
        toSessionId: "session-b",
        sentAt: 123,
        items: [{type: "text", text: "hello after reset"}],
      } satisfies A2AMessageRequestPayload,
    })).resolves.toEqual({
      status: "queued",
      threadId: "thread-after-reset",
    });

    expect(submitInput).toHaveBeenCalledWith("thread-after-reset", expect.objectContaining({
      source: "a2a",
      channelId: "session-a",
      externalMessageId: "a2a:reset-thread",
      actorId: "panda",
      message: expect.objectContaining({
        content: expect.stringContaining("hello after reset"),
      }),
    }));
  });

  it("retries accepted ingress after transient infrastructure reads on any attempt", async () => {
    const context = createRequestContext();
    vi.mocked(context.a2aBindings.hasBinding).mockRejectedValue(Object.assign(
      new Error("database connection terminated"),
      {code: "57P01"},
    ));
    const processor = createDaemonRequestProcessor(context, createThreadHelpers());

    await expect(processor({
      id: "request-a2a-transient",
      kind: "a2a_message",
      status: "running",
      executionAttempts: 3,
      createdAt: 1,
      updatedAt: 1,
      payload: {
        connectorKey: "local",
        externalMessageId: "a2a:transient",
        fromAgentKey: "panda",
        fromSessionId: "session-a",
        fromThreadId: "thread-a",
        toAgentKey: "koala",
        toSessionId: "session-b",
        sentAt: 123,
        items: [{type: "text", text: "retry me"}],
      },
    })).rejects.toBeInstanceOf(RetryableRuntimeRequestError);
  });

  it("defers accepted ingress while reset retires the session current thread", async () => {
    const submitInput = vi.fn(async () => {
      throw new ThreadInputAdmissionBlockedError("session-b", "thread-before-reset");
    });
    const context = createRequestContext({submitInput});
    const processor = createDaemonRequestProcessor(context, createThreadHelpers());

    await expect(processor({
      id: "request-a2a-reset-fence",
      kind: "a2a_message",
      status: "running",
      executionAttempts: 4,
      createdAt: 1,
      updatedAt: 1,
      payload: {
        connectorKey: "local",
        externalMessageId: "a2a:reset-fence",
        fromAgentKey: "panda",
        fromSessionId: "session-a",
        fromThreadId: "thread-a",
        toAgentKey: "panda",
        toSessionId: "session-b",
        sentAt: 123,
        items: [{type: "text", text: "wait for reset"}],
      },
    })).rejects.toBeInstanceOf(RetryableRuntimeRequestError);
  });


  it("drops unbound Discord daemon requests without saving route or submitting input", async () => {
    const harness = createHarness({
      binding: null,
      thread: null,
    });
    const processor = createDaemonRequestProcessor(harness.context, harness.threads);

    await expect(processor(discordMessageRequest())).resolves.toEqual({
      status: "dropped",
      reason: "unbound_conversation",
    });

    expect(harness.resolveBoundConversationThread).toHaveBeenCalledWith({
      source: "discord",
      connectorKey: "bot-1",
      externalConversationId: "channel-1",
    });
    expect(harness.resolveOrCreateConversationThread).not.toHaveBeenCalled();
    expect(harness.submitInput).not.toHaveBeenCalled();
    expect(harness.threads.relocateThreadMedia).not.toHaveBeenCalled();
  });

  it("releases unconsumed staged media when an accepted request finishes", async () => {
    const rootDir = await fs.mkdtemp(path.join(tmpdir(), "panda-request-media-terminal-"));
    try {
      const media = await new FileSystemMediaStore({rootDir}).writeMedia({
        bytes: Buffer.from("unpaired media"),
        source: "discord",
        connectorKey: "bot-1",
        mimeType: "text/plain",
        idempotencyKey: "channel-1:message-1:attachment-1",
        createdAt: 1,
      });
      const harness = createHarness({binding: null, thread: null});
      const processor = createDaemonRequestProcessor(harness.context, harness.threads);

      const request = discordMessageRequest({media: [media]});
      await expect(processor(request)).resolves.toEqual({
        status: "dropped",
        reason: "unbound_conversation",
      });
      await expect(fs.readFile(media.localPath, "utf8")).resolves.toBe("unpaired media");
      await discardSettledRuntimeRequestMedia(request);
      await expect(fs.access(media.localPath)).rejects.toMatchObject({code: "ENOENT"});
    } finally {
      await fs.rm(rootDir, {recursive: true, force: true});
    }
  });

  it("never deletes agent media on failure because an earlier transcript may reference it", async () => {
    const sourceRoot = await fs.mkdtemp(path.join(tmpdir(), "panda-request-media-failed-source-"));
    const targetRoot = await fs.mkdtemp(path.join(tmpdir(), "panda-request-media-failed-target-"));
    try {
      const media = await new FileSystemMediaStore({rootDir: sourceRoot}).writeMedia({
        bytes: Buffer.from("partially relocated media"),
        source: "discord",
        connectorKey: "bot-1",
        mimeType: "text/plain",
        idempotencyKey: "channel-1:message-failed:attachment-1",
        createdAt: 1,
        receiptOwner: {requestKind: "discord_message", requestIdempotencyKey: "request-failed"},
      });
      const relocated = await relocateMediaDescriptor(media, {rootDir: targetRoot});
      const request = discordMessageRequest({media: [media]});

      await discardSettledRuntimeRequestMedia(request, "failed");

      await expect(fs.readFile(relocated.localPath, "utf8")).resolves.toBe("partially relocated media");
      await expect(fs.readdir(path.dirname(media.localPath))).resolves.toEqual(["descriptor.json"]);
    } finally {
      await fs.rm(sourceRoot, {recursive: true, force: true});
      await fs.rm(targetRoot, {recursive: true, force: true});
    }
  });

  it("resolves known media owners in one batch and retains newer request kinds", async () => {
    const getRequestStatusesByIdempotencyEntries = vi.fn(async () => (
      ["pending", "failed", undefined] as const
    ));

    await expect(resolveRuntimeRequestMediaReceiptOwners([
      {requestKind: "telegram_message", requestIdempotencyKey: "active"},
      {requestKind: "future_connector_message", requestIdempotencyKey: "future"},
      {requestKind: "discord_message", requestIdempotencyKey: "terminal"},
      {requestKind: "whatsapp_message", requestIdempotencyKey: "missing"},
    ], {getRequestStatusesByIdempotencyEntries} satisfies Pick<
      RuntimeRequestRepo,
      "getRequestStatusesByIdempotencyEntries"
    >)).resolves.toEqual([
      "active",
      "active",
      "failed",
      "missing",
    ]);
    expect(getRequestStatusesByIdempotencyEntries).toHaveBeenCalledOnce();
    expect(getRequestStatusesByIdempotencyEntries.mock.calls[0]?.[0]).toEqual([
      {index: 0, idempotencyKey: "active", kind: "telegram_message"},
      {index: 2, idempotencyKey: "terminal", kind: "discord_message"},
      {index: 3, idempotencyKey: "missing", kind: "whatsapp_message"},
    ]);
  });

  it("retains staged media while an accepted request remains retryable", async () => {
    const rootDir = await fs.mkdtemp(path.join(tmpdir(), "panda-request-media-retry-"));
    try {
      const media = await new FileSystemMediaStore({rootDir}).writeMedia({
        bytes: Buffer.from("retryable media"),
        source: "discord",
        connectorKey: "bot-1",
        mimeType: "text/plain",
        idempotencyKey: "channel-1:message-2:attachment-1",
        createdAt: 1,
      });
      const harness = createHarness({binding: null, thread: null});
      harness.resolveBoundConversationThread.mockRejectedValue(Object.assign(
        new Error("database unavailable"),
        {code: "57P01"},
      ));
      const processor = createDaemonRequestProcessor(harness.context, harness.threads);

      await expect(processor(discordMessageRequest({media: [media]})))
        .rejects.toBeInstanceOf(RetryableRuntimeRequestError);
      await expect(fs.readFile(media.localPath, "utf8")).resolves.toBe("retryable media");
    } finally {
      await fs.rm(rootDir, {recursive: true, force: true});
    }
  });

  it("defers transient media relocation exhaustion without releasing staging", async () => {
    const rootDir = await fs.mkdtemp(path.join(tmpdir(), "panda-request-media-enospc-"));
    try {
      const media = await new FileSystemMediaStore({rootDir}).writeMedia({
        bytes: Buffer.from("retry after disk pressure"),
        source: "discord",
        connectorKey: "bot-1",
        mimeType: "text/plain",
        idempotencyKey: "channel-1:message-enospc:attachment-1",
        createdAt: 1,
      });
      const harness = createHarness();
      harness.threads.relocateThreadMedia.mockRejectedValue(Object.assign(
        new Error("no space left on device"),
        {code: "ENOSPC"},
      ));
      const processor = createDaemonRequestProcessor(harness.context, harness.threads);

      await expect(processor(discordMessageRequest({media: [media]})))
        .rejects.toBeInstanceOf(RetryableRuntimeRequestError);
      await expect(fs.readFile(media.localPath, "utf8")).resolves.toBe("retry after disk pressure");
    } finally {
      await fs.rm(rootDir, {recursive: true, force: true});
    }
  });

  it("routes bound Discord messages with route and input in one session submission", async () => {
    const harness = createHarness({
      thread: {id: "thread-before-reset", sessionId: "session-1"},
      currentThreadId: "thread-after-reset",
    });
    const processor = createDaemonRequestProcessor(harness.context, harness.threads);

    await expect(processor(discordMessageRequest({
      sentAt: Date.parse("2026-05-18T19:00:00.000Z"),
      guildId: "guild-1",
      threadId: "discord-thread-1",
      actualChannelId: "discord-thread-1",
      parentChannelId: "channel-1",
      replyToMessageId: "reply-1",
    }))).resolves.toEqual({
      status: "queued",
      threadId: "thread-after-reset",
    });

    expect(harness.submitInput).toHaveBeenCalledWith("thread-after-reset", expect.objectContaining({
      source: "discord",
      channelId: "channel-1",
      externalMessageId: "message-1",
      actorId: "user-1",
      identityId: "identity-1",
      message: expect.objectContaining({
        content: expect.stringContaining("hello from discord"),
      }),
      metadata: expect.objectContaining({
        deliveryContext: {
          discord: {
            channelId: "discord-thread-1",
            parentChannelId: "channel-1",
            threadId: "discord-thread-1",
            guildId: "guild-1",
            messageId: "message-1",
            referencedMessageId: "reply-1",
          },
        },
        route: expect.objectContaining({
          deliveryContext: {
            discord: {
              channelId: "discord-thread-1",
              parentChannelId: "channel-1",
              threadId: "discord-thread-1",
              guildId: "guild-1",
              messageId: "message-1",
              referencedMessageId: "reply-1",
            },
          },
        }),
        discord: expect.objectContaining({
          actualChannelId: "discord-thread-1",
          threadId: "discord-thread-1",
          parentChannelId: "channel-1",
          replyToMessageId: "reply-1",
        }),
      }),
    }));
    expect(harness.context.runtime.coordinator.submitSessionInput).toHaveBeenCalledWith(
      "session-1",
      expect.anything(),
      "wake",
      expect.objectContaining({
        rememberedRoute: {
          identityId: "identity-1",
          route: expect.objectContaining({
            source: "discord",
            connectorKey: "bot-1",
            externalConversationId: "channel-1",
            externalActorId: "user-1",
            externalMessageId: "message-1",
          }),
        },
      }),
    );
  });

  it("routes Discord messages from unbound actors with safe author metadata and no identity id", async () => {
    const harness = createHarness({
      binding: null,
    });
    const processor = createDaemonRequestProcessor(harness.context, harness.threads);

    await expect(processor(discordMessageRequest({
      authorUsername: "discord-user",
      authorGlobalName: "Discord Global",
      authorDisplayName: "Discord Display",
      authorIsBot: false,
    }))).resolves.toEqual({
      status: "queued",
      threadId: "thread-1",
    });

    expect(harness.context.runtime.coordinator.submitSessionInput).toHaveBeenCalledWith(
      "session-1",
      expect.anything(),
      "wake",
      expect.objectContaining({
        rememberedRoute: {
          route: expect.objectContaining({
            source: "discord",
            externalConversationId: "channel-1",
          }),
        },
      }),
    );
    const submitted = harness.submitInput.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(submitted).not.toHaveProperty("identityId");
    expect(submitted).toMatchObject({
      metadata: {
        deliveryContext: {
          discord: {
            channelId: "channel-1",
            parentChannelId: "channel-1",
            messageId: "message-1",
          },
        },
      },
    });
    expect(JSON.stringify(submitted)).toContain("discord-user");
    expect(JSON.stringify(submitted)).toContain("Discord Display");
  });

  it("submits attachment-only Discord requests as useful text summaries", async () => {
    const harness = createHarness();
    const processor = createDaemonRequestProcessor(harness.context, harness.threads);

    await expect(processor(discordMessageRequest({
      text: undefined,
      attachmentSummaries: [{
        id: "attachment-1",
        filename: "report.pdf",
        contentType: "application/pdf",
        sizeBytes: 456,
        status: "metadata_only",
      }],
    }))).resolves.toEqual({
      status: "queued",
      threadId: "thread-1",
    });

    expect(harness.submitInput).toHaveBeenCalledWith("thread-1", expect.objectContaining({
      message: expect.objectContaining({
        content: expect.stringContaining("Discord message with one attachment."),
      }),
      metadata: expect.objectContaining({
        discord: expect.objectContaining({
          attachments: [{
            id: "attachment-1",
            filename: "report.pdf",
            contentType: "application/pdf",
            sizeBytes: 456,
            status: "metadata_only",
            reason: null,
            httpStatus: null,
          }],
        }),
      }),
    }));
  });

  it("relocates bound Discord media and surfaces inspectable local paths", async () => {
    const harness = createHarness();
    const stagedMedia = {
      id: "media-1",
      source: "discord",
      connectorKey: "bot-1",
      mimeType: "image/png",
      sizeBytes: 5,
      localPath: "/tmp/staged-discord.png",
      originalFilename: "image.png",
      metadata: {discordAttachmentId: "attachment-1"},
      createdAt: 1,
    };
    const relocatedMedia = {
      ...stagedMedia,
      localPath: "/root/.panda/agents/panda/media/discord/bot-1/2026-05/media-1.png",
    };
    const relocateThreadMedia = vi.fn(async () => [relocatedMedia]);
    harness.threads.relocateThreadMedia = relocateThreadMedia;
    const processor = createDaemonRequestProcessor(harness.context, harness.threads);

    await expect(processor(discordMessageRequest({
      text: undefined,
      attachmentSummaries: [{
        id: "attachment-1",
        filename: "image.png",
        contentType: "image/png",
        sizeBytes: 5,
        status: "downloaded",
      }],
      media: [stagedMedia],
    }))).resolves.toEqual({
      status: "queued",
      threadId: "thread-1",
    });

    expect(relocateThreadMedia).toHaveBeenCalledWith(expect.objectContaining({
      id: "thread-1",
      sessionId: "session-1",
    }), [stagedMedia]);
    expect(harness.submitInput).toHaveBeenCalledWith("thread-1", expect.objectContaining({
      message: expect.objectContaining({
        content: expect.stringContaining("downloaded_media:"),
      }),
      metadata: expect.objectContaining({
        discord: expect.objectContaining({
          attachments: [{
            id: "attachment-1",
            filename: "image.png",
            contentType: "image/png",
            sizeBytes: 5,
            status: "downloaded",
            reason: null,
            httpStatus: null,
          }],
          media: [expect.objectContaining({
            id: "media-1",
            localPath: "/root/.panda/agents/panda/media/discord/bot-1/2026-05/media-1.png",
            metadata: {discordAttachmentId: "attachment-1"},
          })],
        }),
      }),
    }));
    const submitted = harness.submitInput.mock.calls[0]?.[1] as {message?: {content?: unknown}; metadata?: unknown};
    expect(String(submitted.message?.content)).toContain("path: /root/.panda/agents/panda/media/discord/bot-1/2026-05/media-1.png");
    expect(JSON.stringify(submitted.metadata)).not.toContain("/tmp/staged-discord.png");
  });

  it("drops unsupported empty Discord shapes without saving route or submitting input", async () => {
    const harness = createHarness();
    const processor = createDaemonRequestProcessor(harness.context, harness.threads);

    await expect(processor(discordMessageRequest({
      text: " ",
      attachmentSummaries: [],
    }))).resolves.toEqual({
      status: "dropped",
      reason: "unsupported_message_shape",
    });

    expect(harness.submitInput).not.toHaveBeenCalled();
  });

  it("routes paired Telegram messages to the conversation thread", async () => {
    const harness = createHarness();
    const processor = createDaemonRequestProcessor(harness.context, harness.threads);

    await expect(processor(telegramMessageRequest())).resolves.toEqual({
      status: "queued",
      threadId: "thread-1",
    });

    expect(harness.resolveOrCreateConversationThread).toHaveBeenCalledWith({
      identityId: "identity-1",
      source: "telegram",
      connectorKey: "main",
      externalConversationId: "777",
    });
    expect(harness.submitInput).toHaveBeenCalledWith("thread-1", expect.objectContaining({
      source: "telegram",
      externalMessageId: "555",
      actorId: "123",
      identityId: "identity-1",
      message: expect.objectContaining({
        content: expect.stringContaining("hello from telegram"),
      }),
      metadata: expect.objectContaining({
        telegram: expect.objectContaining({
          chatId: "777",
          username: "patrik",
        }),
      }),
    }));
    expect(harness.context.runtime.coordinator.submitSessionInput).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({source: "telegram", externalMessageId: "555"}),
      "wake",
      expect.objectContaining({
        inputId: "request-telegram",
        rememberedRoute: expect.objectContaining({
          identityId: "identity-1",
          route: expect.objectContaining({source: "telegram", capturedAt: 1}),
        }),
      }),
    );
  });

  it("routes paired Telegram messages to the session current thread after conversation resolution", async () => {
    const harness = createHarness({
      thread: {id: "thread-before-reset", sessionId: "session-1"},
      currentThreadId: "thread-after-reset",
    });
    const processor = createDaemonRequestProcessor(harness.context, harness.threads);

    await expect(processor(telegramMessageRequest())).resolves.toEqual({
      status: "queued",
      threadId: "thread-after-reset",
    });

    expect(harness.submitInput).toHaveBeenCalledWith("thread-after-reset", expect.objectContaining({
      source: "telegram",
      externalMessageId: "555",
      identityId: "identity-1",
    }));
    expect(harness.context.runtime.coordinator.submitSessionInput).toHaveBeenCalledWith(
      "session-1",
      expect.anything(),
      "wake",
      expect.objectContaining({rememberedRoute: expect.anything()}),
    );
  });

  it("replies to unpaired Telegram /start with pairing instructions", async () => {
    const harness = createHarness({
      binding: null,
    });
    const processor = createDaemonRequestProcessor(harness.context, harness.threads);

    await expect(processor(telegramMessageRequest({text: "/start"}))).resolves.toEqual({
      status: "replied",
      reason: "start_unpaired",
    });

    expect(harness.queueSystemReply).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "runtime-request:request-telegram:system-reply",
      channel: "telegram",
      connectorKey: "main",
      externalConversationId: "777",
      externalActorId: "123",
      replyToMessageId: "555",
      text: expect.stringContaining("panda telegram pair --account <account-key> --identity <identity-handle> --actor 123"),
    }));
    expect(harness.submitInput).not.toHaveBeenCalled();
  });

  it("replays a committed Telegram control reply before mutable pairing lookup", async () => {
    const harness = createHarness();
    vi.mocked(harness.context.runtime.identityStore.resolveIdentityBinding)
      .mockRejectedValue(new Error("pairing lookup is no longer available"));
    const findSystemReply = vi.fn(async () => ({id: "delivery-1"}) as never);
    const processor = createDaemonRequestProcessor(harness.context, {
      ...harness.threads,
      findSystemReply,
    });

    await expect(processor({
      ...telegramMessageRequest({text: "/start"}),
      executionAttempts: 2,
    })).resolves.toEqual({status: "replied", reason: "start_unpaired"});

    expect(findSystemReply).toHaveBeenCalledTimes(1);
    expect(harness.context.runtime.identityStore.resolveIdentityBinding).not.toHaveBeenCalled();
    expect(harness.queueSystemReply).not.toHaveBeenCalled();
  });

  it("replies to paired Telegram /new through the replay-safe delivery seam", async () => {
    const harness = createHarness();
    const processor = createDaemonRequestProcessor(harness.context, harness.threads);

    await expect(processor(telegramMessageRequest({text: "/new"}))).resolves.toEqual({
      status: "replied",
      reason: "new_is_tui_only",
    });

    expect(harness.queueSystemReply).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "runtime-request:request-telegram:system-reply",
      text: "/new is TUI-only. Use /reset here to start fresh.",
    }));
  });

  it("resets paired Telegram conversations and replies on the new thread", async () => {
    const harness = createHarness();
    const processor = createDaemonRequestProcessor(harness.context, harness.threads);

    await expect(processor(telegramMessageRequest({text: "/reset"}))).resolves.toEqual({
      threadId: "thread-reset",
      previousThreadId: "thread-before-reset",
      sessionId: "session-1",
    });

    expect(harness.handleResetSession).toHaveBeenCalledWith(expect.objectContaining({
      identityId: "identity-1",
      source: "telegram",
      connectorKey: "main",
      externalConversationId: "777",
      externalActorId: "123",
      externalMessageId: "555",
    }), "request-telegram", 1, false);
    expect(harness.queueSystemReply).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "runtime-request:request-telegram:system-reply",
      channel: "telegram",
      connectorKey: "main",
      externalConversationId: "777",
      replyToMessageId: "555",
      threadId: "thread-reset",
      text: "Reset Panda. Fresh session started.",
    }));
  });

  it("retries Telegram reset confirmation persistence after the reset commits", async () => {
    const harness = createHarness();
    harness.queueSystemReply.mockRejectedValueOnce(new Error("delivery response lost"));
    const resetResult = {
      threadId: "thread-reset",
      previousThreadId: "thread-before-reset",
      sessionId: "session-1",
      replayed: true,
    };
    harness.threads.reconcileResetSession = vi.fn(async () => resetResult);
    const processor = createDaemonRequestProcessor(harness.context, harness.threads);

    await expect(processor(telegramMessageRequest({text: "/reset"})))
      .rejects.toBeInstanceOf(RetryableRuntimeRequestError);
    await expect(processor({
      ...telegramMessageRequest({text: "/reset"}),
      executionAttempts: 2,
    })).resolves.toEqual(resetResult);

    expect(harness.handleResetSession).toHaveBeenCalledTimes(1);
    expect(harness.queueSystemReply).toHaveBeenCalledTimes(2);
  });

  it("resumes an abort-anchored Telegram reset before mutable pairing lookup", async () => {
    const harness = createHarness();
    const resetResult = {
      threadId: "thread-reset",
      previousThreadId: "thread-before-reset",
      sessionId: "session-1",
    };
    harness.threads.reconcileResetSession = vi.fn(async () => resetResult);
    vi.mocked(harness.context.runtime.identityStore.resolveIdentityBinding)
      .mockRejectedValue(new Error("pairing was revoked after abort commit"));
    const processor = createDaemonRequestProcessor(harness.context, harness.threads);

    await expect(processor({
      ...telegramMessageRequest({text: "/reset"}),
      executionAttempts: 2,
    })).resolves.toEqual(resetResult);

    expect(harness.threads.reconcileResetSession).toHaveBeenCalledTimes(1);
    expect(harness.context.runtime.identityStore.resolveIdentityBinding).not.toHaveBeenCalled();
    expect(harness.queueSystemReply).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "thread-reset",
      idempotencyKey: "runtime-request:request-telegram:system-reply",
    }));
  });

  it("re-enqueues the same idempotent Telegram confirmation when the durable reset is replayed", async () => {
    const harness = createHarness({resetReplayed: true});
    const processor = createDaemonRequestProcessor(harness.context, harness.threads);

    await expect(processor(telegramMessageRequest({text: "/reset"}))).resolves.toMatchObject({
      threadId: "thread-reset",
      replayed: true,
    });

    expect(harness.handleResetSession).toHaveBeenCalledWith(expect.any(Object), "request-telegram", 1, false);
    expect(harness.queueSystemReply).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "runtime-request:request-telegram:system-reply",
      threadId: "thread-reset",
    }));
  });

  it("routes paired WhatsApp reactions to the conversation thread", async () => {
    const harness = createHarness();
    const processor = createDaemonRequestProcessor(harness.context, harness.threads);

    await expect(processor(whatsappReactionRequest())).resolves.toEqual({
      status: "queued",
      threadId: "thread-1",
    });

    expect(harness.resolveOrCreateConversationThread).toHaveBeenCalledWith({
      identityId: "identity-1",
      source: "whatsapp",
      connectorKey: "main",
      externalConversationId: "421900000000@s.whatsapp.net",
    });
    expect(harness.submitInput).toHaveBeenCalledWith("thread-1", expect.objectContaining({
      source: "whatsapp",
      externalMessageId: "reaction-1",
      actorId: "421900000000@s.whatsapp.net",
      identityId: "identity-1",
      message: expect.objectContaining({
        content: expect.stringContaining("Added reaction: 👍"),
      }),
      metadata: expect.objectContaining({
        whatsapp: expect.objectContaining({
          reaction: {
            targetMessageId: "target-1",
            emoji: "👍",
            actorId: "421900000000@s.whatsapp.net",
          },
        }),
      }),
    }));
    expect(harness.context.runtime.coordinator.submitSessionInput).toHaveBeenCalledWith(
      "session-1",
      expect.anything(),
      "wake",
      expect.objectContaining({
        rememberedRoute: expect.objectContaining({identityId: "identity-1"}),
      }),
    );
  });

  it("drops WhatsApp reactions from unpaired actors", async () => {
    const harness = createHarness({
      binding: null,
    });
    const processor = createDaemonRequestProcessor(harness.context, harness.threads);

    await expect(processor(whatsappReactionRequest())).resolves.toEqual({
      status: "dropped",
      reason: "unpaired_actor",
    });

    expect(harness.submitInput).not.toHaveBeenCalled();
  });

  it("drops WhatsApp reactions on conversation identity mismatch", async () => {
    const harness = createHarness({
      thread: null,
    });
    const processor = createDaemonRequestProcessor(harness.context, harness.threads);

    await expect(processor(whatsappReactionRequest())).resolves.toEqual({
      status: "dropped",
      reason: "conversation_identity_mismatch",
    });

    expect(harness.submitInput).not.toHaveBeenCalled();
  });
});
