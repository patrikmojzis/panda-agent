import {lstat, mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {randomUUID} from "node:crypto";

import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";

import {PostgresExecutionEnvironmentStore} from "../src/domain/execution-environments/postgres.js";
import type {
  DisposableEnvironmentCreateRequest,
  DisposableEnvironmentCreateResult,
  ExecutionEnvironmentManager,
} from "../src/domain/execution-environments/types.js";
import {createSessionWithInitialThread} from "../src/domain/sessions/index.js";
import {A2ASessionBindingRepo} from "../src/domain/a2a/repo.js";
import {PostgresOutboundDeliveryStore} from "../src/domain/channels/deliveries/postgres.js";
import {RuntimeRequestRepo} from "../src/domain/threads/requests/repo.js";
import {SubagentPurgeService, type SubagentPurgeServiceOptions} from "../src/app/runtime/subagent-purge-service.js";
import {ensureSchemas} from "../src/app/runtime/postgres-bootstrap.js";
import {buildPurgeInput, parseDurationOption} from "../src/app/subagents/cli.js";
import {createRuntimeStores} from "./helpers/runtime-store-setup.js";

class FakeEnvironmentManager implements ExecutionEnvironmentManager {
  readonly stopped: string[] = [];

  async createDisposableEnvironment(
    input: DisposableEnvironmentCreateRequest,
  ): Promise<DisposableEnvironmentCreateResult> {
    return {
      runnerUrl: `http://${input.environmentId}:8080`,
      runnerCwd: "/workspace",
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

function createSessionDeleteFailingPool(pool: ReturnType<typeof createPool>) {
  return {
    query: pool.query.bind(pool),
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async (queryText: string, values?: readonly unknown[]) => {
          if (
            typeof queryText === "string"
            && queryText.includes(`DELETE FROM "runtime"."agent_sessions"`)
          ) {
            throw new Error("simulated session delete failure");
          }
          return client.query(queryText, values);
        },
        release: () => client.release(),
      };
    },
  };
}

function failUnusedDependency(name: string): never {
  throw new Error(`${name} should not be used by this test`);
}

function createQueryOnlyPurgePool(query: SubagentPurgeServiceOptions["pool"]["query"]): SubagentPurgeServiceOptions["pool"] {
  return {
    query,
    connect: async () => failUnusedDependency("subagent purge transaction client"),
  };
}

function createUnusedEnvironmentStore(): SubagentPurgeServiceOptions["environmentStore"] {
  return {
    createEnvironment: async () => failUnusedDependency("environmentStore.createEnvironment"),
    getEnvironment: async () => failUnusedDependency("environmentStore.getEnvironment"),
  };
}

async function createEnvRoot(root: string, agentKey: string, envDir: string): Promise<string> {
  const envRoot = path.join(root, agentKey, envDir);
  await mkdir(path.join(envRoot, "workspace"), {recursive: true});
  await mkdir(path.join(envRoot, "inbox"), {recursive: true});
  await mkdir(path.join(envRoot, "artifacts"), {recursive: true});
  await writeFile(path.join(envRoot, "artifacts", "report.txt"), "done\n");
  return envRoot;
}

function filesystemMetadata(envRoot: string, envDir: string) {
  return {
    envDir,
    root: {
      hostPath: envRoot,
      corePath: envRoot,
      parentRunnerPath: `/environments/${envDir}`,
    },
    workspace: {
      hostPath: path.join(envRoot, "workspace"),
      corePath: path.join(envRoot, "workspace"),
      parentRunnerPath: `/environments/${envDir}/workspace`,
      workerPath: "/workspace",
    },
    inbox: {
      hostPath: path.join(envRoot, "inbox"),
      corePath: path.join(envRoot, "inbox"),
      parentRunnerPath: `/environments/${envDir}/inbox`,
      workerPath: "/inbox",
    },
    artifacts: {
      hostPath: path.join(envRoot, "artifacts"),
      corePath: path.join(envRoot, "artifacts"),
      parentRunnerPath: `/environments/${envDir}/artifacts`,
      workerPath: "/artifacts",
    },
  };
}

describe("SubagentPurgeService", () => {
  const pools: Array<{end(): Promise<void>}> = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (pools.length > 0) {
      await pools.pop()?.end();
    }
    while (tempDirs.length > 0) {
      await rm(tempDirs.pop()!, {recursive: true, force: true});
    }
  });

  async function createHarness() {
    const pool = createPool();
    pools.push(pool);
    const {sessionStore, threadStore} = await createRuntimeStores(pool);
    const environmentStore = new PostgresExecutionEnvironmentStore({pool});
    const a2a = new A2ASessionBindingRepo({pool});
    const outbound = new PostgresOutboundDeliveryStore({pool});
    const requests = new RuntimeRequestRepo({pool});
    await ensureSchemas([
      environmentStore,
      a2a,
      outbound,
      requests,
    ]);

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
    await createSessionWithInitialThread({
      pool,
      sessionStore,
      threadStore,
      session: {
        id: "subagent-session",
        agentKey: "panda",
        kind: "subagent",
        currentThreadId: "subagent-thread",
      },
      thread: {
        id: "subagent-thread",
        sessionId: "subagent-session",
      },
    });

    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "panda-subagent-purge-"));
    tempDirs.push(tempRoot);
    const environmentsRoot = path.join(tempRoot, "environments");
    const envDir = "subagent-session";
    const envRoot = await createEnvRoot(environmentsRoot, "panda", envDir);
    await environmentStore.createEnvironment({
      id: "subagent:subagent-session",
      agentKey: "panda",
      kind: "disposable_container",
      state: "stopped",
      runnerUrl: "http://subagent:8080",
      runnerCwd: "/workspace",
      rootPath: "/workspace",
      createdBySessionId: "main-session",
      createdForSessionId: "subagent-session",
      metadata: {
        containerName: "panda-env-subagent-session",
        filesystem: filesystemMetadata(envRoot, envDir),
      },
    });
    await environmentStore.bindSession({
      sessionId: "subagent-session",
      environmentId: "subagent:subagent-session",
      alias: "self",
      isDefault: true,
    });

    const manager = new FakeEnvironmentManager();
    const service = new SubagentPurgeService({
      pool,
      environmentStore,
      manager,
      env: {
        PANDA_ENVIRONMENTS_HOST_ROOT: environmentsRoot,
        PANDA_CORE_ENVIRONMENTS_ROOT: environmentsRoot,
      } as NodeJS.ProcessEnv,
    });
    return {
      pool,
      a2a,
      environmentStore,
      environmentsRoot,
      envRoot,
      manager,
      requests,
      service,
      sessionStore,
      threadStore,
    };
  }

  it("plans stopped subagent purge candidates with row and file counts without mutating", async () => {
    const {pool, envRoot, service, threadStore} = await createHarness();
    await threadStore.enqueueInput("subagent-thread", {
      source: "test",
      message: {role: "user", content: "hello"},
    });
    await threadStore.appendRuntimeMessage("subagent-thread", {
      source: "test",
      message: {role: "assistant", content: "done"},
    });
    await pool.query(`
      UPDATE "runtime"."execution_environments"
      SET updated_at = $1
      WHERE id = 'subagent:subagent-session'
    `, [new Date(Date.now() - 8 * 24 * 60 * 60_000)]);
    await pool.query(`
      INSERT INTO "runtime"."runtime_requests" (
        id,
        kind,
        status,
        payload,
        result
      ) VALUES (
        $1,
        'a2a_message',
        'completed',
        $2::jsonb,
        $3::jsonb
      )
    `, [
      randomUUID(),
      JSON.stringify({sessionId: "subagent-session"}),
      JSON.stringify({media: {localPath: path.join(path.dirname(envRoot), "..", "media", "copied.txt")}}),
    ]);

    const plan = await service.purge({
      selector: {
        stopped: true,
        olderThanMs: 7 * 24 * 60 * 60_000,
      },
      now: Date.now(),
    });

    expect(plan.dryRun).toBe(true);
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]).toMatchObject({
      sessionId: "subagent-session",
      environment: {
        id: "subagent:subagent-session",
        state: "stopped",
      },
      filesystem: {
        status: "safe",
        rootPath: envRoot,
      },
      dbCounts: {
        sessions: 1,
        threads: 1,
        messages: 1,
        inputs: 1,
        executionEnvironments: 1,
        sessionEnvironmentBindings: 1,
        runtimeRequests: 1,
      },
      externalFileReferenceCount: null,
    });
    await expect(service.plan({selector: {sessionId: "main-session"}})).rejects.toThrow(
      "No disposable subagent environment matched",
    );
  });

  it("does not scan transcript JSON references while planning dry-run candidates", async () => {
    const {pool, environmentStore, environmentsRoot, manager} = await createHarness();
    const service = new SubagentPurgeService({
      pool: {
        query: async (queryText: string, values?: readonly unknown[]) => {
          if (typeof queryText === "string" && queryText.includes("::text LIKE")) {
            throw new Error("dry-run should not scan JSON/text references");
          }

          return pool.query(queryText, values);
        },
        connect: () => pool.connect(),
      },
      environmentStore,
      manager,
      env: {
        PANDA_ENVIRONMENTS_HOST_ROOT: environmentsRoot,
        PANDA_CORE_ENVIRONMENTS_ROOT: environmentsRoot,
      } as NodeJS.ProcessEnv,
    });

    const plan = await service.purge({
      selector: {
        stopped: true,
      },
    });

    expect(plan.dryRun).toBe(true);
    expect(plan.candidates[0]?.externalFileReferenceCount).toBeNull();
  });

  it("rejects corrupted environment state before planning purge actions", async () => {
    const {pool, service} = await createHarness();
    await pool.query(`
      UPDATE "runtime"."execution_environments"
      SET state = 'limbo'
      WHERE id = 'subagent:subagent-session'
    `);

    await expect(service.plan({
      selector: {
        environmentId: "subagent:subagent-session",
      },
      skipFiles: true,
    })).rejects.toThrow("Unsupported execution environment state limbo.");
  });

  it("rejects corrupted purge candidate keys before planning purge actions", async () => {
    const service = new SubagentPurgeService({
      pool: createQueryOnlyPurgePool(async () => ({
        rows: [{
          session_id: "subagent-session",
          session_agent_key: "panda",
          current_thread_id: "subagent-thread",
          session_created_at: new Date(1),
          session_updated_at: new Date(1),
          environment_id: "subagent:subagent-session",
          environment_agent_key: "",
          kind: "disposable_container",
          state: "stopped",
          runner_url: "http://subagent:8080",
          runner_cwd: "/workspace",
          root_path: "/workspace",
          created_by_session_id: "main-session",
          created_for_session_id: "subagent-session",
          expires_at: null,
          metadata: null,
          environment_created_at: new Date(1),
          environment_updated_at: new Date(1),
        }],
      })),
      environmentStore: createUnusedEnvironmentStore(),
      manager: null,
    });

    await expect(service.plan({
      selector: {
        environmentId: "subagent:subagent-session",
      },
      skipFiles: true,
    })).rejects.toThrow("subagent environment agent key must not be empty.");
  });

  it("rejects malformed purge count rows", async () => {
    const {pool, environmentStore, manager} = await createHarness();
    const service = new SubagentPurgeService({
      pool: {
        query: async (queryText: string, values?: readonly unknown[]) => {
          if (typeof queryText === "string" && queryText.includes("COUNT(*)::INTEGER AS count")) {
            return {rows: [{count: "many"}]};
          }

          return pool.query(queryText, values);
        },
        connect: () => pool.connect(),
      },
      environmentStore,
      manager,
    });

    await expect(service.plan({
      selector: {
        environmentId: "subagent:subagent-session",
      },
      skipFiles: true,
    })).rejects.toThrow("Subagent purge row count must be a non-negative integer.");
  });

  it("rejects driver-shaped purge count rows", async () => {
    const {pool, environmentStore, manager} = await createHarness();
    const service = new SubagentPurgeService({
      pool: {
        query: async (queryText: string, values?: readonly unknown[]) => {
          if (typeof queryText === "string" && queryText.includes("COUNT(*)::INTEGER AS count")) {
            return {rows: [{count: "1"}]};
          }

          return pool.query(queryText, values);
        },
        connect: () => pool.connect(),
      },
      environmentStore,
      manager,
    });

    await expect(service.plan({
      selector: {
        environmentId: "subagent:subagent-session",
      },
      skipFiles: true,
    })).rejects.toThrow("Subagent purge row count must be a non-negative integer.");
  });

  it("hard purges non-cascading rows, cascaded session rows, environment row, and env files", async () => {
    const {pool, a2a, environmentStore, envRoot, manager, requests, service, sessionStore} = await createHarness();
    await a2a.bindSession({
      senderSessionId: "main-session",
      recipientSessionId: "subagent-session",
    });
    await requests.enqueueRequest({
      kind: "create_subagent_session",
      payload: {
        sessionId: "subagent-session",
        threadId: "subagent-thread",
        parentSessionId: "main-session",
        prompt: "old work",
      },
    });
    await pool.query(`
      INSERT INTO "runtime"."runtime_requests" (
        id,
        kind,
        status,
        payload,
        result
      ) VALUES (
        $1,
        'a2a_message',
        'completed',
        $2::jsonb,
        $3::jsonb
      )
    `, [
      randomUUID(),
      JSON.stringify({sessionId: "subagent-session"}),
      JSON.stringify({media: {localPath: path.join(path.dirname(envRoot), "..", "media", "copied.txt")}}),
    ]);
    await pool.query(`
      INSERT INTO "runtime"."outbound_deliveries" (
        id,
        thread_id,
        channel,
        connector_key,
        external_conversation_id,
        items,
        metadata,
        status
      ) VALUES (
        $1,
        'subagent-thread',
        'a2a',
        'local',
        'main-session',
        $2::jsonb,
        $3::jsonb,
        'pending'
      )
    `, [
      randomUUID(),
      JSON.stringify([{type: "file", path: path.join(envRoot, "artifacts", "report.txt")}]),
      JSON.stringify({subagentSessionId: "subagent-session"}),
    ]);
    const unrelatedDeliveryId = randomUUID();
    await pool.query(`
      INSERT INTO "runtime"."outbound_deliveries" (
        id,
        thread_id,
        channel,
        connector_key,
        external_conversation_id,
        items,
        metadata,
        status
      ) VALUES (
        $1,
        'main-thread',
        'a2a',
        'local',
        'someone-else',
        $2::jsonb,
        $3::jsonb,
        'pending'
      )
    `, [
      unrelatedDeliveryId,
      JSON.stringify([{type: "text", text: "mentions subagent-session but is not subagent-owned"}]),
      JSON.stringify({note: "mentions subagent:subagent-session"}),
    ]);
    const unrelatedRequestId = randomUUID();
    await pool.query(`
      INSERT INTO "runtime"."runtime_requests" (
        id,
        kind,
        status,
        payload,
        result
      ) VALUES (
        $1,
        'tui_input',
        'completed',
        $2::jsonb,
        $3::jsonb
      )
    `, [
      unrelatedRequestId,
      JSON.stringify({text: "mentions subagent-session but has no ownership fields"}),
      JSON.stringify({text: "mentions subagent:subagent-session but has no ownership fields"}),
    ]);

    const plan = await service.purge({
      selector: {
        sessionId: "subagent-session",
      },
      execute: true,
    });

    expect(plan.dryRun).toBe(false);
    expect(plan.candidates[0]?.externalFileReferenceCount).toBe(1);
    expect(manager.stopped).toEqual([]);
    await expect(sessionStore.getSession("subagent-session")).rejects.toThrow("Unknown session");
    await expect(environmentStore.getEnvironment("subagent:subagent-session")).rejects.toThrow("Unknown execution environment");
    await expect(lstat(envRoot)).rejects.toThrow();
    await expect(pool.query(`SELECT COUNT(*)::INTEGER AS count FROM "runtime"."outbound_deliveries"`))
      .resolves.toMatchObject({rows: [{count: 1}]});
    await expect(pool.query(`SELECT id FROM "runtime"."outbound_deliveries" WHERE id = $1`, [unrelatedDeliveryId]))
      .resolves.toMatchObject({rows: [{id: unrelatedDeliveryId}]});
    await expect(pool.query(`SELECT COUNT(*)::INTEGER AS count FROM "runtime"."runtime_requests"`))
      .resolves.toMatchObject({rows: [{count: 1}]});
    await expect(pool.query(`SELECT id FROM "runtime"."runtime_requests" WHERE id = $1`, [unrelatedRequestId]))
      .resolves.toMatchObject({rows: [{id: unrelatedRequestId}]});
  });

  it("plans standalone environment purge candidates without attached subagents", async () => {
    const {environmentStore, environmentsRoot, service} = await createHarness();
    const envDir = "standalone-env";
    const envRoot = await createEnvRoot(environmentsRoot, "panda", envDir);
    await environmentStore.createEnvironment({
      id: "environment:main-session:standalone",
      agentKey: "panda",
      kind: "disposable_container",
      state: "stopped",
      runnerUrl: "http://standalone:8080",
      runnerCwd: "/workspace",
      rootPath: "/workspace",
      createdBySessionId: "main-session",
      metadata: {
        containerName: "panda-env-standalone",
        filesystem: filesystemMetadata(envRoot, envDir),
      },
    });

    const plan = await service.plan({
      selector: {
        environmentId: "environment:main-session:standalone",
      },
    });

    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]).toMatchObject({
      sessionId: "",
      sessionIds: [],
      environment: {
        id: "environment:main-session:standalone",
      },
      filesystem: {
        status: "safe",
        rootPath: envRoot,
      },
      dbCounts: {
        sessions: 0,
        threads: 0,
        executionEnvironments: 1,
        sessionEnvironmentBindings: 0,
      },
    });
  });

  it("purges a shared environment once and deletes every attached subagent", async () => {
    const {pool, environmentStore, envRoot, service, sessionStore, threadStore} = await createHarness();
    await createSessionWithInitialThread({
      pool,
      sessionStore,
      threadStore,
      session: {
        id: "subagent-two",
        agentKey: "panda",
        kind: "subagent",
        currentThreadId: "subagent-two-thread",
      },
      thread: {
        id: "subagent-two-thread",
        sessionId: "subagent-two",
      },
    });
    await environmentStore.bindSession({
      sessionId: "subagent-two",
      environmentId: "subagent:subagent-session",
      alias: "self",
      isDefault: true,
    });

    const plan = await service.purge({
      selector: {
        environmentId: "subagent:subagent-session",
      },
      execute: true,
    });

    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]?.sessionIds).toEqual(["subagent-session", "subagent-two"]);
    await expect(sessionStore.getSession("subagent-session")).rejects.toThrow("Unknown session");
    await expect(sessionStore.getSession("subagent-two")).rejects.toThrow("Unknown session");
    await expect(environmentStore.getEnvironment("subagent:subagent-session")).rejects.toThrow("Unknown execution environment");
    await expect(lstat(envRoot)).rejects.toThrow();
  });

  it("does not delete files when the DB purge fails", async () => {
    const {pool, environmentStore, envRoot, manager, sessionStore} = await createHarness();
    const service = new SubagentPurgeService({
      pool: createSessionDeleteFailingPool(pool),
      environmentStore,
      manager,
      env: {
        PANDA_ENVIRONMENTS_HOST_ROOT: path.dirname(path.dirname(envRoot)),
        PANDA_CORE_ENVIRONMENTS_ROOT: path.dirname(path.dirname(envRoot)),
      } as NodeJS.ProcessEnv,
    });

    await expect(service.purge({
      selector: {
        sessionId: "subagent-session",
      },
      execute: true,
    })).rejects.toThrow("simulated session delete failure");

    expect((await lstat(envRoot)).isDirectory()).toBe(true);
    await expect(sessionStore.getSession("subagent-session")).resolves.toMatchObject({id: "subagent-session"});
  });

  it("uses the core-visible environment root when host path is unavailable", async () => {
    const {environmentStore, environmentsRoot, envRoot, service} = await createHarness();
    const existing = await environmentStore.getEnvironment("subagent:subagent-session");
    const envDir = "subagent-session";
    const metadata = filesystemMetadata(envRoot, envDir);
    await environmentStore.createEnvironment({
      ...existing,
      metadata: {
        ...existing.metadata,
        filesystem: {
          ...metadata,
          root: {
            ...metadata.root,
            hostPath: path.join(environmentsRoot, "missing", envDir),
            corePath: envRoot,
          },
        },
      },
    });

    const plan = await service.plan({
      selector: {
        sessionId: "subagent-session",
      },
    });

    expect(plan.candidates[0]?.filesystem).toMatchObject({
      status: "safe",
      rootPath: envRoot,
    });
  });

  it("refuses active unexpired ready subagents unless forced and stops them through the manager", async () => {
    const {environmentStore, manager, service} = await createHarness();
    const existing = await environmentStore.getEnvironment("subagent:subagent-session");
    await environmentStore.createEnvironment({
      ...existing,
      state: "ready",
      expiresAt: Date.now() + 60_000,
    });

    await expect(service.purge({
      selector: {
        sessionId: "subagent-session",
      },
      execute: true,
      now: Date.now(),
    })).rejects.toThrow("Refusing to purge subagent subagent-session");

    await service.purge({
      selector: {
        sessionId: "subagent-session",
      },
      execute: true,
      force: true,
      now: Date.now(),
    });

    expect(manager.stopped).toEqual(["subagent:subagent-session"]);
  });

  it("fails execute on missing filesystem roots unless skip-files is set", async () => {
    const {envRoot, service, sessionStore} = await createHarness();
    await rm(envRoot, {recursive: true, force: true});

    const plan = await service.plan({
      selector: {
        sessionId: "subagent-session",
      },
    });
    expect(plan.candidates[0]?.filesystem.status).toBe("missing");

    await expect(service.purge({
      selector: {
        sessionId: "subagent-session",
      },
      execute: true,
    })).rejects.toThrow("filesystem root is missing");

    await service.purge({
      selector: {
        sessionId: "subagent-session",
      },
      execute: true,
      skipFiles: true,
    });
    await expect(sessionStore.getSession("subagent-session")).rejects.toThrow("Unknown session");
  });

  it("parses purge duration options", () => {
    expect(parseDurationOption("7d")).toBe(7 * 24 * 60 * 60_000);
    expect(parseDurationOption("12h")).toBe(12 * 60 * 60_000);
    expect(parseDurationOption("1000ms")).toBe(1000);
    expect(() => parseDurationOption("soon")).toThrow("Expected a duration");
    expect(() => buildPurgeInput({})).toThrow("requires at least one selector");
    expect(() => buildPurgeInput({dryRun: true, execute: true, stopped: true})).toThrow("either --dry-run or --execute");
  });
});
