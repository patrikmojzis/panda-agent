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
    getIdentity?: (identityId: string) => Promise<ReturnType<typeof createIdentity>>;
    conversationBinding?: {sessionId: string} | null;
    backgroundJobService?: { cancelThreadJobs(threadId: string): Promise<void> };
    coordinator?: {
      abort(threadId: string, reason?: string): Promise<boolean>;
      waitForCurrentRun(threadId: string): Promise<void>;
    };
  } = {}) {
    const store = options.store ?? new TestThreadRuntimeStore();
    let boundThreadId = options.currentThreadId ?? "thread-old-home";
    const identity = createIdentity();
    const sessions = new Map<string, SessionRecord>();
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
      createSession: vi.fn(async ({id, agentKey, kind, currentThreadId}: CreateSessionInput) => {
        boundThreadId = currentThreadId;
        const session = {
          id,
          agentKey,
          kind,
          currentThreadId,
          createdByIdentityId: options.createdByIdentityId,
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
            waitForCurrentRun: vi.fn(async () => undefined),
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

  it("rejects explicit agent access when the identity has no pairings", async () => {
    const {helpers, identity} = createHelpers({
      pairings: [],
    });

    await expect(helpers.openMainSession({
      identityId: identity.id,
      agentKey: "panda",
    })).rejects.toThrow("Identity home is not paired to agent panda.");

    await expect(helpers.createBranchSession({
      identity,
      agentKey: "panda",
    })).rejects.toThrow("Identity home is not paired to agent panda.");

    await expect(helpers.handleResetSession({
      identityId: identity.id,
      source: "tui",
      agentKey: "panda",
    })).rejects.toThrow("Identity home is not paired to agent panda.");
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
    })).rejects.toThrow("Unknown identity missing-identity");
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
    });

    expect(thread).not.toHaveProperty("context");
  });

  it("leaves new main sessions unpinned when no explicit model was requested", async () => {
    const {helpers, identity, sessionStore} = createHelpers({
      pairings: [{agentKey: "panda"}],
    });

    await helpers.openMainSession({
      identityId: identity.id,
    });

    expect(sessionStore.updateSessionRuntimeConfig).not.toHaveBeenCalled();
  });

  it("applies an explicit model when opening an existing main session", async () => {
    const {helpers, identity, sessionStore} = createHelpers({
      pairings: [{agentKey: "panda"}],
    });

    const initial = await helpers.openMainSession({
      identityId: identity.id,
    });
    expect(sessionStore.updateSessionRuntimeConfig).not.toHaveBeenCalled();

    const updated = await helpers.openMainSession({
      identityId: identity.id,
      model: "anthropic-oauth/claude-opus-4-7",
    });

    expect(updated.id).toBe(initial.id);
    expect(sessionStore.updateSessionRuntimeConfig).toHaveBeenCalledWith({
      sessionId: initial.sessionId,
      model: "anthropic-oauth/claude-opus-4-7",
    });
  });

  it("cancels old-thread background jobs during session reset", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "panda-daemon-reset-bg-"));
    directories.push(workspace);

    const store = new TestThreadRuntimeStore();
    await store.createThread({
      id: "thread-old-home",
      sessionId: "session-main",
    });

    const backgroundJobService = new BackgroundToolJobService({ store });
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
    });

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

    const {helpers, conversationBindings, sessionRoutes} = createHelpers({
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
    });

    expect(result.previousThreadId).toBe("thread-old-channel");
    expect(result.threadId).not.toBe("thread-old-channel");
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
    });

    expect(result.previousThreadId).toBe("thread-ownerless");
    expect(result.threadId).not.toBe("thread-ownerless");
    await expect(store.getThread(String(result.threadId))).resolves.toMatchObject({
      sessionId: "session-main",
    });
  });

});
