import {createDefaultExecutionToolPolicy} from "../src/panda/commands/agent-command-policy.js";
import {afterEach, describe, expect, it, vi} from "vitest";
import {DataType, newDb} from "pg-mem";

import {PostgresAgentStore} from "../src/domain/agents/index.js";
import {ensurePostgresAgentTableSchema} from "../src/domain/agents/postgres-schema.js";
import type {
    DisposableEnvironmentCreateRequest,
    DisposableEnvironmentCreateResult,
    DisposableEnvironmentCommandAccessRefreshRequest,
    ExecutionEnvironmentManager,
} from "../src/domain/execution-environments/types.js";
import {PostgresExecutionEnvironmentStore} from "../src/domain/execution-environments/postgres.js";
import {ensurePostgresExecutionEnvironmentSchema} from "../src/domain/execution-environments/postgres-schema.js";
import {PostgresIdentityStore} from "../src/domain/identity/index.js";
import {ensurePostgresIdentitySchema} from "../src/domain/identity/postgres-schema.js";
import {PostgresSessionStore} from "../src/domain/sessions/index.js";
import {ensurePostgresSessionSchema} from "../src/domain/sessions/postgres-schema.js";
import {ExecutionEnvironmentResolver} from "../src/app/runtime/execution-environment-resolver.js";
import {ExecutionEnvironmentLifecycleService} from "../src/app/runtime/execution-environment-service.js";
import {RuntimeCommandLeaseService} from "../src/app/runtime/command-leases.js";
import {DEFAULT_AGENT_COMMAND_CATALOG} from "../src/panda/commands/agent-command-modules.js";
import type {
  ExecutionEnvironmentSetupRunner,
  ExecutionEnvironmentSetupRunnerInput,
} from "../src/app/runtime/execution-environment-setup-runner.js";
import {ExecutionEnvironmentSetupError} from "../src/app/runtime/execution-environment-setup-runner.js";
import {buildSubagentSessionMetadata} from "../src/domain/subagents/session-metadata.js";
import type {JsonObject, JsonValue} from "../src/lib/json.js";
import {HmacRunnerTokenAuthority} from "../src/integrations/shell/runner-auth.js";
import {HttpExecutionEnvironmentManagerClient} from "../src/integrations/shell/execution-environment-manager-client.js";

function createFilesystemMetadata(envDir = "env-worker"): JsonObject {
  return {
    filesystem: {
      envDir,
      root: {
        corePath: `/core/environments/panda/${envDir}`,
        parentRunnerPath: `/environments/${envDir}`,
      },
      workspace: {
        corePath: `/core/environments/panda/${envDir}/workspace`,
        parentRunnerPath: `/environments/${envDir}/workspace`,
        workerPath: "/workspace",
      },
      inbox: {
        corePath: `/core/environments/panda/${envDir}/inbox`,
        parentRunnerPath: `/environments/${envDir}/inbox`,
        workerPath: "/inbox",
      },
      artifacts: {
        corePath: `/core/environments/panda/${envDir}/artifacts`,
        parentRunnerPath: `/environments/${envDir}/artifacts`,
        workerPath: "/artifacts",
      },
    },
  };
}

class FakeEnvironmentManager implements ExecutionEnvironmentManager {
  readonly requests: DisposableEnvironmentCreateRequest[] = [];
  readonly stopped: string[] = [];
  readonly commandAccessRefreshes: DisposableEnvironmentCommandAccessRefreshRequest[] = [];

  constructor(private readonly metadataFactory?: (input: DisposableEnvironmentCreateRequest) => JsonValue | undefined) {}

  async createDisposableEnvironment(
    input: DisposableEnvironmentCreateRequest,
  ): Promise<DisposableEnvironmentCreateResult> {
    this.requests.push(input);
    return {
      runnerUrl: `http://${input.environmentId}:8080`,
      runnerCwd: "/workspace",
      rootPath: "/workspace",
      metadata: this.metadataFactory?.(input) ?? {
        containerName: input.environmentId,
      },
    };
  }

  async stopEnvironment(environmentId: string): Promise<void> {
    this.stopped.push(environmentId);
  }

  async refreshCommandAccess(input: DisposableEnvironmentCommandAccessRefreshRequest): Promise<void> {
    this.commandAccessRefreshes.push(input);
  }
}

class FakeSetupRunner implements ExecutionEnvironmentSetupRunner {
  readonly inputs: ExecutionEnvironmentSetupRunnerInput[] = [];
  result: JsonObject = {
    setup: {
      status: "succeeded",
      artifacts: {
        script: "/artifacts/setup/setup.sh",
        stdout: "/artifacts/setup/stdout.log",
        stderr: "/artifacts/setup/stderr.log",
        result: "/artifacts/setup/setup-result.json",
        toolchain: "/artifacts/setup/toolchain.json",
      },
      toolchain: {
        status: "succeeded",
        tools: {
          node: {status: "present", path: "/usr/bin/node", version: "v99.1.0"},
          pnpm: {status: "present", path: "/usr/bin/pnpm", version: "10.33.0"},
          corepack: {status: "present", path: "/usr/bin/corepack", version: "0.34.0"},
        },
      },
    },
  };
  error?: Error;
  onRun?: (input: ExecutionEnvironmentSetupRunnerInput) => Promise<void> | void;

  async runSetup(input: ExecutionEnvironmentSetupRunnerInput): Promise<JsonObject> {
    this.inputs.push(input);
    await this.onRun?.(input);
    if (this.error) {
      throw this.error;
    }
    return this.result;
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
    await ensurePostgresIdentitySchema(pool);
    await ensurePostgresAgentTableSchema(pool);
    await ensurePostgresSessionSchema(pool);
    await ensurePostgresExecutionEnvironmentSchema(pool);
    await agentStore.bootstrapAgent({
      agentKey: "panda",
      displayName: "Panda",
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
        credentialRefs: [" mcp-oauth:reports ", ""],
      },
      skillPolicy: {
        mode: "allowlist",
        skillKeys: [" calendar ", ""],
      },
      toolPolicy: {
        allowedTools: [" bash ", "a2a.send", ""],
        agentSkill: {allowedOperations: [" load ", "set", " patch ", "bogus"]},
      },
    });

    await expect(environmentStore.getDefaultBinding("session-worker")).resolves.toMatchObject({
      environmentId: "env-worker",
      alias: "self",
      isDefault: true,
      credentialPolicy: {
        mode: "allowlist",
        envKeys: ["NPM_TOKEN"],
        credentialRefs: ["mcp-oauth:reports"],
      },
      skillPolicy: {
        mode: "allowlist",
        skillKeys: ["calendar"],
      },
      toolPolicy: {
        allowedTools: ["bash", "a2a.send"],
        agentSkill: {allowedOperations: ["load", "set", "patch"]},
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

  it("normalizes target aliases and enforces per-session uniqueness", async () => {
    const {environmentStore} = await createHarness();

    await environmentStore.createEnvironment({
      id: "env-vps",
      agentKey: "panda",
      kind: "persistent_agent_runner",
      runnerUrl: "http://vps:8080",
    });
    await environmentStore.createEnvironment({
      id: "env-other",
      agentKey: "panda",
      kind: "persistent_agent_runner",
      runnerUrl: "http://other:8080",
    });

    await expect(environmentStore.bindSession({
      sessionId: "session-main",
      environmentId: "env-vps",
      alias: " VPS ",
      isDefault: true,
    })).resolves.toMatchObject({
      alias: "vps",
    });

    await expect(environmentStore.getBindingByAlias("session-main", "vPs")).resolves.toMatchObject({
      sessionId: "session-main",
      environmentId: "env-vps",
      alias: "vps",
    });
    await expect(environmentStore.listBindingsForSession("session-main")).resolves.toMatchObject([
      {alias: "vps", environmentId: "env-vps"},
    ]);

    await expect(environmentStore.bindSession({
      sessionId: "session-main",
      environmentId: "env-other",
      alias: "vps",
    })).rejects.toThrow();
    await expect(environmentStore.bindSession({
      sessionId: "session-worker",
      environmentId: "env-other",
      alias: "vps",
    })).resolves.toMatchObject({
      sessionId: "session-worker",
      alias: "vps",
    });
    await expect(environmentStore.bindSession({
      sessionId: "session-main",
      environmentId: "env-other",
      alias: "default",
    })).rejects.toThrow("Execution environment alias 'default' is reserved.");
    await expect(environmentStore.bindSession({
      sessionId: "session-main",
      environmentId: "env-other",
      alias: "bad.alias",
    })).rejects.toThrow("Execution environment alias must use only lowercase letters");
  });

  it("resolves explicit aliases without falling through to other sessions", async () => {
    const {environmentStore, sessionStore} = await createHarness();
    await environmentStore.createEnvironment({
      id: "env-default",
      agentKey: "panda",
      kind: "local",
    });
    await environmentStore.createEnvironment({
      id: "env-vps",
      agentKey: "panda",
      kind: "persistent_agent_runner",
      runnerUrl: "http://vps:8080",
      runnerCwd: "/srv/panda",
    });
    await environmentStore.createEnvironment({
      id: "env-worker-only",
      agentKey: "panda",
      kind: "persistent_agent_runner",
      runnerUrl: "http://worker-only:8080",
    });
    await environmentStore.bindSession({
      sessionId: "session-main",
      environmentId: "env-default",
      alias: "self",
      isDefault: true,
    });
    await environmentStore.bindSession({
      sessionId: "session-main",
      environmentId: "env-vps",
      alias: "VPS",
    });
    await environmentStore.bindSession({
      sessionId: "session-worker",
      environmentId: "env-worker-only",
      alias: "worker",
    });

    const session = await sessionStore.getSession("session-main");
    const resolver = new ExecutionEnvironmentResolver({defaultToolPolicy: createDefaultExecutionToolPolicy(DEFAULT_AGENT_COMMAND_CATALOG), store: environmentStore});

    await expect(resolver.resolve(session)).resolves.toMatchObject({id: "env-default", alias: "self"});
    await expect(resolver.resolve(session, "default")).resolves.toMatchObject({id: "env-default", alias: "self"});
    await expect(resolver.resolve(session, " vPs ")).resolves.toMatchObject({
      id: "env-vps",
      alias: "vps",
      executionMode: "remote",
      runnerUrl: "http://vps:8080",
      initialCwd: "/srv/panda",
    });
    await expect(resolver.resolve(session, "worker")).rejects.toThrow(
      "Execution target worker is not bound to session session-main.",
    );
    await expect(resolver.resolve(session, "bad.alias")).rejects.toThrow(
      "Execution environment alias must use only lowercase letters",
    );
  });

  it("switches the session default target before inserting the new default", async () => {
    const {environmentStore} = await createHarness();
    await environmentStore.createEnvironment({
      id: "env-vps",
      agentKey: "panda",
      kind: "persistent_agent_runner",
      runnerUrl: "http://vps:8080",
    });
    await environmentStore.createEnvironment({
      id: "env-mac",
      agentKey: "panda",
      kind: "persistent_agent_runner",
      runnerUrl: "http://mac:8080",
    });

    await expect(environmentStore.bindSession({
      sessionId: "session-main",
      environmentId: "env-vps",
      alias: "vps",
      isDefault: true,
    })).resolves.toMatchObject({isDefault: true});
    await expect(environmentStore.bindSession({
      sessionId: "session-main",
      environmentId: "env-mac",
      alias: "mac",
      isDefault: true,
    })).resolves.toMatchObject({isDefault: true});

    await expect(environmentStore.getDefaultBinding("session-main")).resolves.toMatchObject({
      alias: "mac",
      environmentId: "env-mac",
      isDefault: true,
    });
    await expect(environmentStore.getBindingByAlias("session-main", "vps")).resolves.toMatchObject({
      alias: "vps",
      isDefault: false,
    });
    await expect(environmentStore.deleteBindingByAlias("session-main", "vps")).resolves.toBe(true);
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
      defaultToolPolicy: createDefaultExecutionToolPolicy(DEFAULT_AGENT_COMMAND_CATALOG),
      store: environmentStore,
      env: {
        BASH_EXECUTION_MODE: "remote",
        BASH_SERVER_URL_TEMPLATE: "http://runner-{agentKey}:8080",
        BASH_SERVER_CWD_TEMPLATE: "/root/.panda/agents/{agentKey}",
        BASH_SERVER_PERSISTENT_ROOTS_TEMPLATE: '["/root/.panda/agents/{agentKey}"]',
      } as NodeJS.ProcessEnv,
    });

    await expect(resolver.resolveDefault(session)).resolves.toMatchObject({
      id: "persistent_agent_runner:panda",
      kind: "persistent_agent_runner",
      executionMode: "remote",
      runnerUrl: "http://runner-panda:8080",
      initialCwd: "/root/.panda/agents/panda",
      persistentRoots: ["/root/.panda/agents/panda"],
      credentialPolicy: {
        mode: "all_agent",
      },
      toolPolicy: {
        allowedTools: expect.arrayContaining([
          "bash",
          "session.compact",
          "view_media",
          "mcp.*",
          "discord.voice.join",
          "discord.voice.leave",
          "discord.voice.status",
        ]),
        bash: {
          allowed: true,
        },
      },
    });
  });

  it.each(["local", "remote"])("does not infer storage retention from %s mode or cwd", async (mode) => {
    const {environmentStore, sessionStore} = await createHarness();
    const resolver = new ExecutionEnvironmentResolver({
      defaultToolPolicy: createDefaultExecutionToolPolicy(DEFAULT_AGENT_COMMAND_CATALOG),
      store: environmentStore,
      env: {
        BASH_EXECUTION_MODE: mode,
        BASH_SERVER_URL_TEMPLATE: "http://runner-{agentKey}:8080",
        BASH_SERVER_CWD_TEMPLATE: "/root/.panda/agents/{agentKey}",
        ...(mode === "local" ? {BASH_SERVER_PERSISTENT_ROOTS_TEMPLATE: '["/remote/home"]'} : {}),
      },
    });
    const resolved = await resolver.resolveDefault(await sessionStore.getSession("session-main"));
    expect(resolved.persistentRoots).toBeUndefined();
  });

  it.each(["not-json", '["relative/path"]', '["/safe", 1]', '["/safe\\nmisleading"]'])(
    "rejects malformed fallback storage declarations: %s", async (declaration) => {
      const {environmentStore, sessionStore} = await createHarness();
      const resolver = new ExecutionEnvironmentResolver({
        defaultToolPolicy: createDefaultExecutionToolPolicy(DEFAULT_AGENT_COMMAND_CATALOG),
        store: environmentStore,
        env: {
          BASH_EXECUTION_MODE: "remote",
          BASH_SERVER_PERSISTENT_ROOTS_TEMPLATE: declaration,
        },
      });
      await expect(resolver.resolveDefault(await sessionStore.getSession("session-main")))
        .rejects.toThrow("BASH_SERVER_PERSISTENT_ROOTS_TEMPLATE must be a JSON array of absolute runner paths.");
    },
  );

  it.each([
    {kind: "persistent_agent_runner" as const, storage: {persistentRoots: ["/Volumes/work", "/Volumes/work"]}, expected: ["/Volumes/work"]},
    {kind: "persistent_agent_runner" as const, storage: {persistentRoots: ["C:\\Users\\panda\\work"]}, expected: ["C:\\Users\\panda\\work"]},
    {kind: "persistent_agent_runner" as const, storage: {}, expected: undefined},
    {kind: "persistent_agent_runner" as const, storage: {persistentRoots: ["relative"]}, expected: undefined},
    {kind: "disposable_container" as const, storage: {persistentRoots: ["/artifacts"]}, expected: undefined},
  ])("uses only the bound target's valid non-disposable storage declaration ($kind, $storage)", async ({kind, storage, expected}) => {
    const {environmentStore, sessionStore} = await createHarness();
    await environmentStore.createEnvironment({
      id: "env-storage", agentKey: "panda", kind, state: "ready",
      runnerUrl: "http://custom:8080", runnerCwd: "/project/nested",
      metadata: {storage},
    });
    await environmentStore.bindSession({
      sessionId: "session-main", environmentId: "env-storage", alias: "custom", isDefault: true,
    });
    const resolver = new ExecutionEnvironmentResolver({
      defaultToolPolicy: createDefaultExecutionToolPolicy(DEFAULT_AGENT_COMMAND_CATALOG),
      store: environmentStore,
      env: {BASH_EXECUTION_MODE: "remote", BASH_SERVER_PERSISTENT_ROOTS_TEMPLATE: '["/fallback/home"]'},
    });
    const session = await sessionStore.getSession("session-main");
    for (const target of [undefined, "custom"]) {
      const resolved = await resolver.resolve(session, target);
      expect(resolved.initialCwd).toBe("/project/nested");
      expect(resolved.persistentRoots).toEqual(expected);
    }
  });

  it("rejects legacy worker sessions before environment resolution", async () => {
    const {environmentStore, sessionStore} = await createHarness();
    const session = await sessionStore.getSession("session-worker");
    const resolver = new ExecutionEnvironmentResolver({
      defaultToolPolicy: createDefaultExecutionToolPolicy(DEFAULT_AGENT_COMMAND_CATALOG),
      store: environmentStore,
      env: {
        BASH_EXECUTION_MODE: "remote",
        BASH_SERVER_URL_TEMPLATE: "http://runner-{agentKey}:8080",
        BASH_SERVER_CWD_TEMPLATE: "/root/.panda/agents/{agentKey}",
      } as NodeJS.ProcessEnv,
    });

    await expect(resolver.resolveDefault(session)).rejects.toThrow(
      "Legacy worker session session-worker is not supported after the subagent hard cut.",
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
        toolGroups: ["core"],
        transcriptMode: "none",
      },
      resolved: {
        credentialPolicy: {mode: "allowlist", envKeys: ["NPM_TOKEN"]},
        skillPolicy: {mode: "all_agent"},
        toolPolicy: {
          allowedTools: ["a2a.send", "a2a.inspect", "a2a.history", "skill.load"],
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
      defaultToolPolicy: createDefaultExecutionToolPolicy(DEFAULT_AGENT_COMMAND_CATALOG),
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
        allowedTools: ["a2a.send", "a2a.inspect", "a2a.history", "skill.load"],
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
        toolGroups: ["core"],
        transcriptMode: "none",
      },
      resolved: {
        credentialPolicy: {mode: "allowlist", envKeys: []},
        skillPolicy: {mode: "all_agent"},
        toolPolicy: {
          allowedTools: ["a2a.send", "a2a.inspect", "a2a.history", "skill.load"],
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
        allowedTools: ["a2a.send", "a2a.inspect", "a2a.history", "skill.load"],
        agentSkill: {allowedOperations: ["load"]},
      },
    });
    const manager = new FakeEnvironmentManager();
    const service = new ExecutionEnvironmentLifecycleService({
      store: environmentStore,
      manager,
    });
    const resolver = new ExecutionEnvironmentResolver({
      defaultToolPolicy: createDefaultExecutionToolPolicy(DEFAULT_AGENT_COMMAND_CATALOG),
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
      defaultToolPolicy: createDefaultExecutionToolPolicy(DEFAULT_AGENT_COMMAND_CATALOG),
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
          toolGroups: ["core"],
          transcriptMode: "none",
        },
        resolved: {
          credentialPolicy: {mode: "allowlist", envKeys: []},
          skillPolicy: {mode: "all_agent"},
          toolPolicy: {
            allowedTools: ["a2a.send", "a2a.inspect", "a2a.history", "skill.load"],
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
          allowedTools: ["a2a.send", "a2a.inspect", "a2a.history", "skill.load"],
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
        toolGroups: ["core"],
        transcriptMode: "none",
      },
      resolved: {
        credentialPolicy: {mode: "allowlist", envKeys: []},
        skillPolicy: {mode: "all_agent"},
        toolPolicy: {
          allowedTools: ["a2a.send", "a2a.inspect", "a2a.history", "skill.load"],
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
        allowedTools: ["a2a.send", "a2a.inspect", "a2a.history", "skill.load"],
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
      defaultToolPolicy: createDefaultExecutionToolPolicy(DEFAULT_AGENT_COMMAND_CATALOG),
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
      sessionId: "session-main",
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
    const session = await sessionStore.getSession("session-main");
    const resolver = new ExecutionEnvironmentResolver({
      defaultToolPolicy: createDefaultExecutionToolPolicy(DEFAULT_AGENT_COMMAND_CATALOG),
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
      sessionId: "session-main",
      environmentId: "env-worker",
      alias: "self",
      isDefault: true,
      credentialPolicy: {mode: "allowlist", envKeys: []},
      skillPolicy: {mode: "allowlist", skillKeys: []},
    });
    const session = await sessionStore.getSession("session-main");
    const resolver = new ExecutionEnvironmentResolver({
      defaultToolPolicy: createDefaultExecutionToolPolicy(DEFAULT_AGENT_COMMAND_CATALOG),
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
      sessionId: "session-main",
      environmentId: "env-worker",
      alias: "self",
      isDefault: true,
      credentialPolicy: {mode: "allowlist", envKeys: []},
      skillPolicy: {mode: "allowlist", skillKeys: []},
    });
    const session = await sessionStore.getSession("session-main");
    const manager = new FakeEnvironmentManager();
    const service = new ExecutionEnvironmentLifecycleService({
      store: environmentStore,
      manager,
    });
    const resolver = new ExecutionEnvironmentResolver({
      defaultToolPolicy: createDefaultExecutionToolPolicy(DEFAULT_AGENT_COMMAND_CATALOG),
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

  it.each(["create", "restart", "stop"] as const)("recovers %s after manager URL validation fails before dispatch", async (operation) => {
    const {environmentStore, sessionStore} = await createHarness();
    const session = await sessionStore.getSession("session-worker");
    const initialState = operation === "stop" ? "ready" : "stopped";
    let binding;
    if (operation !== "create") {
      await environmentStore.createEnvironment({id: "env-preflight", agentKey: "panda", kind: "disposable_container",
        state: initialState, createdForSessionId: session.id, metadata: {retained: true}});
      binding = await environmentStore.bindSession({sessionId: session.id, environmentId: "env-preflight", alias: "self",
        isDefault: true, credentialPolicy: {mode: "none"}, skillPolicy: {mode: "none"}, toolPolicy: {}});
    }
    const env = {PANDA_EXECUTION_ENVIRONMENT_MANAGER_URL: "not a URL"};
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ok: true,
      runnerUrl: "http://runner.invalid", runnerCwd: "/workspace"}), {status: 200}));
    const service = new ExecutionEnvironmentLifecycleService({store: environmentStore,
      manager: new HttpExecutionEnvironmentManagerClient({env, fetchImpl})});
    const act = () => operation === "create"
      ? service.createStandaloneDisposableEnvironment({agentKey: "panda", createdBySessionId: session.id, environmentId: "env-preflight"})
      : operation === "restart" ? service.ensureBoundEnvironmentReady({session, binding: binding!})
        : service.stopEnvironment("env-preflight");

    await expect(act()).rejects.toThrow("Invalid URL");
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(environmentStore.getEnvironment("env-preflight")).resolves.toMatchObject({
      state: operation === "create" ? "failed" : initialState,
      ...(operation === "create" ? {} : {metadata: {retained: true}}),
    });
    env.PANDA_EXECUTION_ENVIRONMENT_MANAGER_URL = "http://manager.invalid";
    // Failed creation can be cleaned up; restart/stop can repeat their known unissued operation.
    await expect(operation === "create" ? service.stopEnvironment("env-preflight") : act()).resolves.toMatchObject({
      state: operation === "restart" ? "ready" : "stopped",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(["create", "restart", "stop"] as const)("keeps %s ownership when a dispatched manager request rejects", async (operation) => {
    const {environmentStore, sessionStore} = await createHarness();
    const session = await sessionStore.getSession("session-worker");
    let binding;
    if (operation !== "create") {
      await environmentStore.createEnvironment({id: "env-uncertain", agentKey: "panda", kind: "disposable_container",
        state: operation === "stop" ? "ready" : "stopped", createdForSessionId: session.id});
      binding = await environmentStore.bindSession({sessionId: session.id, environmentId: "env-uncertain", alias: "self",
        isDefault: true, credentialPolicy: {mode: "none"}, skillPolicy: {mode: "none"}, toolPolicy: {}});
    }
    const fetchImpl = vi.fn(async () => { throw new Error("Connection lost after dispatch"); });
    const service = new ExecutionEnvironmentLifecycleService({store: environmentStore,
      manager: new HttpExecutionEnvironmentManagerClient({managerUrl: "http://manager.invalid", fetchImpl})});
    const result = operation === "create"
      ? service.createStandaloneDisposableEnvironment({agentKey: "panda", createdBySessionId: session.id, environmentId: "env-uncertain"})
      : operation === "restart" ? service.ensureBoundEnvironmentReady({session, binding: binding!})
        : service.stopEnvironment("env-uncertain");
    await expect(result).rejects.toThrow("unresolved outcome");
    await expect(environmentStore.getEnvironment("env-uncertain")).resolves.toMatchObject({
      state: operation === "stop" ? "stopping" : "provisioning", operationId: expect.any(String),
    });
    await expect(service.stopEnvironment("env-uncertain")).rejects.toThrow("must finish before another transition");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(["session token", "session lease", "standalone token", "restart token"] as const)("keeps environment recovery available when local %s preflight fails", async (scenario) => {
    const {environmentStore, sessionStore} = await createHarness();
    const session = await sessionStore.getSession("session-worker");
    const manager = new FakeEnvironmentManager();
    let failing = true;
    const preflight = () => { if (failing) throw new Error("Local preflight failed"); return "synthetic-token"; };
    const service = new ExecutionEnvironmentLifecycleService({store: environmentStore, manager,
      ...(scenario === "session lease" ? {commandLeases: {issueCommandLease: () => { preflight(); return null; }}}
        : {runnerTokenAuthority: {derive: preflight}})});
    let binding;
    if (scenario === "restart token") {
      await environmentStore.createEnvironment({id: "env-local", agentKey: "panda", kind: "disposable_container",
        state: "stopped", createdForSessionId: session.id});
      binding = await environmentStore.bindSession({sessionId: session.id, environmentId: "env-local", alias: "self",
        isDefault: true, credentialPolicy: {mode: "none"}, skillPolicy: {mode: "none"}, toolPolicy: {}});
    }
    const act = () => scenario === "restart token" ? service.ensureBoundEnvironmentReady({session, binding: binding!})
      : scenario === "standalone token" ? service.createStandaloneDisposableEnvironment({agentKey: "panda",
        createdBySessionId: session.id, environmentId: "env-local"})
        : service.createDisposableForSession({session, environmentId: "env-local"});
    await expect(act()).rejects.toThrow("Local preflight failed");
    if (scenario === "restart token") {
      await expect(environmentStore.getEnvironment("env-local")).resolves.toMatchObject({state: "stopped", operationId: undefined});
    } else if (scenario === "session lease") {
      await expect(environmentStore.getEnvironment("env-local")).resolves.toMatchObject({state: "failed"});
    } else {
      await expect(environmentStore.getEnvironment("env-local")).rejects.toThrow("Unknown execution environment");
    }
    expect(manager.requests).toEqual([]);
    failing = false;
    if (scenario === "session lease") {
      await expect(service.stopEnvironment("env-local")).resolves.toMatchObject({state: "stopped"});
      await service.createDisposableForSession({session, environmentId: "env-local-retry"});
      await expect(environmentStore.getEnvironment("env-local-retry")).resolves.toMatchObject({state: "ready"});
      return;
    }
    await act();
    await expect(environmentStore.getEnvironment("env-local")).resolves.toMatchObject({state: "ready"});
  });

  it("does not mint command leases for rejected duplicate environment IDs", async () => {
    const {environmentStore, sessionStore} = await createHarness();
    const session = await sessionStore.getSession("session-worker");
    await environmentStore.createEnvironment({id: "env-existing", agentKey: "panda", kind: "disposable_container",
      state: "ready", createdForSessionId: session.id});
    const commandLeases = new RuntimeCommandLeaseService({baseUrl: "http://commands.invalid",
      commandCatalog: DEFAULT_AGENT_COMMAND_CATALOG});
    const issued = vi.spyOn(commandLeases, "issueCommandLease");
    const service = new ExecutionEnvironmentLifecycleService({store: environmentStore,
      manager: new FakeEnvironmentManager(), commandLeases});
    const reserve = vi.spyOn(environmentStore, "reserveEnvironment");
    const toolPolicy = {allowedTools: ["a2a.send"]};
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // pg-mem returns the existing row for DO NOTHING; PostgreSQL returns no reservation.
      reserve.mockResolvedValueOnce(null);
      await expect(service.createDisposableForSession({session, environmentId: "env-existing", toolPolicy})).rejects.toThrow("already exists");
    }
    await service.createDisposableForSession({session, environmentId: "env-winner", toolPolicy});
    const leases = issued.mock.results.flatMap((result) => result.type === "return" && result.value ? [result.value] : []);
    expect(leases).toHaveLength(1);
    await expect(commandLeases.verify(leases[0]!.token)).resolves.toMatchObject({environmentId: "env-winner"});
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

  it("carries credential policy in the initial disposable command lease", async () => {
    const {environmentStore, sessionStore} = await createHarness();
    const session = await sessionStore.getSession("session-worker");
    const manager = new FakeEnvironmentManager();
    const commandLeases = new RuntimeCommandLeaseService({
      baseUrl: "http://panda-core:8096",
      commandCatalog: DEFAULT_AGENT_COMMAND_CATALOG,
    });
    const service = new ExecutionEnvironmentLifecycleService({store: environmentStore, manager, commandLeases});
    await service.createDisposableForSession({
      session,
      environmentId: "env-mcp-policy",
      credentialPolicy: {mode: "allowlist", envKeys: ["MCP_TOKEN"]},
      skillPolicy: {mode: "none"},
      toolPolicy: {allowedTools: ["mcp.*"]},
    });
    const token = manager.requests[0]?.commandAccess?.token;
    expect(token).toBeTruthy();
    await expect(commandLeases.verify(token!)).resolves.toMatchObject({
      agentKey: "panda",
      sessionId: "session-worker",
      environmentId: "env-mcp-policy",
      credentialPolicy: {mode: "allowlist", envKeys: ["MCP_TOKEN"]},
      allowedCommands: ["mcp.tools", "mcp.call"],
    });
  });

  it("delivers only the environment-scoped runner token to the manager", async () => {
    const {environmentStore, sessionStore} = await createHarness();
    const session = await sessionStore.getSession("session-worker");
    const manager = new FakeEnvironmentManager();
    const authority = new HmacRunnerTokenAuthority(Buffer.alloc(32, 9));
    const service = new ExecutionEnvironmentLifecycleService({
      store: environmentStore,
      manager,
      runnerTokenAuthority: authority,
    });

    await service.createDisposableForSession({session, environmentId: "env-scoped"});

    expect(manager.requests[0]?.runnerAuthToken).toBe(authority.derive({
      kind: "execution-environment",
      agentKey: "panda",
      scopeId: "env-scoped",
    }));
  });

  it("refreshes disposable command access with current input identity scope", async () => {
    const {environmentStore, sessionStore} = await createHarness();
    const session = await sessionStore.getSession("session-worker");
    const manager = new FakeEnvironmentManager();
    const commandLeases = new RuntimeCommandLeaseService({
      baseUrl: "http://panda-core:8096",
      commandCatalog: DEFAULT_AGENT_COMMAND_CATALOG,
    });
    const service = new ExecutionEnvironmentLifecycleService({
      store: environmentStore,
      manager,
      commandLeases,
    });

    const refresh = await service.refreshSessionCommandAccess({
      session,
      executionEnvironment: {
        id: "env-worker",
        kind: "disposable_container",
        source: "binding",
        credentialPolicy: {mode: "allowlist", envKeys: ["MCP_TOKEN"]},
        skillPolicy: {mode: "all_agent"},
        toolPolicy: {allowedTools: ["micro-app.link.create", "micro-app.view"]},
      },
      identityId: "identity-current",
      inputMessageId: "message-current",
      runId: "run-current",
      parentToolCallId: "bash-call-current",
    });

    expect(refresh).toMatchObject({
      refreshed: true,
      commandAccess: {
        url: "http://panda-core:8096",
      },
    });

    expect(manager.commandAccessRefreshes).toHaveLength(1);
    expect(manager.commandAccessRefreshes[0]).toMatchObject({
      environmentId: "env-worker",
      commandAccess: {
        url: "http://panda-core:8096",
      },
    });
    const token = manager.commandAccessRefreshes[0]?.commandAccess?.token;
    expect(token).toBeTruthy();
    await expect(commandLeases.verify(token!)).resolves.toMatchObject({
      agentKey: "panda",
      sessionId: "session-worker",
      environmentId: "env-worker",
      identityId: "identity-current",
      inputMessageId: "message-current",
      runId: "run-current",
      parentToolCallId: "bash-call-current",
      credentialPolicy: {mode: "allowlist", envKeys: ["MCP_TOKEN"]},
      allowedCommands: ["micro-app.link.create", "micro-app.view"],
    });
  });

  it("clears disposable command access when no commands are allowed", async () => {
    const {environmentStore, sessionStore} = await createHarness();
    const session = await sessionStore.getSession("session-worker");
    const manager = new FakeEnvironmentManager();
    const commandLeases = new RuntimeCommandLeaseService({
      baseUrl: "http://panda-core:8096",
      commandCatalog: DEFAULT_AGENT_COMMAND_CATALOG,
    });
    const service = new ExecutionEnvironmentLifecycleService({
      store: environmentStore,
      manager,
      commandLeases,
    });

    const refresh = await service.refreshSessionCommandAccess({
      session,
      executionEnvironment: {
        id: "env-worker",
        kind: "disposable_container",
        source: "binding",
        skillPolicy: {mode: "none"},
        toolPolicy: {},
      },
    });

    expect(refresh).toEqual({
      refreshed: false,
      reason: "no_allowed_commands",
    });
    expect(manager.commandAccessRefreshes).toEqual([
      {
        environmentId: "env-worker",
      },
    ]);
  });

  it("issues fallback runner command access without disposable manager refresh", async () => {
    const {environmentStore, sessionStore} = await createHarness();
    const session = await sessionStore.getSession("session-main");
    const manager = new FakeEnvironmentManager();
    const commandLeases = new RuntimeCommandLeaseService({
      baseUrl: "http://panda-core:8096",
      commandCatalog: DEFAULT_AGENT_COMMAND_CATALOG,
    });
    const service = new ExecutionEnvironmentLifecycleService({
      store: environmentStore,
      manager,
      commandLeases,
    });

    const refresh = await service.refreshSessionCommandAccess({
      session,
      executionEnvironment: {
        id: "persistent_agent_runner:panda",
        kind: "persistent_agent_runner",
        source: "fallback",
        credentialPolicy: {mode: "all_agent"},
        skillPolicy: {mode: "all_agent"},
        toolPolicy: {
          allowedTools: [
            "env.list",
            "env.set",
            "env.clear",
            "telegram.chat.list",
            "telegram.chat.info",
            "telegram.history",
            "telegram.media.fetch",
            "telegram.send",
            "telegram.edit",
            "telegram.delete",
            "telegram.pin",
            "telegram.unpin",
            "telegram.sticker.send",
            "discord.channel.list",
            "discord.history",
            "discord.sticker.list",
            "discord.sticker.send",
            "discord.gif.send",
            "discord.send",
            "whatsapp.chat.list",
            "whatsapp.history",
            "whatsapp.send",
          ],
        },
      },
    });

    expect(refresh).toMatchObject({
      refreshed: true,
      commandAccess: {
        url: "http://panda-core:8096",
      },
    });
    expect(manager.commandAccessRefreshes).toEqual([]);
    await expect(commandLeases.verify(refresh.commandAccess!.token)).resolves.toMatchObject({
      agentKey: "panda",
      sessionId: "session-main",
      credentialPolicy: {mode: "all_agent"},
      allowedCommands: [
        "telegram.chat.list",
        "telegram.chat.info",
        "telegram.history",
        "telegram.media.fetch",
        "telegram.send",
        "telegram.edit",
        "telegram.delete",
        "telegram.pin",
        "telegram.unpin",
        "telegram.sticker.send",
        "discord.channel.list",
        "discord.history",
        "discord.sticker.list",
        "discord.sticker.send",
        "discord.gif.send",
        "discord.send",
        "whatsapp.chat.list",
        "whatsapp.history",
        "whatsapp.send",
        "env.list",
        "env.set",
        "env.clear",
      ],
      credentialMutationAllowed: true,
    });
  });

  it("issues socket access to fallback runners only when their socket mount is declared", async () => {
    const {environmentStore, sessionStore} = await createHarness();
    const session = await sessionStore.getSession("session-main");
    const commandLeases = new RuntimeCommandLeaseService({
      socketPath: "/run/panda-command/command.sock",
      commandCatalog: DEFAULT_AGENT_COMMAND_CATALOG,
    });
    const service = new ExecutionEnvironmentLifecycleService({
      store: environmentStore,
      commandLeases,
      fallbackRunnerCommandSocketAccess: true,
    });

    const refresh = await service.refreshSessionCommandAccess({
      session,
      executionEnvironment: {
        id: "persistent_agent_runner:panda",
        kind: "persistent_agent_runner",
        source: "fallback",
        skillPolicy: {mode: "all_agent"},
        toolPolicy: {allowedTools: ["time.now"]},
      },
    });

    expect(refresh).toMatchObject({
      refreshed: true,
      commandAccess: {
        socketPath: "/run/panda-command/command.sock",
      },
    });
    expect(refresh.commandAccess?.url).toBeUndefined();
  });

  it("rejects socket-only command access for bound persistent runners", async () => {
    const {environmentStore, sessionStore} = await createHarness();
    const session = await sessionStore.getSession("session-main");
    const commandLeases = new RuntimeCommandLeaseService({
      socketPath: "/run/panda-command/command.sock",
      commandCatalog: DEFAULT_AGENT_COMMAND_CATALOG,
    });
    const service = new ExecutionEnvironmentLifecycleService({
      store: environmentStore,
      commandLeases,
      fallbackRunnerCommandSocketAccess: true,
    });

    await expect(service.refreshSessionCommandAccess({
      session,
      executionEnvironment: {
        id: "env-vps",
        kind: "persistent_agent_runner",
        source: "binding",
        skillPolicy: {mode: "all_agent"},
        toolPolicy: {allowedTools: ["time.now"]},
      },
    })).rejects.toThrow(
      "Panda command socket transport is not mounted in execution environment env-vps.",
    );
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

  it("runs standalone setup before marking the environment ready", async () => {
    const {environmentStore} = await createHarness();
    const manager = new FakeEnvironmentManager((input) => ({
      containerName: input.environmentId,
      ...createFilesystemMetadata(`${input.environmentId}-dir`),
    }));
    const setupRunner = new FakeSetupRunner();
    setupRunner.onRun = async (input) => {
      await expect(environmentStore.getEnvironment(input.environmentId)).resolves.toMatchObject({
        state: "provisioning",
      });
    };
    const service = new ExecutionEnvironmentLifecycleService({
      store: environmentStore,
      manager,
      setupRunner,
    });

    const environment = await service.createStandaloneDisposableEnvironment({
      agentKey: "panda",
      createdBySessionId: "session-main",
      environmentId: "env-setup-success",
      setupScript: {
        requestedPath: "setup.sh",
        resolvedPath: "/agent/setup.sh",
      },
    });

    expect(setupRunner.inputs).toHaveLength(1);
    expect(setupRunner.inputs[0]).toMatchObject({
      agentKey: "panda",
      environmentId: "env-setup-success",
      runnerUrl: "http://env-setup-success:8080",
      runnerCwd: "/workspace",
      setupScript: {
        requestedPath: "setup.sh",
        resolvedPath: "/agent/setup.sh",
      },
      filesystem: {
        artifacts: {
          workerPath: "/artifacts",
        },
      },
    });
    expect(environment).toMatchObject({
      id: "env-setup-success",
      state: "ready",
      metadata: {
        setup: {
          status: "succeeded",
          artifacts: {
            script: "/artifacts/setup/setup.sh",
          },
          toolchain: {
            tools: {
              node: {version: "v99.1.0"},
              pnpm: {version: "10.33.0"},
              corepack: {version: "0.34.0"},
            },
          },
        },
      },
    });
    expect(manager.requests).toEqual([
      {
        agentKey: "panda",
        sessionId: "session-main",
        environmentId: "env-setup-success",
      },
    ]);
    expect(JSON.stringify(manager.requests)).not.toContain("setupScript");
  });

  it("persists failed when standalone setup fails after environment creation", async () => {
    const {environmentStore} = await createHarness();
    const manager = new FakeEnvironmentManager((input) => ({
      containerName: input.environmentId,
      ...createFilesystemMetadata(`${input.environmentId}-dir`),
    }));
    const setupRunner = new FakeSetupRunner();
    setupRunner.error = new ExecutionEnvironmentSetupError("Setup script exited with code 7.", {
      setup: {
        status: "failed",
        artifacts: {
          script: "/artifacts/setup/setup.sh",
          result: "/artifacts/setup/setup-result.json",
        },
        error: "Setup script exited with code 7.",
      },
    });
    const service = new ExecutionEnvironmentLifecycleService({
      store: environmentStore,
      manager,
      setupRunner,
    });

    await expect(service.createStandaloneDisposableEnvironment({
      agentKey: "panda",
      createdBySessionId: "session-main",
      environmentId: "env-setup-fail",
      setupScript: {
        requestedPath: "setup.sh",
        resolvedPath: "/agent/setup.sh",
      },
    })).rejects.toThrow("Setup script exited with code 7.");

    await expect(environmentStore.getEnvironment("env-setup-fail")).resolves.toMatchObject({
      state: "failed",
      metadata: {
        setup: {
          status: "failed",
          artifacts: {
            result: "/artifacts/setup/setup-result.json",
          },
        },
      },
    });
    expect(manager.stopped).toEqual(["env-setup-fail"]);
  });

  it("persists failed for timeout, runner, and probe failures after environment creation", async () => {
    const {environmentStore} = await createHarness();
    const manager = new FakeEnvironmentManager((input) => ({
      containerName: input.environmentId,
      ...createFilesystemMetadata(`${input.environmentId}-dir`),
    }));

    const cases = [
      {id: "env-setup-timeout", message: "Setup script timed out."},
      {id: "env-setup-runner-error", message: "Setup runner request failed: network down"},
      {id: "env-setup-probe-fail", message: "Toolchain probe returned unparsable JSON"},
    ];

    for (const testCase of cases) {
      const setupRunner = new FakeSetupRunner();
      setupRunner.error = new ExecutionEnvironmentSetupError(testCase.message, {
        setup: {
          status: "failed",
          artifacts: {
            result: "/artifacts/setup/setup-result.json",
          },
          error: testCase.message,
        },
      });
      const service = new ExecutionEnvironmentLifecycleService({
        store: environmentStore,
        manager,
        setupRunner,
      });

      await expect(service.createStandaloneDisposableEnvironment({
        agentKey: "panda",
        createdBySessionId: "session-main",
        environmentId: testCase.id,
        setupScript: {
          requestedPath: "setup.sh",
          resolvedPath: "/agent/setup.sh",
        },
      })).rejects.toThrow(testCase.message);

      await expect(environmentStore.getEnvironment(testCase.id)).resolves.toMatchObject({
        state: "failed",
        metadata: {
          setup: {
            status: "failed",
            error: testCase.message,
          },
        },
      });
    }

    expect(manager.stopped).toEqual(cases.map((testCase) => testCase.id));
  });

  it("persists failed when setup cannot trust manager filesystem metadata", async () => {
    const {environmentStore} = await createHarness();
    const manager = new FakeEnvironmentManager();
    const setupRunner = new FakeSetupRunner();
    const service = new ExecutionEnvironmentLifecycleService({
      store: environmentStore,
      manager,
      setupRunner,
    });

    await expect(service.createStandaloneDisposableEnvironment({
      agentKey: "panda",
      createdBySessionId: "session-main",
      environmentId: "env-missing-fs",
      setupScript: {
        requestedPath: "setup.sh",
        resolvedPath: "/agent/setup.sh",
      },
    })).rejects.toThrow("requires filesystem metadata");

    expect(setupRunner.inputs).toHaveLength(0);
    await expect(environmentStore.getEnvironment("env-missing-fs")).resolves.toMatchObject({
      state: "failed",
      metadata: {
        error: "Disposable environment setup requires filesystem metadata from the environment manager.",
      },
    });
    expect(manager.stopped).toEqual(["env-missing-fs"]);
  });

  it("does not restart stopped or expired setup-created environments without rerunning setup", async () => {
    const {environmentStore, sessionStore} = await createHarness();
    const session = await sessionStore.getSession("session-worker");
    const manager = new FakeEnvironmentManager();
    const service = new ExecutionEnvironmentLifecycleService({
      store: environmentStore,
      manager,
    });
    const setupMetadata = {
      setup: {
        status: "succeeded",
        artifacts: {
          script: "/artifacts/setup/setup.sh",
        },
      },
    };
    await environmentStore.createEnvironment({
      id: "env-setup-stopped",
      agentKey: "panda",
      kind: "disposable_container",
      state: "stopped",
      runnerUrl: "http://old-env:8080",
      runnerCwd: "/workspace",
      createdBySessionId: "session-main",
      expiresAt: Date.now() + 60_000,
      metadata: setupMetadata,
    });
    await environmentStore.createEnvironment({
      id: "env-setup-expired",
      agentKey: "panda",
      kind: "disposable_container",
      state: "ready",
      runnerUrl: "http://old-env:8080",
      runnerCwd: "/workspace",
      createdBySessionId: "session-main",
      expiresAt: Date.now() - 1_000,
      metadata: setupMetadata,
    });

    for (const environmentId of ["env-setup-stopped", "env-setup-expired"]) {
      await expect(service.attachSessionToDisposableEnvironment({
        session,
        environmentId,
        ownerSessionId: "session-main",
      })).rejects.toThrow("created with setupScript and cannot be restarted");
    }
    expect(manager.requests).toEqual([]);
    await expect(environmentStore.getEnvironment("env-setup-stopped")).resolves.toMatchObject({state: "stopped"});
    await expect(environmentStore.getEnvironment("env-setup-expired")).resolves.toMatchObject({state: "ready"});
  });

  it("attaches sessions to existing ready disposable environments", async () => {
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

  it("restarts stopped disposable environments before attaching sessions", async () => {
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

  it("restarts expired disposable environments before attaching sessions", async () => {
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
