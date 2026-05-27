import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";

import {A2ASessionBindingRepo} from "../src/domain/a2a/repo.js";
import {PostgresAgentStore} from "../src/domain/agents/index.js";
import {PostgresExecutionEnvironmentStore} from "../src/domain/execution-environments/postgres.js";
import type {ExecutionEnvironmentStore} from "../src/domain/execution-environments/store.js";
import {PostgresIdentityStore} from "../src/domain/identity/index.js";
import {PostgresSessionStore} from "../src/domain/sessions/index.js";
import {buildSessionTableNames} from "../src/domain/sessions/postgres-shared.js";
import {PostgresSubagentProfileStore} from "../src/domain/subagents/index.js";
import {buildSubagentTableNames} from "../src/domain/subagents/postgres-shared.js";
import {PostgresThreadRuntimeStore} from "../src/domain/threads/runtime/postgres.js";
import {buildThreadRuntimeTableNames} from "../src/domain/threads/runtime/postgres-shared.js";
import {SubagentSessionService} from "../src/app/runtime/subagent-session-service.js";
import {ExecutionEnvironmentLifecycleService} from "../src/app/runtime/execution-environment-service.js";

describe("SubagentSessionService", () => {
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
    db.public.registerFunction({
      name: "length",
      args: [DataType.text],
      returns: DataType.integer,
      implementation: (value: string) => value.length,
    });
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    const originalQuery = pool.query.bind(pool);
    pool.query = async (text: string, values?: readonly unknown[]) => {
      if (
        text.includes("subagent_profiles_global_slug_idx")
        || text.includes("subagent_profiles_agent_slug_idx")
      ) {
        return {rows: []};
      }
      return originalQuery(text, values);
    };
    pools.push(pool);

    const identityStore = new PostgresIdentityStore({pool});
    const agentStore = new PostgresAgentStore({pool});
    const sessionStore = new PostgresSessionStore({pool});
    const threadStore = new PostgresThreadRuntimeStore({pool});
    const profileStore = new PostgresSubagentProfileStore({pool});
    const environmentStore = new PostgresExecutionEnvironmentStore({pool});
    const a2a = new A2ASessionBindingRepo({pool});
    await identityStore.ensureSchema();
    await agentStore.ensureAgentTableSchema();
    await sessionStore.ensureSchema();
    await threadStore.ensureSchema();
    await profileStore.ensureSchema();
    await environmentStore.ensureSchema();
    await a2a.ensureSchema();
    await agentStore.bootstrapAgent({
      agentKey: "panda",
      displayName: "Panda",
      prompts: {},
    });
    await sessionStore.createSession({
      id: "parent-session",
      agentKey: "panda",
      kind: "main",
      currentThreadId: "parent-thread",
    });
    const subagentTables = buildSubagentTableNames();
    await pool.query(`
      INSERT INTO ${subagentTables.subagentProfiles} (
        slug,
        agent_key,
        description,
        prompt,
        tool_groups,
        model,
        thinking,
        transcript_mode,
        source,
        enabled
      ) VALUES (
        'workspace',
        NULL,
        'Workspace reader.',
        'Workspace profile prompt.',
        '["core","workspace_read"]'::jsonb,
        'openai/gpt-5.1',
        'medium',
        'none',
        'builtin',
        TRUE
      )
    `);

    const events: string[] = [];
    const originalBind = a2a.bindSession.bind(a2a);
    a2a.bindSession = async (input) => {
      events.push(`bind:${input.senderSessionId}->${input.recipientSessionId}`);
      return originalBind(input);
    };
    const originalEnqueue = threadStore.enqueueInput.bind(threadStore);
    threadStore.enqueueInput = async (threadId, payload, deliveryMode) => {
      events.push(`enqueue:${threadId}:${payload.source}`);
      return originalEnqueue(threadId, payload, deliveryMode);
    };

    const environments = new ExecutionEnvironmentLifecycleService({
      store: environmentStore,
      manager: null,
    });
    const service = new SubagentSessionService({
      pool,
      sessions: sessionStore,
      threads: threadStore,
      profiles: profileStore,
      environments,
      a2aBindings: a2a,
    });

    return {
      a2a,
      agentStore,
      environmentStore,
      events,
      pool,
      profileStore,
      service,
      sessionStore,
      threadStore,
    };
  }

  async function countRows(pool: {query(sql: string, values?: readonly unknown[]): Promise<{rows: readonly unknown[]}>}, sql: string): Promise<number> {
    const result = await pool.query(sql);
    return Number((result.rows[0] as {count: number | string}).count);
  }

  it("creates profile-backed agent-workspace subagent sessions without environment bindings", async () => {
    const {a2a, events, pool, service} = await createHarness();
    const result = await service.createSubagentSession({
      agentKey: "panda",
      parentSessionId: "parent-session",
      profile: "workspace",
      task: "Inspect package files.",
      context: "Focus on source.",
      credentialAllowlist: ["NPM_TOKEN", ""],
      sessionId: "subagent-session",
      threadId: "subagent-thread",
    });

    expect(result.session).toMatchObject({
      id: "subagent-session",
      kind: "subagent",
      currentThreadId: "subagent-thread",
      metadata: {
        subagent: {
          version: 1,
          role: "workspace",
          task: "Inspect package files.",
          parentSessionId: "parent-session",
          execution: "agent_workspace",
          profile: {
            slug: "workspace",
            prompt: "Workspace profile prompt.",
            toolGroups: ["core", "workspace_read"],
          },
          resolved: {
            model: "openai/gpt-5.1",
            modelSource: "profile",
            credentialPolicy: {mode: "allowlist", envKeys: ["NPM_TOKEN"]},
            skillPolicy: {mode: "all_agent"},
            toolPolicy: {
              allowedTools: expect.arrayContaining(["message_agent", "agent_skill", "read_file"]),
              agentSkill: {allowedOperations: ["load"]},
            },
          },
        },
      },
    });
    expect(result.environment).toBeUndefined();
    expect(result.binding).toBeUndefined();
    expect(await a2a.hasBinding({senderSessionId: "parent-session", recipientSessionId: "subagent-session"})).toBe(true);
    expect(await a2a.hasBinding({senderSessionId: "subagent-session", recipientSessionId: "parent-session"})).toBe(true);
    expect(events).toEqual([
      "bind:parent-session->subagent-session",
      "bind:subagent-session->parent-session",
      "enqueue:subagent-thread:subagent",
    ]);

    const envTables = '"runtime"."session_environment_bindings"';
    expect(await countRows(pool, `SELECT COUNT(*)::INTEGER AS count FROM ${envTables} WHERE session_id = 'subagent-session'`)).toBe(0);
    const threadTables = buildThreadRuntimeTableNames();
    expect(await countRows(pool, `SELECT COUNT(*)::INTEGER AS count FROM ${threadTables.inputs} WHERE thread_id = 'subagent-thread' AND source = 'subagent'`)).toBe(1);
  });

  it("accepts ad-hoc tool groups without storing a profile", async () => {
    const {pool, service} = await createHarness();
    const subagentTables = buildSubagentTableNames();
    const before = await countRows(pool, `SELECT COUNT(*)::INTEGER AS count FROM ${subagentTables.subagentProfiles}`);

    const result = await service.createSubagentSession({
      agentKey: "panda",
      parentSessionId: "parent-session",
      task: "Do ad-hoc work.",
      toolGroups: ["core", "memory"],
      sessionId: "adhoc-subagent",
      threadId: "adhoc-thread",
    });

    expect(result.session.metadata).toMatchObject({
      subagent: {
        profile: {
          slug: "ad_hoc",
          source: "ad_hoc",
          toolGroups: ["core", "memory"],
        },
        resolved: {
          toolPolicy: {
            postgresReadonly: {allowed: true},
            agentSkill: {allowedOperations: ["load"]},
          },
        },
      },
    });
    expect(await countRows(pool, `SELECT COUNT(*)::INTEGER AS count FROM ${subagentTables.subagentProfiles}`)).toBe(before);
  });

  it("rejects profile plus toolGroups before creating durable rows", async () => {
    const {pool, service} = await createHarness();
    await expect(service.createSubagentSession({
      agentKey: "panda",
      parentSessionId: "parent-session",
      task: "Bad request.",
      profile: "workspace",
      toolGroups: ["core"],
      sessionId: "bad-subagent",
      threadId: "bad-thread",
    })).rejects.toThrow("Subagent profile toolGroups cannot be overridden.");

    const sessionTables = buildSessionTableNames();
    const threadTables = buildThreadRuntimeTableNames();
    expect(await countRows(pool, `SELECT COUNT(*)::INTEGER AS count FROM ${sessionTables.sessions} WHERE id = 'bad-subagent'`)).toBe(0);
    expect(await countRows(pool, `SELECT COUNT(*)::INTEGER AS count FROM ${threadTables.threads} WHERE id = 'bad-thread'`)).toBe(0);
  });


  it("cleans up A2A bindings when handoff enqueue fails after bind", async () => {
    const {a2a, pool, service, threadStore} = await createHarness();
    threadStore.enqueueInput = async () => {
      throw new Error("handoff queue down");
    };

    await expect(service.createSubagentSession({
      agentKey: "panda",
      parentSessionId: "parent-session",
      task: "Trigger enqueue failure.",
      sessionId: "enqueue-failed-subagent",
      threadId: "enqueue-failed-thread",
    })).rejects.toThrow("handoff queue down");

    const sessionTables = buildSessionTableNames();
    const threadTables = buildThreadRuntimeTableNames();
    expect(await countRows(pool, `SELECT COUNT(*)::INTEGER AS count FROM ${sessionTables.sessions} WHERE id = 'enqueue-failed-subagent'`)).toBe(0);
    expect(await countRows(pool, `SELECT COUNT(*)::INTEGER AS count FROM ${threadTables.threads} WHERE id = 'enqueue-failed-thread'`)).toBe(0);
    expect(await a2a.hasBinding({
      senderSessionId: "parent-session",
      recipientSessionId: "enqueue-failed-subagent",
    })).toBe(false);
    expect(await a2a.hasBinding({
      senderSessionId: "enqueue-failed-subagent",
      recipientSessionId: "parent-session",
    })).toBe(false);
  });

  it("attaches isolated subagents only to existing ready disposable environments", async () => {
    const {environmentStore, service} = await createHarness();
    await environmentStore.createEnvironment({
      id: "env-ready",
      agentKey: "panda",
      kind: "disposable_container",
      state: "ready",
      runnerUrl: "http://worker:8080",
      runnerCwd: "/workspace",
      createdBySessionId: "parent-session",
    });

    const result = await service.createSubagentSession({
      agentKey: "panda",
      parentSessionId: "parent-session",
      task: "Use isolated env.",
      execution: "isolated_environment",
      environmentId: "env-ready",
      sessionId: "isolated-subagent",
      threadId: "isolated-thread",
    });

    expect(result.environment).toMatchObject({id: "env-ready", state: "ready"});
    expect(result.binding).toMatchObject({
      sessionId: "isolated-subagent",
      environmentId: "env-ready",
      credentialPolicy: {mode: "allowlist", envKeys: []},
      skillPolicy: {mode: "all_agent"},
      toolPolicy: {
        agentSkill: {allowedOperations: ["load"]},
      },
    });
  });

  it("cleans up session/thread when isolated attach fails", async () => {
    const {environmentStore, pool, service} = await createHarness();
    await environmentStore.createEnvironment({
      id: "env-stopped",
      agentKey: "panda",
      kind: "disposable_container",
      state: "stopped",
      runnerUrl: "http://worker:8080",
      runnerCwd: "/workspace",
      createdBySessionId: "parent-session",
    });

    await expect(service.createSubagentSession({
      agentKey: "panda",
      parentSessionId: "parent-session",
      task: "Use stopped env.",
      execution: "isolated_environment",
      environmentId: "env-stopped",
      sessionId: "failed-subagent",
      threadId: "failed-thread",
    })).rejects.toThrow("Execution environment env-stopped is stopped.");

    const sessionTables = buildSessionTableNames();
    const threadTables = buildThreadRuntimeTableNames();
    expect(await countRows(pool, `SELECT COUNT(*)::INTEGER AS count FROM ${sessionTables.sessions} WHERE id = 'failed-subagent'`)).toBe(0);
    expect(await countRows(pool, `SELECT COUNT(*)::INTEGER AS count FROM ${threadTables.threads} WHERE id = 'failed-thread'`)).toBe(0);
    expect(await countRows(pool, `SELECT COUNT(*)::INTEGER AS count FROM "runtime"."session_environment_bindings" WHERE session_id = 'failed-subagent'`)).toBe(0);
    await expect(environmentStore.getEnvironment("env-stopped")).resolves.toMatchObject({
      id: "env-stopped",
      state: "stopped",
    });
  });



  it("rejects isolated subagents for environments not owned by the parent session", async () => {
    const cases = [
      {
        id: "env-wrong-owner",
        environment: {
          agentKey: "panda",
          kind: "disposable_container" as const,
          state: "ready" as const,
          createdBySessionId: "other-session",
        },
        message: "Execution environment env-wrong-owner is not owned by session parent-session.",
        bootstrapSession: "other-session",
      },
      {
        id: "env-foreign-agent",
        environment: {
          agentKey: "other",
          kind: "disposable_container" as const,
          state: "ready" as const,
          createdBySessionId: "parent-session",
        },
        message: "Execution environment env-foreign-agent does not belong to agent panda.",
        bootstrapAgent: "other",
      },
      {
        id: "env-local",
        environment: {
          agentKey: "panda",
          kind: "local" as const,
          state: "ready" as const,
          createdBySessionId: "parent-session",
        },
        message: "Execution environment env-local is not disposable.",
      },
      {
        id: "env-failed",
        environment: {
          agentKey: "panda",
          kind: "disposable_container" as const,
          state: "failed" as const,
          createdBySessionId: "parent-session",
        },
        message: "Execution environment env-failed is failed.",
      },
      {
        id: "env-expired",
        environment: {
          agentKey: "panda",
          kind: "disposable_container" as const,
          state: "ready" as const,
          createdBySessionId: "parent-session",
          expiresAt: Date.now() - 1_000,
        },
        message: "Execution environment env-expired is expired.",
      },
    ];

    for (const testCase of cases) {
      const {agentStore, environmentStore, events, pool, service, sessionStore} = await createHarness();
      if (testCase.bootstrapAgent) {
        await agentStore.bootstrapAgent({
          agentKey: testCase.bootstrapAgent,
          displayName: "Other",
          prompts: {},
        });
      }
      if (testCase.bootstrapSession) {
        await sessionStore.createSession({
          id: testCase.bootstrapSession,
          agentKey: "panda",
          kind: "worker",
          currentThreadId: `thread-${testCase.bootstrapSession}`,
        });
      }
      await environmentStore.createEnvironment({
        id: testCase.id,
        runnerUrl: "http://worker:8080",
        runnerCwd: "/workspace",
        ...testCase.environment,
      });

      await expect(service.createSubagentSession({
        agentKey: "panda",
        parentSessionId: "parent-session",
        task: `Use ${testCase.id}.`,
        execution: "isolated_environment",
        environmentId: testCase.id,
        sessionId: `failed-${testCase.id}`,
        threadId: `failed-thread-${testCase.id}`,
      })).rejects.toThrow(testCase.message);

      const sessionTables = buildSessionTableNames();
      const threadTables = buildThreadRuntimeTableNames();
      expect(await countRows(pool, `SELECT COUNT(*)::INTEGER AS count FROM ${sessionTables.sessions} WHERE id = 'failed-${testCase.id}'`)).toBe(0);
      expect(await countRows(pool, `SELECT COUNT(*)::INTEGER AS count FROM ${threadTables.threads} WHERE id = 'failed-thread-${testCase.id}'`)).toBe(0);
      expect(await countRows(pool, `SELECT COUNT(*)::INTEGER AS count FROM "runtime"."session_environment_bindings" WHERE session_id = 'failed-${testCase.id}'`)).toBe(0);
      expect(events).toEqual([]);
    }
  });

  it("requires isolated environment id and rejects workspace env ids", async () => {
    const {service} = await createHarness();
    await expect(service.createSubagentSession({
      agentKey: "panda",
      parentSessionId: "parent-session",
      task: "Missing env.",
      execution: "isolated_environment",
      sessionId: "missing-env-subagent",
      threadId: "missing-env-thread",
    })).rejects.toThrow("Isolated subagent execution requires environmentId.");
    await expect(service.createSubagentSession({
      agentKey: "panda",
      parentSessionId: "parent-session",
      task: "Unexpected env.",
      execution: "agent_workspace",
      environmentId: "env-ready",
      sessionId: "workspace-env-subagent",
      threadId: "workspace-env-thread",
    })).rejects.toThrow("agent_workspace subagent execution must not set environmentId.");
  });
});
