import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";

import {DEFAULT_WORKER_ENVIRONMENT_TTL_MS, WorkerSessionService,} from "../src/app/runtime/worker-session-service.js";
import {ExecutionEnvironmentLifecycleService} from "../src/app/runtime/execution-environment-service.js";
import {
    type DisposableEnvironmentCreateRequest,
    type DisposableEnvironmentCreateResult,
    type ExecutionEnvironmentManager,
    PostgresExecutionEnvironmentStore,
} from "../src/domain/execution-environments/index.js";
import {createSessionWithInitialThread} from "../src/domain/sessions/index.js";
import {createRuntimeStores} from "./helpers/runtime-store-setup.js";

class FakeEnvironmentManager implements ExecutionEnvironmentManager {
  readonly requests: DisposableEnvironmentCreateRequest[] = [];
  readonly stopped: string[] = [];
  createError?: Error;

  async createDisposableEnvironment(
    input: DisposableEnvironmentCreateRequest,
  ): Promise<DisposableEnvironmentCreateResult> {
    this.requests.push(input);
    if (this.createError) {
      throw this.createError;
    }
    return {
      runnerUrl: `http://${input.environmentId}:8080`,
      runnerCwd: "/workspace",
      rootPath: "/workspace",
      metadata: {
        containerName: input.environmentId,
      },
    };
  }

  async stopEnvironment(environmentId: string): Promise<void> {
    this.stopped.push(environmentId);
  }
}

function createPool() {
  const db = newDb();
  db.public.registerFunction({
    name: "pg_notify",
    args: [DataType.text, DataType.text],
    returns: DataType.text,
    implementation: () => "",
  });
  const adapter = db.adapters.createPg();
  return new adapter.Pool();
}

describe("WorkerSessionService", () => {
  const pools: Array<{end(): Promise<void>}> = [];

  afterEach(async () => {
    while (pools.length > 0) {
      await pools.pop()?.end();
    }
  });

  it("creates a worker session with an isolated default environment and queued handoff", async () => {
    const pool = createPool();
    pools.push(pool);
    const {sessionStore, threadStore} = await createRuntimeStores(pool);
    const environmentStore = new PostgresExecutionEnvironmentStore({pool});
    await environmentStore.ensureSchema();
    const manager = new FakeEnvironmentManager();
    const environments = new ExecutionEnvironmentLifecycleService({
      store: environmentStore,
      manager,
    });
    const workers = new WorkerSessionService({
      pool,
      sessions: sessionStore,
      threads: threadStore,
      environments,
      fallbackContext: {
        cwd: "/host/workspace",
      },
    });
    await createSessionWithInitialThread({
      pool,
      sessionStore,
      threadStore,
      session: {
        id: "main-session",
        agentKey: "panda",
        kind: "main",
        currentThreadId: "main-thread",
      },
      thread: {
        id: "main-thread",
        sessionId: "main-session",
      },
    });

    const created = await workers.createWorkerSession({
      sessionId: "worker-session",
      threadId: "worker-thread",
      agentKey: "panda",
      role: "research",
      task: "Inspect the package graph.",
      context: "Keep it read-only.",
      parentSessionId: "main-session",
      credentialAllowlist: ["NPM_TOKEN", "NPM_TOKEN", " GITHUB_TOKEN "],
      ttlMs: 60_000,
    });

    expect(created.session).toMatchObject({
      id: "worker-session",
      agentKey: "panda",
      kind: "worker",
      currentThreadId: "worker-thread",
    });
    expect(created.thread).toMatchObject({
      id: "worker-thread",
      sessionId: "worker-session",
      context: {
        cwd: "/host/workspace",
        agentKey: "panda",
        sessionId: "worker-session",
        worker: {
          role: "research",
          parentSessionId: "main-session",
        },
      },
    });
    expect(created.environment).toMatchObject({
      id: "worker:worker-session",
      agentKey: "panda",
      kind: "disposable_container",
      state: "ready",
      runnerUrl: "http://worker:worker-session:8080",
      runnerCwd: "/workspace",
      createdBySessionId: "main-session",
      createdForSessionId: "worker-session",
    });
    expect(created.binding).toMatchObject({
      sessionId: "worker-session",
      environmentId: "worker:worker-session",
      alias: "self",
      isDefault: true,
      credentialPolicy: {
        mode: "allowlist",
        envKeys: ["NPM_TOKEN", "GITHUB_TOKEN"],
      },
      skillPolicy: {
        mode: "allowlist",
        skillKeys: [],
      },
    });
    expect(manager.requests).toEqual([
      {
        agentKey: "panda",
        sessionId: "worker-session",
        environmentId: "worker:worker-session",
        ttlMs: 60_000,
        metadata: {
          worker: {
            role: "research",
            parentSessionId: "main-session",
          },
        },
      },
    ]);

    const pending = await threadStore.listPendingInputs("worker-thread");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      source: "worker",
      deliveryMode: "wake",
      metadata: {
        worker: {
          role: "research",
          parentSessionId: "main-session",
        },
      },
    });
    expect(String(pending[0]?.message.content)).toContain("Inspect the package graph.");
    expect(String(pending[0]?.message.content)).toContain("Put reviewable outputs in /artifacts.");
    expect(String(pending[0]?.message.content)).toContain('sessionId "main-session"');
    await expect(threadStore.hasRunnableInputs("worker-thread")).resolves.toBe(true);

    const retried = await workers.createWorkerSession({
      sessionId: "worker-session",
      threadId: "worker-thread",
      agentKey: "panda",
      role: "research",
      task: "Inspect the package graph.",
      context: "Keep it read-only.",
      parentSessionId: "main-session",
      credentialAllowlist: ["NPM_TOKEN", "GITHUB_TOKEN"],
      ttlMs: 60_000,
    });

    expect(retried.thread.id).toBe("worker-thread");
    expect(manager.requests).toHaveLength(1);
    await expect(threadStore.listPendingInputs("worker-thread")).resolves.toHaveLength(1);

    await expect(workers.createWorkerSession({
      sessionId: "worker-session",
      threadId: "worker-thread",
      agentKey: "panda",
      role: "writer",
      task: "Do something else.",
      parentSessionId: "main-session",
      credentialAllowlist: ["NPM_TOKEN", "GITHUB_TOKEN"],
      ttlMs: 60_000,
    })).rejects.toThrow("already exists with different input");
  });

  it("rolls back a newly created worker session when environment creation fails", async () => {
    const pool = createPool();
    pools.push(pool);
    const {sessionStore, threadStore} = await createRuntimeStores(pool);
    const environmentStore = new PostgresExecutionEnvironmentStore({pool});
    await environmentStore.ensureSchema();
    const manager = new FakeEnvironmentManager();
    manager.createError = new Error("Docker is unavailable");
    const environments = new ExecutionEnvironmentLifecycleService({
      store: environmentStore,
      manager,
    });
    const workers = new WorkerSessionService({
      pool,
      sessions: sessionStore,
      threads: threadStore,
      environments,
      fallbackContext: {
        cwd: "/host/workspace",
      },
    });

    await expect(workers.createWorkerSession({
      sessionId: "worker-session",
      threadId: "worker-thread",
      agentKey: "panda",
      task: "Try to work.",
    })).rejects.toThrow("Docker is unavailable");

    expect(manager.requests[0]?.ttlMs).toBe(DEFAULT_WORKER_ENVIRONMENT_TTL_MS);
    await expect(sessionStore.getSession("worker-session")).rejects.toThrow("Unknown session");
    await expect(threadStore.getThread("worker-thread")).rejects.toThrow("Unknown thread");
  });

  it("stops the environment and rolls back the worker when handoff setup fails", async () => {
    const pool = createPool();
    pools.push(pool);
    const {sessionStore, threadStore} = await createRuntimeStores(pool);
    const environmentStore = new PostgresExecutionEnvironmentStore({pool});
    await environmentStore.ensureSchema();
    const manager = new FakeEnvironmentManager();
    const environments = new ExecutionEnvironmentLifecycleService({
      store: environmentStore,
      manager,
    });
    const workers = new WorkerSessionService({
      pool,
      sessions: sessionStore,
      threads: threadStore,
      environments,
      fallbackContext: {
        cwd: "/host/workspace",
      },
    });

    await expect(workers.createWorkerSession({
      sessionId: "worker-session",
      threadId: "worker-thread",
      agentKey: "panda",
      task: "Try to work.",
      beforeHandoff: async () => {
        throw new Error("A2A bind failed");
      },
    })).rejects.toThrow("A2A bind failed");

    expect(manager.stopped).toEqual(["worker:worker-session"]);
    await expect(sessionStore.getSession("worker-session")).rejects.toThrow("Unknown session");
    await expect(threadStore.getThread("worker-thread")).rejects.toThrow("Unknown thread");
  });
});
