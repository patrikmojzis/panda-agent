import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";

import {PostgresAgentStore} from "../src/domain/agents/index.js";
import type {
    DisposableEnvironmentCreateRequest,
    DisposableEnvironmentCreateResult,
    ExecutionEnvironmentManager,
} from "../src/domain/execution-environments/index.js";
import {PostgresExecutionEnvironmentStore} from "../src/domain/execution-environments/index.js";
import {PostgresIdentityStore} from "../src/domain/identity/index.js";
import {PostgresSessionStore} from "../src/domain/sessions/index.js";
import {ExecutionEnvironmentResolver} from "../src/app/runtime/execution-environment-resolver.js";
import {ExecutionEnvironmentLifecycleService} from "../src/app/runtime/execution-environment-service.js";

class FakeEnvironmentManager implements ExecutionEnvironmentManager {
  readonly requests: DisposableEnvironmentCreateRequest[] = [];
  readonly stopped: string[] = [];

  async createDisposableEnvironment(
    input: DisposableEnvironmentCreateRequest,
  ): Promise<DisposableEnvironmentCreateResult> {
    this.requests.push(input);
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

describe("PostgresExecutionEnvironmentStore", () => {
  const pools: Array<{ end(): Promise<void> }> = [];

  afterEach(async () => {
    while (pools.length > 0) {
      await pools.pop()?.end();
    }
  });

  async function createHarness() {
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

    const identityStore = new PostgresIdentityStore({pool});
    const agentStore = new PostgresAgentStore({pool});
    const sessionStore = new PostgresSessionStore({pool});
    const environmentStore = new PostgresExecutionEnvironmentStore({pool});
    await identityStore.ensureSchema();
    await agentStore.ensureAgentTableSchema();
    await sessionStore.ensureSchema();
    await environmentStore.ensureSchema();
    await agentStore.bootstrapAgent({
      agentKey: "panda",
      displayName: "Panda",
      prompts: {},
    });
    await sessionStore.createSession({
      id: "session-worker",
      agentKey: "panda",
      kind: "worker",
      currentThreadId: "thread-worker",
    });

    return {
      environmentStore,
      sessionStore,
    };
  }

  it("stores environments and default session bindings", async () => {
    const {environmentStore} = await createHarness();

    await environmentStore.createEnvironment({
      id: "env-worker",
      agentKey: "panda",
      kind: "disposable_container",
      runnerUrl: "http://worker:8080",
      runnerCwd: "/workspace",
      createdForSessionId: "session-worker",
    });
    await environmentStore.bindSession({
      sessionId: "session-worker",
      environmentId: "env-worker",
      alias: "self",
      isDefault: true,
      credentialPolicy: {
        mode: "allowlist",
        envKeys: ["NPM_TOKEN"],
      },
      skillPolicy: {
        mode: "allowlist",
        skillKeys: ["calendar"],
      },
    });

    await expect(environmentStore.getDefaultBinding("session-worker")).resolves.toMatchObject({
      environmentId: "env-worker",
      alias: "self",
      isDefault: true,
      credentialPolicy: {
        mode: "allowlist",
        envKeys: ["NPM_TOKEN"],
      },
      skillPolicy: {
        mode: "allowlist",
        skillKeys: ["calendar"],
      },
    });
  });

  it("defaults binding policies to no credentials and no skills", async () => {
    const {environmentStore} = await createHarness();

    await environmentStore.createEnvironment({
      id: "env-worker",
      agentKey: "panda",
      kind: "disposable_container",
    });
    await environmentStore.bindSession({
      sessionId: "session-worker",
      environmentId: "env-worker",
      alias: "self",
      isDefault: true,
    });

    await expect(environmentStore.getDefaultBinding("session-worker")).resolves.toMatchObject({
      credentialPolicy: {mode: "none"},
      skillPolicy: {mode: "none"},
    });
  });

  it("resolves fallback persistent runners for main sessions without a database binding", async () => {
    const {environmentStore, sessionStore} = await createHarness();
    await sessionStore.createSession({
      id: "session-main",
      agentKey: "panda",
      kind: "main",
      currentThreadId: "thread-main",
    });
    const session = await sessionStore.getSession("session-main");
    const resolver = new ExecutionEnvironmentResolver({
      store: environmentStore,
      env: {
        BASH_EXECUTION_MODE: "remote",
        RUNNER_URL_TEMPLATE: "http://runner-{agentKey}:8080",
        RUNNER_CWD_TEMPLATE: "/root/.panda/agents/{agentKey}",
      } as NodeJS.ProcessEnv,
    });

    await expect(resolver.resolveDefault(session)).resolves.toMatchObject({
      id: "persistent_agent_runner:panda",
      kind: "persistent_agent_runner",
      executionMode: "remote",
      runnerUrl: "http://runner-panda:8080",
      initialCwd: "/root/.panda/agents/panda",
      credentialPolicy: {
        mode: "all_agent",
      },
    });
  });

  it("rejects worker sessions without a default execution environment binding", async () => {
    const {environmentStore, sessionStore} = await createHarness();
    const session = await sessionStore.getSession("session-worker");
    const resolver = new ExecutionEnvironmentResolver({
      store: environmentStore,
      env: {
        BASH_EXECUTION_MODE: "remote",
        RUNNER_URL_TEMPLATE: "http://runner-{agentKey}:8080",
        RUNNER_CWD_TEMPLATE: "/root/.panda/agents/{agentKey}",
      } as NodeJS.ProcessEnv,
    });

    await expect(resolver.resolveDefault(session)).rejects.toThrow(
      "Worker session session-worker has no default execution environment binding.",
    );
  });

  it("resolves default bound environments", async () => {
    const {environmentStore, sessionStore} = await createHarness();
    await environmentStore.createEnvironment({
      id: "env-worker",
      agentKey: "panda",
      kind: "disposable_container",
      runnerUrl: "http://worker:8080",
      runnerCwd: "/workspace",
    });
    await environmentStore.bindSession({
      sessionId: "session-worker",
      environmentId: "env-worker",
      alias: "self",
      isDefault: true,
      credentialPolicy: {
        mode: "allowlist",
        envKeys: [],
      },
      skillPolicy: {
        mode: "allowlist",
        skillKeys: [],
      },
    });
    const session = await sessionStore.getSession("session-worker");
    const resolver = new ExecutionEnvironmentResolver({
      store: environmentStore,
      env: {} as NodeJS.ProcessEnv,
    });

    await expect(resolver.resolveDefault(session)).resolves.toMatchObject({
      id: "env-worker",
      kind: "disposable_container",
      runnerUrl: "http://worker:8080",
      initialCwd: "/workspace",
      credentialPolicy: {
        mode: "allowlist",
        envKeys: [],
      },
    });
  });

  it("rejects expired bound environments before bash can use them", async () => {
    const {environmentStore, sessionStore} = await createHarness();
    await environmentStore.createEnvironment({
      id: "env-worker",
      agentKey: "panda",
      kind: "disposable_container",
      runnerUrl: "http://worker:8080",
      runnerCwd: "/workspace",
      expiresAt: Date.now() - 1_000,
    });
    await environmentStore.bindSession({
      sessionId: "session-worker",
      environmentId: "env-worker",
      alias: "self",
      isDefault: true,
      credentialPolicy: {mode: "allowlist", envKeys: []},
      skillPolicy: {mode: "allowlist", skillKeys: []},
    });
    const session = await sessionStore.getSession("session-worker");
    const resolver = new ExecutionEnvironmentResolver({
      store: environmentStore,
      env: {} as NodeJS.ProcessEnv,
    });

    await expect(resolver.resolveDefault(session)).rejects.toThrow("Execution environment env-worker is expired.");
  });

  it("creates and binds disposable worker environments through the manager boundary", async () => {
    const {environmentStore, sessionStore} = await createHarness();
    const session = await sessionStore.getSession("session-worker");
    const manager = new FakeEnvironmentManager();
    const service = new ExecutionEnvironmentLifecycleService({
      store: environmentStore,
      manager,
    });

    await expect(service.createDisposableForSession({
      session,
      environmentId: "env-worker",
      metadata: {
        role: "research",
      },
    })).resolves.toMatchObject({
      environment: {
        id: "env-worker",
        state: "ready",
        runnerUrl: "http://env-worker:8080",
        runnerCwd: "/workspace",
      },
      binding: {
        sessionId: "session-worker",
        environmentId: "env-worker",
        alias: "self",
        isDefault: true,
        credentialPolicy: {
          mode: "allowlist",
          envKeys: [],
        },
        skillPolicy: {
          mode: "allowlist",
          skillKeys: [],
        },
      },
    });
    expect(manager.requests).toEqual([
      {
        agentKey: "panda",
        sessionId: "session-worker",
        environmentId: "env-worker",
        metadata: {
          role: "research",
        },
      },
    ]);

    await expect(service.createDisposableForSession({
      session,
      environmentId: "env-worker",
      credentialPolicy: {
        mode: "allowlist",
        envKeys: ["DIFFERENT_TOKEN"],
      },
    })).rejects.toThrow("already exists with different policy");
  });

  it("sweeps expired disposable environments through the manager", async () => {
    const {environmentStore} = await createHarness();
    const manager = new FakeEnvironmentManager();
    const service = new ExecutionEnvironmentLifecycleService({
      store: environmentStore,
      manager,
    });
    await environmentStore.createEnvironment({
      id: "env-expired",
      agentKey: "panda",
      kind: "disposable_container",
      state: "ready",
      runnerUrl: "http://worker:8080",
      runnerCwd: "/workspace",
      expiresAt: Date.now() - 1_000,
    });

    await expect(service.sweepExpiredEnvironments()).resolves.toMatchObject({
      checked: 1,
      stopped: 1,
      failed: 0,
    });
    expect(manager.stopped).toEqual(["env-expired"]);
    await expect(environmentStore.getEnvironment("env-expired")).resolves.toMatchObject({
      state: "stopped",
    });
  });

  it("sweeps only ready expired disposable environments", async () => {
    const {environmentStore} = await createHarness();
    const manager = new FakeEnvironmentManager();
    const service = new ExecutionEnvironmentLifecycleService({
      store: environmentStore,
      manager,
    });
    const expiresAt = Date.now() - 1_000;
    for (const state of ["ready", "stopping", "stopped", "failed"] as const) {
      await environmentStore.createEnvironment({
        id: `env-expired-${state}`,
        agentKey: "panda",
        kind: "disposable_container",
        state,
        runnerUrl: `http://worker-${state}:8080`,
        runnerCwd: "/workspace",
        expiresAt,
      });
    }

    await expect(service.sweepExpiredEnvironments()).resolves.toMatchObject({
      checked: 1,
      stopped: 1,
      failed: 0,
    });
    expect(manager.stopped).toEqual(["env-expired-ready"]);
    await expect(environmentStore.getEnvironment("env-expired-ready")).resolves.toMatchObject({
      state: "stopped",
    });
    await expect(environmentStore.getEnvironment("env-expired-stopping")).resolves.toMatchObject({
      state: "stopping",
    });
    await expect(environmentStore.getEnvironment("env-expired-stopped")).resolves.toMatchObject({
      state: "stopped",
    });
    await expect(environmentStore.getEnvironment("env-expired-failed")).resolves.toMatchObject({
      state: "failed",
    });
  });
});
