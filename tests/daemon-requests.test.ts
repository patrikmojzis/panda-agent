import {describe, expect, it, vi} from "vitest";

import {
  createDaemonRequestProcessor,
  UNSUPPORTED_CREATE_WORKER_SESSION_REQUEST_ERROR,
  type DaemonRequestProcessorContext,
  type DaemonRequestThreadHelpers,
} from "../src/app/runtime/daemon-requests.js";
import type {IdentityBindingRecord, IdentityRecord} from "../src/domain/identity/index.js";
import type {SessionRecord, SessionRouteInput, SessionRouteRecord} from "../src/domain/sessions/index.js";
import type {ThreadRecord} from "../src/domain/threads/runtime/index.js";
import type {
  A2AMessageRequestPayload,
  DiscordMessageRequestPayload,
  RuntimeRequestRecord,
  TelegramMessageRequestPayload,
  TuiInputRequestPayload,
  WhatsAppReactionRequestPayload,
} from "../src/domain/threads/requests/index.js";
import {TestThreadRuntimeStore} from "./helpers/test-runtime-store.js";

function whatsappReactionRequest(
  overrides: Partial<WhatsAppReactionRequestPayload> = {},
): RuntimeRequestRecord<"whatsapp_reaction"> {
  return {
    id: "request-1",
    kind: "whatsapp_reaction",
    status: "pending",
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

function createSaveLastRouteMock() {
  return vi.fn(async (input: SessionRouteInput): Promise<SessionRouteRecord> => ({
    ...input,
    channel: input.route.source,
    createdAt: 1,
    updatedAt: 1,
  }));
}

function createCoordinator(submitInput = vi.fn(async () => {})): DaemonRequestProcessorContext["runtime"]["coordinator"] {
  return {
    abort: vi.fn(async () => true),
    resolveThreadRunConfig: vi.fn(async () => ({
      model: "openai/gpt-5.1",
    })),
    runExclusively: vi.fn(async (_threadId, operation) => operation()),
    submitInput,
  };
}

function createRequestContext(input: {
  binding?: IdentityBindingRecord | null;
  currentThreadId?: string;
  getSession?: (sessionId: string) => Promise<SessionRecord>;
  saveLastRoute?: ReturnType<typeof createSaveLastRouteMock>;
  store?: TestThreadRuntimeStore;
  submitInput?: ReturnType<typeof vi.fn>;
} = {}): DaemonRequestProcessorContext {
  const currentThreadId = input.currentThreadId ?? "thread-1";
  return {
    runtime: {
      coordinator: createCoordinator(input.submitInput),
      identityStore: {
        getIdentity: vi.fn(async () => createIdentity()),
        resolveIdentityBinding: vi.fn(async () => input.binding === undefined ? createIdentityBinding() : input.binding),
      },
      sessionStore: {
        getSession: input.getSession ?? vi.fn(async (sessionId: string) => createSession(sessionId, currentThreadId)),
      },
      store: input.store ?? new TestThreadRuntimeStore(),
    },
    a2aBindings: {
      hasBinding: vi.fn(async () => true),
      hasReceivedMessage: vi.fn(async () => false),
    },
    sessionRoutes: {
      saveLastRoute: input.saveLastRoute ?? createSaveLastRouteMock(),
    },
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
    openMainSession: unexpected,
    queueSystemReply: unexpected,
    relocateThreadMedia: vi.fn(async (_thread, media) => media),
    resolveBoundConversationThread: unexpected,
    resolveOrCreateConversationThread: unexpected,
    ...overrides,
  };
}

function createHarness(options: {
  binding?: {identityId: string} | null;
  currentThreadId?: string;
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
  const saveLastRoute = createSaveLastRouteMock();
  const getSession = vi.fn(async (sessionId: string) => createSession(sessionId, currentThreadId));
  const resolveThread = vi.fn(async (): Promise<ThreadRecord | null> => {
    return thread
      ? {
        id: thread.id,
        sessionId: thread.sessionId,
        createdAt: 1,
        updatedAt: 1,
      }
      : null;
  });
  const resolveBoundConversationThread = vi.fn(resolveThread);
  const resolveOrCreateConversationThread = vi.fn(resolveThread);
  const queueSystemReply = vi.fn(async () => {});
  const handleResetSession = vi.fn(async () => ({
    threadId: "thread-reset",
    previousThreadId: "thread-before-reset",
    sessionId: "session-1",
  }));
  const context = createRequestContext({
    binding,
    currentThreadId,
    getSession,
    saveLastRoute,
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
    saveLastRoute,
    submitInput,
    threads,
  };
}

function expectFirstCallBefore(
  first: {mock: {invocationCallOrder: number[]}},
  second: {mock: {invocationCallOrder: number[]}},
): void {
  const firstCall = first.mock.invocationCallOrder[0];
  const secondCall = second.mock.invocationCallOrder[0];
  if (firstCall === undefined || secondCall === undefined) {
    throw new Error("Expected both mocks to have been called.");
  }
  expect(firstCall).toBeLessThan(secondCall);
}

describe("daemon request processor", () => {
  it("routes TUI input through the terminal channel adapter", async () => {
    const store = new TestThreadRuntimeStore();
    await store.createThread({
      id: "thread-1",
      sessionId: "session-1",
    });
    const submitInput = vi.fn(async () => {});
    const saveLastRoute = createSaveLastRouteMock();
    const getThread = vi.spyOn(store, "getThread");
    const context = createRequestContext({
      getSession: vi.fn(async (sessionId: string) => createSession(sessionId, "thread-1")),
      saveLastRoute,
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
    expect(saveLastRoute).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
      identityId: "identity-1",
    }));
    expectFirstCallBefore(saveLastRoute, submitInput);
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
      agentKey: "panda",
      parentSessionId: "parent-session",
      prompt: "Inspect the repo.",
      context: "Use read-only tools.",
      profile: "workspace",
      execution: "agent_workspace",
    }));
  });

  it("fails legacy create_worker_session requests closed instead of parsing-sticking", async () => {
    const createSubagentSession = vi.fn();
    const processor = createDaemonRequestProcessor(
      createRequestContext(),
      createThreadHelpers({
        ensureIdentity: vi.fn(async () => createIdentity()),
        createSubagentSession,
      }),
    );

    await expect(processor({
      id: "request-legacy-worker",
      kind: "create_worker_session",
      status: "pending",
      createdAt: 1,
      updatedAt: 1,
      payload: {
        identityId: "identity-1",
        sessionId: "stale-worker-session",
      },
    })).rejects.toThrow(UNSUPPORTED_CREATE_WORKER_SESSION_REQUEST_ERROR);
    expect(createSubagentSession).not.toHaveBeenCalled();
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
    expect(harness.saveLastRoute).not.toHaveBeenCalled();
    expect(harness.submitInput).not.toHaveBeenCalled();
    expect(harness.threads.relocateThreadMedia).not.toHaveBeenCalled();
  });

  it("routes bound Discord messages to the bound session current thread and saves route before submit", async () => {
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
    expect(harness.saveLastRoute).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
      identityId: "identity-1",
      route: expect.objectContaining({
        source: "discord",
        connectorKey: "bot-1",
        externalConversationId: "channel-1",
        externalActorId: "user-1",
        externalMessageId: "message-1",
      }),
    }));
    expect(harness.saveLastRoute.mock.calls[0]?.[0].route).not.toHaveProperty("deliveryContext");
    expectFirstCallBefore(harness.saveLastRoute, harness.submitInput);
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

    expect(harness.saveLastRoute).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
      identityId: undefined,
      route: expect.objectContaining({
        source: "discord",
        externalConversationId: "channel-1",
      }),
    }));
    expect(harness.saveLastRoute.mock.calls[0]?.[0].route).not.toHaveProperty("deliveryContext");
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
      }],
    }))).resolves.toEqual({
      status: "queued",
      threadId: "thread-1",
    });

    expect(harness.submitInput).toHaveBeenCalledWith("thread-1", expect.objectContaining({
      message: expect.objectContaining({
        content: expect.stringContaining("Discord message with 1 attachment."),
      }),
      metadata: expect.objectContaining({
        discord: expect.objectContaining({
          attachments: [{
            id: "attachment-1",
            filename: "report.pdf",
            contentType: "application/pdf",
            sizeBytes: 456,
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

    expect(harness.saveLastRoute).not.toHaveBeenCalled();
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
    expect(harness.saveLastRoute).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
      identityId: "identity-1",
    }));
    expectFirstCallBefore(harness.saveLastRoute, harness.submitInput);
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
    expectFirstCallBefore(harness.saveLastRoute, harness.submitInput);
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
      channel: "telegram",
      connectorKey: "main",
      externalConversationId: "777",
      externalActorId: "123",
      replyToMessageId: "555",
      text: expect.stringContaining("panda telegram pair --identity <identity-handle> --actor 123"),
    }));
    expect(harness.submitInput).not.toHaveBeenCalled();
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
    }));
    expect(harness.queueSystemReply).toHaveBeenCalledWith(expect.objectContaining({
      channel: "telegram",
      connectorKey: "main",
      externalConversationId: "777",
      replyToMessageId: "555",
      threadId: "thread-reset",
      text: "Reset Panda. Fresh session started.",
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
    expect(harness.saveLastRoute).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
      identityId: "identity-1",
    }));
    expectFirstCallBefore(harness.saveLastRoute, harness.submitInput);
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
