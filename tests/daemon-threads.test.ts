import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, describe, expect, it, vi} from "vitest";

import {createDaemonThreadHelpers} from "../src/app/runtime/daemon-threads.js";
import {Agent, BashTool, RunContext,} from "../src/index.js";
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
    sessionKind?: "main" | "branch" | "sidecar";
    sessionMetadata?: Record<string, unknown>;
    createdByIdentityId?: string;
    getIdentity?: (identityId: string) => Promise<ReturnType<typeof createIdentity>>;
    backgroundJobService?: { cancelThreadJobs(threadId: string): Promise<void> };
    coordinator?: {
      abort(threadId: string, reason?: string): Promise<boolean>;
      waitForCurrentRun(threadId: string): Promise<void>;
    };
  } = {}) {
    const store = options.store ?? new TestThreadRuntimeStore();
    let boundThreadId = options.currentThreadId ?? "thread-old-home";
    const identity = createIdentity();
    const sessions = new Map<string, {
      id: string;
      agentKey: string;
      kind: "main" | "branch" | "sidecar";
      currentThreadId: string;
      createdByIdentityId?: string;
      metadata?: Record<string, unknown>;
      createdAt: number;
      updatedAt: number;
    }>();

    return {
      store,
      identity,
      helpers: createDaemonThreadHelpers({
        fallbackContext: { cwd: options.workspace ?? process.cwd() },
        model: "openai/gpt-5.1",
        daemonKey: "panda-daemon",
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
            getAgent: vi.fn(async (agentKey: string) => ({ agentKey })),
            listIdentityPairings: vi.fn(async () => options.pairings ?? []),
          },
          identityStore: {
            ensureIdentity: vi.fn(async () => identity),
            getIdentity: vi.fn(async (identityId: string) => await (options.getIdentity?.(identityId) ?? Promise.resolve(identity))),
          },
          sessionStore: {
            getMainSession: vi.fn(async (agentKey: string) => {
              return [...sessions.values()].find((session) => session.agentKey === agentKey && session.kind === "main") ?? null;
            }),
            createSession: vi.fn(async ({id, agentKey, currentThreadId}: {id: string; agentKey: string; currentThreadId: string}) => {
              boundThreadId = currentThreadId;
              const session = {
                id,
                agentKey,
                kind: "main" as const,
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
            updateCurrentThread: vi.fn(async ({sessionId, currentThreadId}: {sessionId: string; currentThreadId: string}) => {
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
          },
        } as any,
        conversationBindings: {
          bindConversation: vi.fn(async () => undefined),
          getConversationBinding: vi.fn(async () => null),
        } as any,
        sessionRoutes: {
          saveLastRoute: vi.fn(async () => undefined),
          getLastRoute: vi.fn(async () => null),
        } as any,
        outboundDeliveries: {
          enqueueDelivery: vi.fn(async () => undefined),
        } as any,
        channelActions: {
          enqueueAction: vi.fn(async () => undefined),
        } as any,
        requests: {} as any,
        daemonState: {} as any,
        scheduledTaskRunner: {} as any,
        watchRunner: {} as any,
        relationshipHeartbeatRunner: {} as any,
      }),
    };
  }

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

  it("stores canonical host cwd for new main sessions even in remote mode", async () => {
    vi.stubEnv("BASH_EXECUTION_MODE", "remote");
    vi.stubEnv("RUNNER_CWD_TEMPLATE", "/root/.panda/agents/{agentKey}");

    const {helpers, identity} = createHelpers({
      pairings: [{agentKey: "panda"}],
      workspace: "/Users/patrikmojzis/Projects/panda-agent",
    });

    const thread = await helpers.openMainSession({
      identityId: identity.id,
    });

    expect(thread.context).toMatchObject({
      agentKey: "panda",
      cwd: "/Users/patrikmojzis/Projects/panda-agent",
    });
  });

  it("leaves new main sessions unpinned when no explicit model was requested", async () => {
    const {helpers, identity} = createHelpers({
      pairings: [{agentKey: "panda"}],
    });

    const thread = await helpers.openMainSession({
      identityId: identity.id,
    });

    expect(thread.model).toBeUndefined();
  });

  it("applies an explicit model when opening an existing main session", async () => {
    const {helpers, identity} = createHelpers({
      pairings: [{agentKey: "panda"}],
    });

    const initial = await helpers.openMainSession({
      identityId: identity.id,
    });
    expect(initial.model).toBeUndefined();

    const updated = await helpers.openMainSession({
      identityId: identity.id,
      model: "anthropic-oauth/claude-opus-4-7",
    });

    expect(updated.id).toBe(initial.id);
    expect(updated.model).toBe("anthropic-oauth/claude-opus-4-7");
  });

  it("cancels old-thread background jobs during session reset", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "panda-daemon-reset-bg-"));
    directories.push(workspace);

    const store = new TestThreadRuntimeStore();
    await store.createThread({
      id: "thread-old-home",
      sessionId: "session-main",
      context: {
        agentKey: "panda",
        sessionId: "session-main",
        identityId: TEST_IDENTITY_ID,
        identityHandle: "home",
      },
    } as any);

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
    const {helpers, identity} = createHelpers({
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
    expect(thread.context).toMatchObject({
      agentKey: "panda",
      sessionId: "session-main",
      cwd: workspace,
    });
    expect((thread.context as Record<string, unknown>).identityId).toBeUndefined();
    expect((thread.context as Record<string, unknown>).identityHandle).toBeUndefined();
  });

  it("allows operator reset for an ownerless session", async () => {
    const store = new TestThreadRuntimeStore();
    await store.createThread({
      id: "thread-ownerless",
      sessionId: "session-main",
      context: {
        agentKey: "panda",
        sessionId: "session-main",
      },
    } as any);

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

  it("preserves sidecar binding when resetting a sidecar session", async () => {
    const store = new TestThreadRuntimeStore();
    await store.createThread({
      id: "thread-old-sidecar",
      sessionId: "sidecar-memory_guard-session-main",
      context: {
        agentKey: "panda",
        sessionId: "sidecar-memory_guard-session-main",
        cwd: "/app",
        sidecar: {
          kind: "sidecar",
          parentSessionId: "session-main",
          sidecarKey: "memory_guard",
        },
      },
      promptCacheKey: "sidecar:memory_guard:oldhash",
    } as any);

    const {helpers} = createHelpers({
      store,
      workspace: "/app",
      currentThreadId: "thread-old-sidecar",
      sessionKind: "sidecar",
      sessionMetadata: {
        sidecar: {
          kind: "sidecar",
          parentSessionId: "session-main",
          sidecarKey: "memory_guard",
        },
      },
    });

    const result = await helpers.handleResetSession({
      source: "operator",
      sessionId: "sidecar-memory_guard-session-main",
    });

    expect(result.previousThreadId).toBe("thread-old-sidecar");
    expect(result.threadId).not.toBe("thread-old-sidecar");
    await expect(store.getThread(String(result.threadId))).resolves.toMatchObject({
      sessionId: "sidecar-memory_guard-session-main",
      promptCacheKey: expect.stringMatching(/^sidecar:memory_guard:[a-f0-9]{12}$/),
      context: {
        agentKey: "panda",
        sessionId: "sidecar-memory_guard-session-main",
        cwd: "/app",
        sidecar: {
          kind: "sidecar",
          parentSessionId: "session-main",
          sidecarKey: "memory_guard",
        },
      },
    });
  });
});
