import {afterEach, describe, expect, it, vi} from "vitest";
import {DataType, newDb} from "pg-mem";

import {PostgresAgentStore} from "../src/domain/agents/index.js";
import type {
    DisposableEnvironmentCreateRequest,
    DisposableEnvironmentCreateResult,
    ExecutionEnvironmentManager,
} from "../src/domain/execution-environments/types.js";
import {PostgresExecutionEnvironmentStore} from "../src/domain/execution-environments/postgres.js";
import {PostgresIdentityStore} from "../src/domain/identity/index.js";
import {PostgresSessionStore} from "../src/domain/sessions/index.js";
import {ExecutionEnvironmentResolver} from "../src/app/runtime/execution-environment-resolver.js";
import {ExecutionEnvironmentLifecycleService} from "../src/app/runtime/execution-environment-service.js";
import {buildSubagentSessionMetadata} from "../src/domain/subagents/index.js";

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

  function persistedEnvironmentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: "env-worker",
      agent_key: "panda",
      kind: "disposable_container",
      state: "ready",
      runner_url: null,
      runner_cwd: null,
      root_path: null,
      created_by_session_id: null,
      created_for_session_id: null,
      expires_at: null,
      metadata: null,
      created_at: new Date(1),
      updated_at: new Date(1),
      ...overrides,
    };
  }

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
      id: "session-main",
      agentKey: "panda",
      kind: "main",
      currentThreadId: "thread-main",
    });
    await sessionStore.createSession({
      id: "session-worker",
      agentKey: "panda",
      kind: "worker",
      currentThreadId: "thread-worker",
    });

    return {
      environmentStore,
      pool,
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
        envKeys: [" NPM_TOKEN ", ""],
      },
      skillPolicy: {
        mode: "allowlist",
        skillKeys: [" calendar ", ""],
      },
      toolPolicy: {
        allowedTools: [" bash ", "message_agent", ""],
        agentSkill: {allowedOperations: [" load ", "set", "bogus"]},
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
      toolPolicy: {
        allowedTools: ["bash", "message_agent"],
        agentSkill: {allowedOperations: ["load", "set"]},
      },
    });
  });

  it("rejects invalid environment metadata before persistence", async () => {
    const {environmentStore} = await createHarness();

    await expect(environmentStore.createEnvironment({
      id: "env-bad-metadata",
      agentKey: "panda",
      kind: "disposable_container",
      metadata: Number.NaN,
    })).rejects.toThrow("Execution environment metadata must be JSON-serializable.");
  });

  it("rejects unsupported persisted environment kinds", async () => {
    const {environmentStore, pool} = await createHarness();

    await pool.query(`
      INSERT INTO "runtime"."execution_environments" (
        id,
        agent_key,
        kind,
        state
      ) VALUES (
        'env-bad-kind',
        'panda',
        'sidecar',
        'ready'
      )
    `);

    await expect(environmentStore.getEnvironment("env-bad-kind"))
      .rejects.toThrow("Unsupported execution environment kind sidecar.");
  });

  it("rejects malformed persisted environment string fields", async () => {
    const environmentStore = new PostgresExecutionEnvironmentStore({
      pool: {
        query: vi.fn(async () => ({
          rows: [persistedEnvironmentRow({runner_url: 42})],
        })),
      },
    });

    await expect(environmentStore.getEnvironment("env-worker")).rejects.toThrow(
      "environment runner url must be a string.",
    );
  });

  it("rejects non-boolean persisted default binding flags", async () => {
    const now = new Date();
    const environmentStore = new PostgresExecutionEnvironmentStore({
      pool: {
        query: vi.fn(async () => ({
          rows: [{
            session_id: "session-worker",
            environment_id: "env-worker",
            alias: "self",
            is_default: "yes",
            credential_policy: {mode: "none"},
            skill_policy: {mode: "none"},
            tool_policy: {},
            created_at: now,
            updated_at: now,
          }],
        })),
      },
    });

    await expect(environmentStore.listBindingsForEnvironments(["env-worker"])).rejects.toThrow(
      "environment binding is_default must be a boolean.",
    );
  });

  it("lists parent-owned disposable environments and their bindings", async () => {
    const {environmentStore} = await createHarness();
    await environmentStore.createEnvironment({
      id: "env-owned",
      agentKey: "panda",
      kind: "disposable_container",
      createdBySessionId: "session-main",
    });
    await environmentStore.createEnvironment({
      id: "env-other",
      agentKey: "panda",
      kind: "disposable_container",
      createdBySessionId: "session-worker",
    });
    await environmentStore.bindSession({
      sessionId: "session-worker",
      environmentId: "env-owned",
      alias: "self",
      isDefault: true,
    });

    await expect(environmentStore.listDisposableEnvironmentsByOwner({
      agentKey: "panda",
      createdBySessionId: "session-main",
    })).resolves.toMatchObject([
      {id: "env-owned"},
    ]);
    await expect(environmentStore.listBindingsForEnvironments(["env-owned"]))
      .resolves.toMatchObject([
        {sessionId: "session-worker", environmentId: "env-owned"},
      ]);
    await expect(environmentStore.listBindingsForEnvironments([])).resolves.toEqual([]);
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
    const session = await sessionStore.getSession("session-main");
    const resolver = new ExecutionEnvironmentResolver({
      store: environmentStore,
      env: {
        BASH_EXECUTION_MODE: "remote",
        BASH_SERVER_URL_TEMPLATE: "http://runner-{agentKey}:8080",
        BASH_SERVER_CWD_TEMPLATE: "/root/.panda/agents/{agentKey}",
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
        BASH_SERVER_URL_TEMPLATE: "http://runner-{agentKey}:8080",
        BASH_SERVER_CWD_TEMPLATE: "/root/.panda/agents/{agentKey}",
      } as NodeJS.ProcessEnv,
    });

    await expect(resolver.resolveDefault(session)).rejects.toThrow(
      "Worker session session-worker has no default execution environment binding.",
    );
  });


  it("resolves agent-workspace subagent fallback with snapshotted policies", async () => {
    const {environmentStore, sessionStore} = await createHarness();
    const metadata = buildSubagentSessionMetadata({
      role: "workspace",
      task: "Inspect files.",
      parentSessionId: "session-main",
      execution: "agent_workspace",
      profile: {
        slug: "workspace",
        source: "builtin",
        description: "Workspace reader.",
        prompt: "Use workspace tools.",
        toolGroups: ["core", "workspace_read"],
        transcriptMode: "none",
      },
      resolved: {
        credentialPolicy: {mode: "allowlist", envKeys: ["NPM_TOKEN"]},
        skillPolicy: {mode: "all_agent"},
        toolPolicy: {
          allowedTools: ["message_agent", "agent_skill"],
          agentSkill: {allowedOperations: ["load"]},
        },
      },
    });
    await sessionStore.createSession({
      id: "session-subagent",
      agentKey: "panda",
      kind: "subagent",
      currentThreadId: "thread-subagent",
      metadata,
    });
    const session = await sessionStore.getSession("session-subagent");
    const resolver = new ExecutionEnvironmentResolver({
      store: environmentStore,
      env: {
        BASH_EXECUTION_MODE: "remote",
        BASH_SERVER_URL_TEMPLATE: "http://runner-{agentKey}:8080",
        BASH_SERVER_CWD_TEMPLATE: "/root/.panda/agents/{agentKey}",
      } as NodeJS.ProcessEnv,
    });

    await expect(resolver.resolveDefault(session)).resolves.toMatchObject({
      id: "persistent_agent_runner:panda",
      source: "fallback",
      credentialPolicy: {mode: "allowlist", envKeys: ["NPM_TOKEN"]},
      skillPolicy: {mode: "all_agent"},
      toolPolicy: {
        allowedTools: ["message_agent", "agent_skill"],
        agentSkill: {allowedOperations: ["load"]},
      },
    });
  });

  it("does not restart stopped isolated subagent environments during resolution", async () => {
    const {environmentStore, sessionStore} = await createHarness();
    const metadata = buildSubagentSessionMetadata({
      role: "workspace",
      task: "Inspect files.",
      parentSessionId: "session-main",
      execution: "isolated_environment",
      environmentId: "env-subagent",
      profile: {
        slug: "workspace",
        source: "builtin",
        description: "Workspace reader.",
        prompt: "Use workspace tools.",
        toolGroups: ["core", "workspace_read"],
        transcriptMode: "none",
      },
      resolved: {
        credentialPolicy: {mode: "allowlist", envKeys: []},
        skillPolicy: {mode: "all_agent"},
        toolPolicy: {
          allowedTools: ["message_agent", "agent_skill"],
          agentSkill: {allowedOperations: ["load"]},
        },
      },
    });
    await sessionStore.createSession({
      id: "session-subagent",
      agentKey: "panda",
      kind: "subagent",
      currentThreadId: "thread-subagent",
      metadata,
    });
    await environmentStore.createEnvironment({
      id: "env-subagent",
      agentKey: "panda",
      kind: "disposable_container",
      state: "stopped",
      runnerUrl: "http://old-worker:8080",
      runnerCwd: "/workspace",
      createdBySessionId: "session-main",
    });
    await environmentStore.bindSession({
      sessionId: "session-subagent",
      environmentId: "env-subagent",
      alias: "self",
      isDefault: true,
      credentialPolicy: {mode: "allowlist", envKeys: []},
      skillPolicy: {mode: "all_agent"},
      toolPolicy: {
        allowedTools: ["message_agent", "agent_skill"],
        agentSkill: {allowedOperations: ["load"]},
      },
    });
    const manager = new FakeEnvironmentManager();
    const service = new ExecutionEnvironmentLifecycleService({
      store: environmentStore,
      manager,
    });
    const resolver = new ExecutionEnvironmentResolver({
      store: environmentStore,
      lifecycle: service,
      env: {} as NodeJS.ProcessEnv,
    });
    const session = await sessionStore.getSession("session-subagent");

    await expect(resolver.resolveDefault(session)).rejects.toThrow("Execution environment env-subagent is stopped.");
    expect(manager.requests).toEqual([]);
    expect(manager.stopped).toEqual([]);
  });


  it("rejects non-disposable ready isolated subagent environments without lifecycle calls", async () => {
    const {environmentStore, sessionStore} = await createHarness();
    const manager = new FakeEnvironmentManager();
    const service = new ExecutionEnvironmentLifecycleService({
      store: environmentStore,
      manager,
    });
    const ensureSpy = vi.spyOn(service, "ensureBoundEnvironmentReady");
    const resolver = new ExecutionEnvironmentResolver({
      store: environmentStore,
      lifecycle: service,
      env: {} as NodeJS.ProcessEnv,
    });

    for (const environment of [
      {id: "env-local-subagent", kind: "local" as const},
      {id: "env-persistent-subagent", kind: "persistent_agent_runner" as const, runnerUrl: "http://runner:8080"},
    ]) {
      const metadata = buildSubagentSessionMetadata({
        role: "workspace",
        task: "Inspect files.",
        parentSessionId: "session-main",
        execution: "isolated_environment",
        environmentId: environment.id,
        profile: {
          slug: "workspace",
          source: "builtin",
          description: "Workspace reader.",
          prompt: "Use workspace tools.",
          toolGroups: ["core", "workspace_read"],
          transcriptMode: "none",
        },
        resolved: {
          credentialPolicy: {mode: "allowlist", envKeys: []},
          skillPolicy: {mode: "all_agent"},
          toolPolicy: {
            allowedTools: ["message_agent", "agent_skill"],
            agentSkill: {allowedOperations: ["load"]},
          },
        },
      });
      await sessionStore.createSession({
        id: `session-${environment.id}`,
        agentKey: "panda",
        kind: "subagent",
        currentThreadId: `thread-${environment.id}`,
        metadata,
      });
      await environmentStore.createEnvironment({
        id: environment.id,
        agentKey: "panda",
        kind: environment.kind,
        state: "ready",
        runnerUrl: environment.runnerUrl,
        runnerCwd: "/workspace",
        createdBySessionId: "session-main",
      });
      await environmentStore.bindSession({
        sessionId: `session-${environment.id}`,
        environmentId: environment.id,
        alias: "self",
        isDefault: true,
        credentialPolicy: {mode: "allowlist", envKeys: []},
        skillPolicy: {mode: "all_agent"},
        toolPolicy: {
          allowedTools: ["message_agent", "agent_skill"],
          agentSkill: {allowedOperations: ["load"]},
        },
      });
      const session = await sessionStore.getSession(`session-${environment.id}`);

      await expect(resolver.resolveDefault(session)).rejects.toThrow(
        `Isolated subagent session session-${environment.id} requires a disposable execution environment, got ${environment.kind}.`,
      );
    }

    expect(ensureSpy).not.toHaveBeenCalled();
    expect(manager.requests).toEqual([]);
    expect(manager.stopped).toEqual([]);
  });

  it("rejects isolated subagent bindings that differ from metadata environment id without lifecycle calls", async () => {
    const {environmentStore, sessionStore} = await createHarness();
    const metadata = buildSubagentSessionMetadata({
      role: "workspace",
      task: "Inspect files.",
      parentSessionId: "session-main",
      execution: "isolated_environment",
      environmentId: "env-required",
      profile: {
        slug: "workspace",
        source: "builtin",
        description: "Workspace reader.",
        prompt: "Use workspace tools.",
        toolGroups: ["core", "workspace_read"],
        transcriptMode: "none",
      },
      resolved: {
        credentialPolicy: {mode: "allowlist", envKeys: []},
        skillPolicy: {mode: "all_agent"},
        toolPolicy: {
          allowedTools: ["message_agent", "agent_skill"],
          agentSkill: {allowedOperations: ["load"]},
        },
      },
    });
    await sessionStore.createSession({
      id: "session-subagent-mismatch",
      agentKey: "panda",
      kind: "subagent",
      currentThreadId: "thread-subagent-mismatch",
      metadata,
    });
    await environmentStore.createEnvironment({
      id: "env-bound",
      agentKey: "panda",
      kind: "disposable_container",
      state: "ready",
      runnerUrl: "http://worker:8080",
      runnerCwd: "/workspace",
      createdBySessionId: "session-main",
    });
    await environmentStore.bindSession({
      sessionId: "session-subagent-mismatch",
      environmentId: "env-bound",
      alias: "self",
      isDefault: true,
      credentialPolicy: {mode: "allowlist", envKeys: []},
      skillPolicy: {mode: "all_agent"},
      toolPolicy: {
        allowedTools: ["message_agent", "agent_skill"],
        agentSkill: {allowedOperations: ["load"]},
      },
    });
    const manager = new FakeEnvironmentManager();
    const service = new ExecutionEnvironmentLifecycleService({
      store: environmentStore,
      manager,
    });
    const ensureSpy = vi.spyOn(service, "ensureBoundEnvironmentReady");
    const resolver = new ExecutionEnvironmentResolver({
      store: environmentStore,
      lifecycle: service,
      env: {} as NodeJS.ProcessEnv,
    });
    const session = await sessionStore.getSession("session-subagent-mismatch");

    await expect(resolver.resolveDefault(session)).rejects.toThrow(
      "Isolated subagent session session-subagent-mismatch is bound to environment env-bound, but metadata requires env-required.",
    );
    expect(ensureSpy).not.toHaveBeenCalled();
    expect(manager.requests).toEqual([]);
    expect(manager.stopped).toEqual([]);
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

  it("rejects expired bound environments before bash can use them without lifecycle recovery", async () => {
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

  it("restarts expired bound disposable environments during resolution", async () => {
    const {environmentStore, sessionStore} = await createHarness();
    await environmentStore.createEnvironment({
      id: "env-worker",
      agentKey: "panda",
      kind: "disposable_container",
      state: "ready",
      runnerUrl: "http://old-worker:8080",
      runnerCwd: "/workspace",
      expiresAt: Date.now() - 1_000,
      createdBySessionId: "session-main",
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
    const manager = new FakeEnvironmentManager();
    const service = new ExecutionEnvironmentLifecycleService({
      store: environmentStore,
      manager,
    });
    const resolver = new ExecutionEnvironmentResolver({
      store: environmentStore,
      lifecycle: service,
      env: {} as NodeJS.ProcessEnv,
    });

    await expect(resolver.resolveDefault(session)).resolves.toMatchObject({
      id: "env-worker",
      state: "ready",
      runnerUrl: "http://env-worker:8080",
    });
    expect(manager.requests[0]).toMatchObject({
      agentKey: "panda",
      sessionId: "session-main",
      environmentId: "env-worker",
    });
    expect(manager.requests[0]?.ttlMs).toBeGreaterThan(0);
    await expect(environmentStore.getEnvironment("env-worker")).resolves.toMatchObject({
      state: "ready",
      runnerUrl: "http://env-worker:8080",
    });
    expect((await environmentStore.getEnvironment("env-worker")).expiresAt).toBeGreaterThan(Date.now());
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
        metadata: {
          role: "research",
          containerName: "env-worker",
        },
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

  it("creates standalone parent-owned disposable environments", async () => {
    const {environmentStore} = await createHarness();
    const manager = new FakeEnvironmentManager();
    const service = new ExecutionEnvironmentLifecycleService({
      store: environmentStore,
      manager,
    });

    const environment = await service.createStandaloneDisposableEnvironment({
      agentKey: "panda",
      createdBySessionId: "session-main",
      ttlMs: 60_000,
      metadata: {
        label: "shared env",
      },
    });

    expect(environment).toMatchObject({
      agentKey: "panda",
      kind: "disposable_container",
      state: "ready",
      createdBySessionId: "session-main",
    });
    expect(environment.createdForSessionId).toBeUndefined();
    expect(manager.requests).toEqual([
      {
        agentKey: "panda",
        sessionId: "session-main",
        environmentId: environment.id,
        ttlMs: 60_000,
        metadata: {
          label: "shared env",
        },
      },
    ]);
  });

  it("attaches worker sessions to existing ready disposable environments", async () => {
    const {environmentStore, sessionStore} = await createHarness();
    const session = await sessionStore.getSession("session-worker");
    const manager = new FakeEnvironmentManager();
    const service = new ExecutionEnvironmentLifecycleService({
      store: environmentStore,
      manager,
    });
    await environmentStore.createEnvironment({
      id: "env-shared",
      agentKey: "panda",
      kind: "disposable_container",
      state: "ready",
      runnerUrl: "http://env-shared:8080",
      runnerCwd: "/workspace",
      createdBySessionId: "session-main",
    });

    await expect(service.attachSessionToDisposableEnvironment({
      session,
      environmentId: "env-shared",
      ownerSessionId: "session-main",
      credentialPolicy: {mode: "allowlist", envKeys: []},
      skillPolicy: {mode: "allowlist", skillKeys: []},
    })).resolves.toMatchObject({
      environment: {
        id: "env-shared",
        state: "ready",
      },
      binding: {
        sessionId: "session-worker",
        environmentId: "env-shared",
      },
    });
    expect(manager.requests).toEqual([]);
  });



  it("attaches ready disposable environments only when the requested owner matches", async () => {
    const {environmentStore, sessionStore} = await createHarness();
    const session = await sessionStore.getSession("session-worker");
    const manager = new FakeEnvironmentManager();
    const service = new ExecutionEnvironmentLifecycleService({
      store: environmentStore,
      manager,
    });
    await environmentStore.createEnvironment({
      id: "env-ready-owned",
      agentKey: "panda",
      kind: "disposable_container",
      state: "ready",
      runnerUrl: "http://env-ready-owned:8080",
      runnerCwd: "/workspace",
      createdBySessionId: "session-main",
    });
    await environmentStore.createEnvironment({
      id: "env-ready-wrong-owner",
      agentKey: "panda",
      kind: "disposable_container",
      state: "ready",
      runnerUrl: "http://env-ready-wrong-owner:8080",
      runnerCwd: "/workspace",
      createdBySessionId: "session-worker",
    });

    await expect(service.attachReadySessionToDisposableEnvironment({
      session,
      environmentId: "env-ready-owned",
      ownerSessionId: "session-main",
      credentialPolicy: {mode: "allowlist", envKeys: []},
      skillPolicy: {mode: "all_agent"},
    })).resolves.toMatchObject({
      environment: {
        id: "env-ready-owned",
        state: "ready",
      },
      binding: {
        sessionId: "session-worker",
        environmentId: "env-ready-owned",
      },
    });
    await expect(service.attachReadySessionToDisposableEnvironment({
      session,
      environmentId: "env-ready-wrong-owner",
      ownerSessionId: "session-main",
    })).rejects.toThrow("Execution environment env-ready-wrong-owner is not owned by session session-main.");
    expect(manager.requests).toEqual([]);
    expect(manager.stopped).toEqual([]);
  });

  it("restarts stopped disposable environments before attaching workers", async () => {
    const {environmentStore, sessionStore} = await createHarness();
    const session = await sessionStore.getSession("session-worker");
    const manager = new FakeEnvironmentManager();
    const service = new ExecutionEnvironmentLifecycleService({
      store: environmentStore,
      manager,
    });
    await environmentStore.createEnvironment({
      id: "env-stopped",
      agentKey: "panda",
      kind: "disposable_container",
      state: "stopped",
      runnerUrl: "http://old-env:8080",
      runnerCwd: "/workspace",
      createdBySessionId: "session-main",
      expiresAt: Date.now() + 60_000,
    });

    await expect(service.attachSessionToDisposableEnvironment({
      session,
      environmentId: "env-stopped",
      ownerSessionId: "session-main",
    })).resolves.toMatchObject({
      environment: {
        id: "env-stopped",
        state: "ready",
        runnerUrl: "http://env-stopped:8080",
      },
      binding: {
        sessionId: "session-worker",
        environmentId: "env-stopped",
      },
    });
    expect(manager.requests[0]).toMatchObject({
      agentKey: "panda",
      sessionId: "session-main",
      environmentId: "env-stopped",
    });
  });

  it("restarts expired disposable environments before attaching workers", async () => {
    const {environmentStore, sessionStore} = await createHarness();
    const session = await sessionStore.getSession("session-worker");
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
      runnerUrl: "http://old-env:8080",
      runnerCwd: "/workspace",
      createdBySessionId: "session-main",
      expiresAt: Date.now() - 1_000,
    });

    await expect(service.attachSessionToDisposableEnvironment({
      session,
      environmentId: "env-expired",
      ownerSessionId: "session-main",
    })).resolves.toMatchObject({
      environment: {
        id: "env-expired",
        state: "ready",
        runnerUrl: "http://env-expired:8080",
      },
      binding: {
        sessionId: "session-worker",
        environmentId: "env-expired",
      },
    });
    expect(manager.requests[0]).toMatchObject({
      agentKey: "panda",
      sessionId: "session-main",
      environmentId: "env-expired",
    });
    expect(manager.requests[0]?.ttlMs).toBeGreaterThan(0);
    expect((await environmentStore.getEnvironment("env-expired")).expiresAt).toBeGreaterThan(Date.now());
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
