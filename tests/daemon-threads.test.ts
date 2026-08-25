import {randomUUID} from "node:crypto";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, describe, expect, it, vi} from "vitest";

import {
  createDaemonThreadHelpers,
  type DaemonThreadHelperContext,
} from "../src/app/runtime/daemon-threads.js";
import {Agent, BashTool, RunContext,} from "../src/index.js";
import type {CreateSessionInput, SessionRecord, UpdateSessionCurrentThreadInput} from "../src/domain/sessions/index.js";
import {BackgroundToolJobService} from "../src/domain/threads/runtime/tool-job-service.js";
import {TEST_IDENTITY_ID, TestThreadRuntimeStore} from "./helpers/test-runtime-store.js";
import {RetryableRuntimeRequestError} from "../src/domain/threads/requests/errors.js";

function createRunContext(context: Record<string, unknown>): RunContext<Record<string, unknown>> {
  return new RunContext({
    agent: new Agent({
      name: "daemon-threads-test-agent",
      instructions: "Use tools.",
    }),
    turn: 1,
    maxTurns: 5,
    messages: [],
    context,
  });
}

describe("createDaemonThreadHelpers", () => {
  const directories: string[] = [];

  afterEach(async () => {
    while (directories.length > 0) {
      await rm(directories.pop() ?? "", { recursive: true, force: true });
    }
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function createIdentity() {
    return {
      id: TEST_IDENTITY_ID,
      handle: "home",
      displayName: "Home",
      status: "active" as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  function createHelpers(options: {
    store?: TestThreadRuntimeStore;
    workspace?: string;
    pairings?: readonly {agentKey: string}[];
    currentThreadId?: string;
    sessionKind?: "main" | "branch";
    sessionMetadata?: Record<string, unknown>;
    createdByIdentityId?: string;
    throwOnMissingSession?: boolean;
    getIdentity?: (identityId: string) => Promise<ReturnType<typeof createIdentity>>;
    conversationBinding?: {sessionId: string; metadata?: Record<string, unknown>} | null;
    backgroundJobService?: { cancelThreadJobs(threadId: string): Promise<void> };
    coordinator?: DaemonThreadHelperContext["runtime"]["coordinator"];
  } = {}) {
    const store = options.store ?? new TestThreadRuntimeStore();
    let boundThreadId = options.currentThreadId ?? "thread-old-home";
    const identity = createIdentity();
    const sessions = new Map<string, SessionRecord>();
    const creationOperations = new Map<string, {
      operationId: string;
      identityId: string;
      agentKey: string;
      sessionId: string;
      threadId: string;
      kind: "main" | "branch" | "subagent";
      createdAt: number;
    }>();
    const conversationBindings = {
      bindConversation: vi.fn(async () => undefined),
      getConversationBinding: vi.fn(async () => options.conversationBinding ?? null),
    };
    const sessionRoutes = {
      saveLastRoute: vi.fn(async () => undefined),
      getLastRoute: vi.fn(async () => null),
    };
    const sessionStore = {
      getMainSession: vi.fn(async (agentKey: string) => {
        return [...sessions.values()].find((session) => session.agentKey === agentKey && session.kind === "main") ?? null;
      }),
      createSession: vi.fn(async ({id, agentKey, kind, currentThreadId, createdByIdentityId}: CreateSessionInput) => {
        boundThreadId = currentThreadId;
        const session = {
          id,
          agentKey,
          kind,
          currentThreadId,
          createdByIdentityId,
          metadata: undefined,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        sessions.set(id, session);
        return session;
      }),
      getSession: vi.fn(async (sessionId: string) => {
        const session = sessions.get(sessionId);
        if (session) {
          return session;
        }
        if (options.throwOnMissingSession) {
          throw new Error(`Unknown session ${sessionId}`);
        }

        return {
          id: sessionId,
          agentKey: "panda",
          kind: options.sessionKind ?? "main",
          currentThreadId: boundThreadId,
          createdByIdentityId: options.createdByIdentityId,
          metadata: options.sessionMetadata,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
      }),
      updateSessionRuntimeConfig: vi.fn(async (input) => ({
        sessionId: input.sessionId,
        model: input.model ?? undefined,
        thinking: input.thinking ?? undefined,
        thinkingConfigured: input.thinking !== undefined,
        inferenceProjection: input.inferenceProjection ?? undefined,
      })),
      updateCurrentThread: vi.fn(async ({sessionId, currentThreadId}: UpdateSessionCurrentThreadInput) => {
        boundThreadId = currentThreadId;
        const existing = sessions.get(sessionId) ?? {
          id: sessionId,
          agentKey: "panda",
          kind: options.sessionKind ?? "main",
          currentThreadId,
          createdByIdentityId: options.createdByIdentityId,
          metadata: options.sessionMetadata,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        const updated = {
          ...existing,
          currentThreadId,
          updatedAt: Date.now(),
        };
        sessions.set(sessionId, updated);
        return updated;
      }),
      getSessionCreationOperation: vi.fn(async (operationId: string) => creationOperations.get(operationId) ?? null),
      recordSessionCreationOperation: vi.fn(async (input) => {
        const record = creationOperations.get(input.operationId) ?? {...input, createdAt: Date.now()};
        creationOperations.set(input.operationId, record);
        return record;
      }),
      recordMainSessionResolutionOperation: vi.fn(async (input) => {
        const record = creationOperations.get(input.operationId) ?? {
          ...input,
          threadId: sessions.get(input.sessionId)?.currentThreadId ?? boundThreadId,
          kind: "main" as const,
          createdAt: Date.now(),
        };
        creationOperations.set(input.operationId, record);
        return record;
      }),
    };

    const context: DaemonThreadHelperContext = {
        fallbackContext: { cwd: options.workspace ?? process.cwd() },
        runtime: {
          store,
          backgroundJobService: options.backgroundJobService ?? {
            cancelThreadJobs: vi.fn(async () => undefined),
          },
          coordinator: options.coordinator ?? {
            abort: vi.fn(async () => true),
            runExclusively: vi.fn(async (_threadId, operation) => operation({
              signal: new AbortController().signal,
              owner: {
                source: "panda-core",
                connectorKey: "test",
                holderId: "daemon-threads-test",
              },
            })),
          },
          agentStore: {
            getAgent: vi.fn(async () => undefined),
            listIdentityPairings: vi.fn(async () => options.pairings ?? []),
          },
          identityStore: {
            getIdentity: vi.fn(async (identityId: string) => await (options.getIdentity?.(identityId) ?? Promise.resolve(identity))),
          },
          sessionStore,
          subagentSessions: {
            createSubagentSession: vi.fn(async () => {
              throw new Error("Unexpected subagent session creation in daemon thread helper tests.");
            }),
          },
        },
        conversationBindings,
        sessionRoutes,
        outboundDeliveries: {
          enqueueDelivery: vi.fn(async () => undefined),
          findDeliveryByIdempotencyKey: vi.fn(async () => null),
        },
      };

    return {
      store,
      identity,
      conversationBindings,
      sessionRoutes,
      sessionStore,
      helpers: createDaemonThreadHelpers(context),
    };
  }


  it("resolves null for unbound conversations without creating or binding sessions", async () => {
    const {helpers, conversationBindings, sessionRoutes, sessionStore} = createHelpers({
      conversationBinding: null,
    });

    await expect(helpers.resolveBoundConversationThread({
      source: "discord",
      connectorKey: "bot-1",
      externalConversationId: "channel-1",
    })).resolves.toBeNull();

    expect(conversationBindings.getConversationBinding).toHaveBeenCalledWith({
      source: "discord",
      connectorKey: "bot-1",
      externalConversationId: "channel-1",
    });
    expect(sessionStore.createSession).not.toHaveBeenCalled();
    expect(conversationBindings.bindConversation).not.toHaveBeenCalled();
    expect(sessionRoutes.saveLastRoute).not.toHaveBeenCalled();
  });

  it("resolves bound conversations to the bound session current thread", async () => {
    const store = new TestThreadRuntimeStore();
    await store.createThread({
      id: "thread-current",
      sessionId: "session-bound",
    });
    const {helpers, sessionStore} = createHelpers({
      store,
      conversationBinding: {sessionId: "session-bound"},
      currentThreadId: "thread-current",
    });

    await expect(helpers.resolveBoundConversationThread({
      source: "discord",
      connectorKey: "bot-1",
      externalConversationId: "channel-1",
    })).resolves.toMatchObject({
      id: "thread-current",
      sessionId: "session-bound",
    });

    expect(sessionStore.createSession).not.toHaveBeenCalled();
  });

  it("uses the session's latest current thread after a conversation was bound", async () => {
    const store = new TestThreadRuntimeStore();
    await store.createThread({
      id: "thread-after-reset",
      sessionId: "session-bound",
    });
    const {helpers} = createHelpers({
      store,
      conversationBinding: {sessionId: "session-bound"},
      currentThreadId: "thread-after-reset",
    });

    await expect(helpers.resolveBoundConversationThread({
      source: "discord",
      connectorKey: "bot-1",
      externalConversationId: "channel-1",
    })).resolves.toMatchObject({
      id: "thread-after-reset",
      sessionId: "session-bound",
    });
  });

  it("revalidates an established conversation against its exact authorized agent", async () => {
    const store = new TestThreadRuntimeStore();
    await store.createThread({id: "thread-current", sessionId: "session-bound"});
    const {helpers} = createHelpers({
      store,
      pairings: [{agentKey: "panda"}, {agentKey: "other"}],
      conversationBinding: {
        sessionId: "session-bound",
        metadata: {
          channelAuthorization: {
            identityId: TEST_IDENTITY_ID,
            agentKey: "panda",
            actorBindingId: "binding-1",
          },
        },
      },
      currentThreadId: "thread-current",
    });

    await expect(helpers.resolveOrCreateConversationThread({
      identityId: TEST_IDENTITY_ID,
      authorizedAgentKey: "panda",
      authorizedActorBindingId: "binding-1",
      source: "whatsapp",
      connectorKey: "main",
      externalConversationId: "421900000000@s.whatsapp.net",
    })).resolves.toMatchObject({id: "thread-current"});

    await expect(helpers.resolveOrCreateConversationThread({
      identityId: TEST_IDENTITY_ID,
      authorizedAgentKey: "other",
      authorizedActorBindingId: "binding-1",
      source: "whatsapp",
      connectorKey: "main",
      externalConversationId: "421900000000@s.whatsapp.net",
    })).resolves.toBeNull();

    await expect(helpers.resolveOrCreateConversationThread({
      identityId: TEST_IDENTITY_ID,
      authorizedAgentKey: "panda",
      authorizedActorBindingId: "binding-after-repair",
      source: "whatsapp",
      connectorKey: "main",
      externalConversationId: "421900000000@s.whatsapp.net",
    })).resolves.toBeNull();
  });

  it("rejects an established conversation after its identity-agent pairing is removed", async () => {
    const store = new TestThreadRuntimeStore();
    await store.createThread({id: "thread-current", sessionId: "session-bound"});
    const {helpers} = createHelpers({
      store,
      pairings: [],
      conversationBinding: {
        sessionId: "session-bound",
        metadata: {
          channelAuthorization: {
            identityId: TEST_IDENTITY_ID,
            agentKey: "panda",
            actorBindingId: "binding-1",
          },
        },
      },
      currentThreadId: "thread-current",
    });

    await expect(helpers.resolveOrCreateConversationThread({
      identityId: TEST_IDENTITY_ID,
      authorizedAgentKey: "panda",
      authorizedActorBindingId: "binding-1",
      source: "whatsapp",
      connectorKey: "main",
      externalConversationId: "421900000000@s.whatsapp.net",
    })).resolves.toBeNull();
  });

  it("binds a new authorized conversation to the exact account owner and grant", async () => {
    const {helpers, conversationBindings} = createHelpers({
      pairings: [{agentKey: "panda"}, {agentKey: "other"}],
      conversationBinding: null,
    });

    await expect(helpers.resolveOrCreateConversationThread({
      identityId: TEST_IDENTITY_ID,
      authorizedAgentKey: "panda",
      authorizedActorBindingId: "binding-1",
      source: "whatsapp",
      connectorKey: "main",
      externalConversationId: "421900000000@s.whatsapp.net",
    })).resolves.toMatchObject({sessionId: expect.any(String)});

    expect(conversationBindings.bindConversation).toHaveBeenCalledWith(expect.objectContaining({
      metadata: {
        channelAuthorization: {
          identityId: TEST_IDENTITY_ID,
          agentKey: "panda",
          actorBindingId: "binding-1",
        },
      },
    }));
  });

  it("rejects explicit agent access when the identity has no pairings", async () => {
    const {helpers, identity} = createHelpers({
      pairings: [],
      throwOnMissingSession: true,
    });

    await expect(helpers.openMainSession({
      identityId: identity.id,
      agentKey: "panda",
    }, "request-denied-main", false)).rejects.toThrow("Identity home is not paired to agent panda.");

    await expect(helpers.createBranchSession({
      operationId: "request-denied-branch",
      replayAttempt: false,
      identityId: identity.id,
      sessionId: "denied-branch-session",
      threadId: "denied-branch-thread",
      agentKey: "panda",
    })).rejects.toThrow("Identity home is not paired to agent panda.");

    await expect(helpers.handleResetSession({
      identityId: identity.id,
      source: "tui",
      agentKey: "panda",
    }, "request-denied", 1, false)).rejects.toThrow("Identity home is not paired to agent panda.");
  });

  it("fails on unknown identity ids instead of auto-healing them", async () => {
    const {helpers} = createHelpers({
      getIdentity: async (identityId: string) => {
        throw new Error(`Unknown identity ${identityId}`);
      },
    });

    await expect(helpers.openMainSession({
      identityId: "missing-identity",
      agentKey: "panda",
    }, "request-missing-main", false)).rejects.toThrow("Unknown identity missing-identity");
  });

  it("replays stable branch creation without creating another session or thread", async () => {
    const pairings = [{agentKey: "panda"}];
    const {helpers, identity, sessionStore, store} = createHelpers({
      pairings,
      createdByIdentityId: TEST_IDENTITY_ID,
      throwOnMissingSession: true,
    });
    const input = {
      operationId: "request-branch",
      replayAttempt: false,
      identityId: identity.id,
      sessionId: "branch-session",
      threadId: "branch-thread",
      model: "openai/gpt-5.1",
    };

    const first = await helpers.createBranchSession(input);
    pairings.splice(0);
    sessionStore.updateSessionRuntimeConfig.mockClear();
    const replay = await helpers.createBranchSession({...input, replayAttempt: true});
    expect(first.id).toBe("branch-thread");
    expect(replay.id).toBe(first.id);
    expect(sessionStore.createSession).toHaveBeenCalledTimes(1);
    expect(sessionStore.updateSessionRuntimeConfig).not.toHaveBeenCalled();
    await expect(store.getThread("branch-thread")).resolves.toMatchObject({sessionId: "branch-session"});
  });

  it("trusts the branch creation receipt after its creator identity is deleted", async () => {
    const {helpers, identity, sessionStore} = createHelpers({
      pairings: [{agentKey: "panda"}],
      throwOnMissingSession: true,
    });
    const input = {
      operationId: "request-branch-deleted-identity",
      replayAttempt: false,
      identityId: identity.id,
      sessionId: "branch-deleted-identity",
      threadId: "branch-deleted-identity-thread",
    };

    await helpers.createBranchSession(input);
    const created = await sessionStore.getSession(input.sessionId);
    sessionStore.getSession.mockResolvedValue({...created, createdByIdentityId: undefined});

    await expect(helpers.createBranchSession({...input, replayAttempt: true})).resolves.toMatchObject({
      id: input.threadId,
      sessionId: input.sessionId,
    });
    expect(sessionStore.createSession).toHaveBeenCalledTimes(1);
  });

  it("replays branch creation after reset moves the session to a newer thread", async () => {
    const {helpers, identity, sessionStore, store} = createHelpers({
      pairings: [{agentKey: "panda"}],
      throwOnMissingSession: true,
    });
    const input = {
      operationId: "request-branch-after-reset",
      replayAttempt: false,
      identityId: identity.id,
      sessionId: "branch-after-reset",
      threadId: "branch-initial-thread",
    };

    await helpers.createBranchSession(input);
    await store.createThread({id: "branch-current-thread", sessionId: input.sessionId});
    await sessionStore.updateCurrentThread({
      sessionId: input.sessionId,
      currentThreadId: "branch-current-thread",
    });

    await expect(helpers.createBranchSession({...input, replayAttempt: true})).resolves.toMatchObject({
      id: input.threadId,
      sessionId: input.sessionId,
    });
    await expect(sessionStore.getSession(input.sessionId)).resolves.toMatchObject({
      currentThreadId: "branch-current-thread",
    });
  });

  it("does not persist synthetic cwd context for new main sessions", async () => {
    vi.stubEnv("BASH_EXECUTION_MODE", "remote");
    vi.stubEnv("BASH_SERVER_CWD_TEMPLATE", "/root/.panda/agents/{agentKey}");

    const {helpers, identity} = createHelpers({
      pairings: [{agentKey: "panda"}],
      workspace: "/Users/patrikmojzis/Projects/panda-agent",
    });

    const thread = await helpers.openMainSession({
      identityId: identity.id,
    }, "request-main-context", false);

    expect(thread).not.toHaveProperty("context");
  });

  it("leaves new main sessions unpinned when no explicit model was requested", async () => {
    const {helpers, identity, sessionStore} = createHelpers({
      pairings: [{agentKey: "panda"}],
    });

    await helpers.openMainSession({
      identityId: identity.id,
    }, "request-main-unpinned", false);

    expect(sessionStore.updateSessionRuntimeConfig).not.toHaveBeenCalled();
  });

  it("adopts the unique main-session winner under concurrent first ingress", async () => {
    const {helpers, identity, sessionStore} = createHelpers({
      pairings: [{agentKey: "panda"}],
    });
    const originalCreate = sessionStore.createSession.getMockImplementation()!;
    let initialReads = 0;
    let winnerSession: SessionRecord | null = null;
    let publishWinner!: () => void;
    const winnerCreated = new Promise<void>((resolve) => {
      publishWinner = resolve;
    });
    let releaseReads!: () => void;
    const bothRead = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    sessionStore.getMainSession.mockImplementation(async () => {
      initialReads += 1;
      if (initialReads <= 2) {
        if (initialReads === 2) releaseReads();
        await bothRead;
        return null;
      }
      return winnerSession;
    });
    let creates = 0;
    sessionStore.createSession.mockImplementation(async (input) => {
      creates += 1;
      if (creates > 1) {
        await winnerCreated;
        throw new Error("duplicate main session");
      }
      winnerSession = await originalCreate(input);
      publishWinner();
      return winnerSession;
    });

    const [first, second] = await Promise.all([
      helpers.openMainSession({identityId: identity.id}, "request-main-race-a", false),
      helpers.openMainSession({identityId: identity.id}, "request-main-race-b", false),
    ]);

    expect(first.id).toBe(second.id);
    expect(sessionStore.createSession).toHaveBeenCalledTimes(2);
    await expect(sessionStore.getSessionCreationOperation("request-main-race-a"))
      .resolves.toMatchObject({threadId: first.id});
    await expect(sessionStore.getSessionCreationOperation("request-main-race-b"))
      .resolves.toMatchObject({threadId: first.id});
  });

  it("does not turn main-session resolution into a replayable config update", async () => {
    const {helpers, identity, sessionStore} = createHelpers({
      pairings: [{agentKey: "panda"}],
    });

    const initial = await helpers.openMainSession({
      identityId: identity.id,
    }, "request-main-initial", false);
    expect(sessionStore.updateSessionRuntimeConfig).not.toHaveBeenCalled();

    const updated = await helpers.openMainSession({
      identityId: identity.id,
      model: "anthropic-oauth/claude-opus-4-7",
    }, "request-main-updated", false);

    expect(updated.id).toBe(initial.id);
    expect(sessionStore.updateSessionRuntimeConfig).not.toHaveBeenCalled();
  });

  it("reconciles a later-attempt main-session receipt when its commit response is lost", async () => {
    const {helpers, identity, sessionStore} = createHelpers({
      pairings: [{agentKey: "panda"}],
    });
    const initial = await helpers.openMainSession({identityId: identity.id}, "request-main-seed", false);

    const recordResolution = sessionStore.recordMainSessionResolutionOperation.getMockImplementation()!;
    sessionStore.recordMainSessionResolutionOperation.mockImplementationOnce(async (input) => {
      await recordResolution(input);
      throw new Error("database response lost after main resolution receipt commit");
    });

    await expect(helpers.openMainSession(
      {identityId: identity.id},
      "request-main-late-attempt",
      true,
    )).rejects.toBeInstanceOf(RetryableRuntimeRequestError);
    await expect(helpers.openMainSession(
      {identityId: identity.id},
      "request-main-late-attempt",
      true,
    )).resolves.toMatchObject({sessionId: initial.sessionId});

    expect(sessionStore.recordMainSessionResolutionOperation).toHaveBeenCalledTimes(1);
  });

  it("cancels old-thread background jobs during session reset", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "panda-daemon-reset-bg-"));
    directories.push(workspace);

    const store = new TestThreadRuntimeStore();
    await store.createThread({
      id: "thread-old-home",
      sessionId: "session-main",
    });

    const backgroundJobService = new BackgroundToolJobService({
      store,
      owner: {source: "test", connectorKey: "daemon-threads", holderId: "daemon-threads-owner"},
    });
    const bash = new BashTool({
      outputDirectory: path.join(workspace, "tool-results"),
      jobService: backgroundJobService,
    });
    const started = await bash.run(
      { command: "sleep 10", background: true },
      createRunContext({
        threadId: "thread-old-home",
        cwd: workspace,
        shell: {
          cwd: workspace,
          env: {},
        },
      }),
    );
    const jobId = String((started as {jobId: string}).jobId);

    const onTerminalJob = vi.fn();
    backgroundJobService.setBackgroundCompletionHandler(onTerminalJob);
    const {helpers} = createHelpers({
      store,
      workspace,
      pairings: [{agentKey: "panda"}],
      currentThreadId: "thread-old-home",
      createdByIdentityId: TEST_IDENTITY_ID,
      backgroundJobService,
    });

    const result = await helpers.handleResetSession({
      identityId: TEST_IDENTITY_ID,
      source: "tui",
      threadId: "thread-old-home",
    }, "request-reset-background", 1, false);

    expect(result.previousThreadId).toBe("thread-old-home");
    expect(result.threadId).not.toBe("thread-old-home");
    await expect(store.getToolJob(jobId)).resolves.toMatchObject({
      status: "cancelled",
    });
    expect(onTerminalJob).not.toHaveBeenCalled();
    const thread = await store.getThread(String(result.threadId));
    expect(thread.sessionId).toBe("session-main");
    expect(thread).not.toHaveProperty("context");
  });

  it("resets channel-bound conversations without adapter-specific daemon logic", async () => {
    const store = new TestThreadRuntimeStore();
    await store.createThread({
      id: "thread-old-channel",
      sessionId: "session-main",
    });

    const {helpers, conversationBindings, sessionRoutes, sessionStore} = createHelpers({
      store,
      currentThreadId: "thread-old-channel",
      conversationBinding: {sessionId: "session-main"},
    });

    const result = await helpers.handleResetSession({
      identityId: TEST_IDENTITY_ID,
      source: "whatsapp",
      connectorKey: "main",
      externalConversationId: "421900000000@s.whatsapp.net",
      externalActorId: "421900000000@s.whatsapp.net",
      externalMessageId: "reset-1",
    }, "request-reset-channel", 1, false);
    const replay = await helpers.handleResetSession({
      identityId: TEST_IDENTITY_ID,
      source: "whatsapp",
      connectorKey: "main",
      externalConversationId: "421900000000@s.whatsapp.net",
      externalActorId: "421900000000@s.whatsapp.net",
      externalMessageId: "reset-1",
    }, "request-reset-channel", 1, true);
    const newerReset = await helpers.handleResetSession({
      identityId: TEST_IDENTITY_ID,
      source: "whatsapp",
      connectorKey: "main",
      externalConversationId: "421900000000@s.whatsapp.net",
      externalActorId: "421900000000@s.whatsapp.net",
      externalMessageId: "reset-2",
    }, "request-reset-channel-2", 2, false);
    const replayAfterNewerReset = await helpers.handleResetSession({
      identityId: TEST_IDENTITY_ID,
      source: "whatsapp",
      connectorKey: "main",
      externalConversationId: "421900000000@s.whatsapp.net",
      externalActorId: "421900000000@s.whatsapp.net",
      externalMessageId: "reset-1",
    }, "request-reset-channel", 1, true);

    expect(result.previousThreadId).toBe("thread-old-channel");
    expect(result.threadId).not.toBe("thread-old-channel");
    expect(replay).toMatchObject({
      threadId: result.threadId,
      previousThreadId: "thread-old-channel",
      replayed: true,
    });
    expect(newerReset).toMatchObject({previousThreadId: result.threadId});
    expect(replayAfterNewerReset).toMatchObject({
      threadId: result.threadId,
      previousThreadId: "thread-old-channel",
      replayed: true,
    });
    await expect(sessionStore.getSession("session-main")).resolves.toMatchObject({
      currentThreadId: newerReset.threadId,
    });
    expect(conversationBindings.getConversationBinding).toHaveBeenCalledWith({
      source: "whatsapp",
      connectorKey: "main",
      externalConversationId: "421900000000@s.whatsapp.net",
    });
    expect(conversationBindings.bindConversation).toHaveBeenCalledWith(expect.objectContaining({
      source: "whatsapp",
      connectorKey: "main",
      externalConversationId: "421900000000@s.whatsapp.net",
      sessionId: "session-main",
      metadata: {
        kind: "channel_reset_receipt",
        externalMessageId: "reset-1",
      },
    }));
    expect(sessionRoutes.saveLastRoute).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-main",
      identityId: TEST_IDENTITY_ID,
      route: expect.objectContaining({
        source: "whatsapp",
        connectorKey: "main",
        externalConversationId: "421900000000@s.whatsapp.net",
        externalActorId: "421900000000@s.whatsapp.net",
        externalMessageId: "reset-1",
      }),
    }));
    await expect(store.getThread(String(result.threadId))).resolves.toMatchObject({
      sessionId: "session-main",
    });
    await expect(store.getThread(String(result.threadId))).resolves.not.toHaveProperty("context");
  });

  it("resumes reset from its authorized main-session receipt after pairing revocation", async () => {
    let identityAvailable = true;
    const pairings = [{agentKey: "panda"}];
    const {helpers, identity, conversationBindings, sessionRoutes} = createHelpers({
      pairings,
      conversationBinding: null,
      getIdentity: async () => {
        if (!identityAvailable) throw new Error("identity was deleted");
        return createIdentity();
      },
    });
    await helpers.openMainSession({identityId: identity.id}, "request-reset-resume", false);
    identityAvailable = false;
    pairings.splice(0);

    const result = await helpers.handleResetSession({
      source: "telegram",
      connectorKey: "main",
      externalConversationId: "777",
      externalActorId: "123",
      externalMessageId: "555",
    }, "request-reset-resume", 2, true);

    expect(result).toMatchObject({previousThreadId: expect.any(String), sessionId: expect.any(String)});
    expect(conversationBindings.bindConversation).toHaveBeenCalledWith(expect.objectContaining({
      source: "telegram",
      externalConversationId: "777",
      sessionId: result.sessionId,
    }));
    expect(sessionRoutes.saveLastRoute).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: result.sessionId,
      identityId: identity.id,
    }));
  });

  it("allows operator reset for an ownerless session", async () => {
    const store = new TestThreadRuntimeStore();
    await store.createThread({
      id: "thread-ownerless",
      sessionId: "session-main",
    });

    const {helpers} = createHelpers({
      store,
      currentThreadId: "thread-ownerless",
      createdByIdentityId: undefined,
    });

    const result = await helpers.handleResetSession({
      source: "operator",
      sessionId: "session-main",
    }, "request-reset-ownerless", 1, false);

    expect(result.previousThreadId).toBe("thread-ownerless");
    expect(result.threadId).not.toBe("thread-ownerless");
    await expect(store.getThread(String(result.threadId))).resolves.toMatchObject({
      sessionId: "session-main",
    });
  });

  it("defers reset when the request-keyed abort outcome is ambiguous", async () => {
    const store = new TestThreadRuntimeStore();
    await store.createThread({id: "thread-reset-ambiguous", sessionId: "session-main"});
    const order: string[] = [];
    const abort = vi.fn(async (
      threadId: string,
      reason?: string,
      operationId?: string,
      options?: {blocksNewRuns?: boolean},
    ) => {
      order.push("abort");
      await store.requestRunAbort(threadId, reason, operationId, options);
      if (abort.mock.calls.length === 1) {
        throw new Error("database response lost after abort receipt commit");
      }
      return false;
    });
    const {helpers, conversationBindings} = createHelpers({
      store,
      currentThreadId: "thread-reset-ambiguous",
      createdByIdentityId: undefined,
      conversationBinding: {sessionId: "session-main"},
      coordinator: {
        abort,
        runExclusively: vi.fn(async (_threadId, operation) => {
          order.push("reserve");
          return operation({
            signal: new AbortController().signal,
            owner: {
              source: "panda-core",
              connectorKey: "test",
              holderId: "daemon-threads-test",
            },
          });
        }),
      },
    });

    await expect(helpers.handleResetSession({
      source: "telegram",
      connectorKey: "main",
      externalConversationId: "777",
    }, "request-reset-ambiguous", 1, false)).rejects.toBeInstanceOf(RetryableRuntimeRequestError);
    conversationBindings.getConversationBinding.mockResolvedValue(null);
    await expect(helpers.handleResetSession({
      source: "telegram",
      connectorKey: "main",
      externalConversationId: "777",
    }, "request-reset-ambiguous", 2, true)).resolves.toMatchObject({
      previousThreadId: "thread-reset-ambiguous",
      sessionId: "session-main",
    });

    expect(abort).toHaveBeenCalledTimes(2);
    expect(conversationBindings.getConversationBinding).toHaveBeenCalledTimes(1);
    expect(order.slice(0, 2)).toEqual(["reserve", "abort"]);
  });

  it("keeps the old thread fenced while a partially committed reset retries", async () => {
    const store = new TestThreadRuntimeStore();
    await store.createThread({id: "thread-reset-fenced", sessionId: "session-main"});
    await store.enqueueInput("thread-reset-fenced", {
      source: "tui",
      externalMessageId: "pending-after-reset",
      actorId: "operator",
      message: {role: "user", content: [{type: "text", text: "do not replay"}]},
    });
    const cancelThreadJobs = vi.fn()
      .mockRejectedValueOnce(new Error("background cancellation unavailable"))
      .mockResolvedValue(undefined);
    const abort = vi.fn(async (
      threadId: string,
      reason?: string,
      operationId?: string,
      options?: {blocksNewRuns?: boolean},
    ) => {
      return (await store.requestRunAbort(threadId, reason, operationId, options)) !== null;
    });
    const {helpers} = createHelpers({
      store,
      currentThreadId: "thread-reset-fenced",
      createdByIdentityId: undefined,
      backgroundJobService: {cancelThreadJobs},
      coordinator: {
        abort,
        runExclusively: vi.fn(async (_threadId, operation) => operation({
          signal: new AbortController().signal,
          owner: {
            source: "panda-core",
            connectorKey: "test",
            holderId: "daemon-threads-test",
          },
        })),
      },
    });

    const payload = {source: "operator", sessionId: "session-main"} as const;
    await expect(helpers.handleResetSession(payload, "request-reset-fenced", 1, false))
      .rejects.toBeInstanceOf(RetryableRuntimeRequestError);
    await expect(store.tryStartRun("thread-reset-fenced", {
      source: "panda-core",
      connectorKey: "test",
      holderId: "would-replay-old-thread",
    }, randomUUID())).resolves.toBeNull();

    await expect(helpers.handleResetSession(payload, "request-reset-fenced", 2, true))
      .resolves.toMatchObject({previousThreadId: "thread-reset-fenced", sessionId: "session-main"});
    expect(abort).toHaveBeenCalledTimes(2);
    expect(cancelThreadJobs).toHaveBeenCalledTimes(2);
  });

});
