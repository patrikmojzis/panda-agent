import {lstat, mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {randomUUID} from "node:crypto";

import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";

import {
  type DisposableEnvironmentCreateRequest,
  type DisposableEnvironmentCreateResult,
  type ExecutionEnvironmentManager,
  PostgresExecutionEnvironmentStore,
} from "../src/domain/execution-environments/index.js";
import {createSessionWithInitialThread} from "../src/domain/sessions/index.js";
import {A2ASessionBindingRepo} from "../src/domain/a2a/repo.js";
import {PostgresOutboundDeliveryStore} from "../src/domain/channels/deliveries/postgres.js";
import {RuntimeRequestRepo} from "../src/domain/threads/requests/repo.js";
import {WorkerPurgeService} from "../src/app/runtime/worker-purge-service.js";
import {ensureSchemas} from "../src/app/runtime/postgres-bootstrap.js";
import {buildPurgeInput, parseDurationOption} from "../src/app/workers/cli.js";
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
        query: async (queryText: unknown, values?: unknown[]) => {
          if (
            typeof queryText === "string"
            && queryText.includes(`DELETE FROM "runtime"."agent_sessions"`)
          ) {
            throw new Error("simulated session delete failure");
          }
          return client.query(queryText as never, values as never);
        },
        release: () => client.release(),
      };
    },
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

describe("WorkerPurgeService", () => {
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
        id: "worker-session",
        agentKey: "panda",
        kind: "worker",
        currentThreadId: "worker-thread",
      },
      thread: {
        id: "worker-thread",
        sessionId: "worker-session",
      },
    });

    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "panda-worker-purge-"));
    tempDirs.push(tempRoot);
    const environmentsRoot = path.join(tempRoot, "environments");
    const envDir = "worker-session";
    const envRoot = await createEnvRoot(environmentsRoot, "panda", envDir);
    await environmentStore.createEnvironment({
      id: "worker:worker-session",
      agentKey: "panda",
      kind: "disposable_container",
      state: "stopped",
      runnerUrl: "http://worker:8080",
      runnerCwd: "/workspace",
      rootPath: "/workspace",
      createdBySessionId: "main-session",
      createdForSessionId: "worker-session",
      metadata: {
        containerName: "panda-env-worker-session",
        filesystem: filesystemMetadata(envRoot, envDir),
      },
    });
    await environmentStore.bindSession({
      sessionId: "worker-session",
      environmentId: "worker:worker-session",
      alias: "self",
      isDefault: true,
    });

    const manager = new FakeEnvironmentManager();
    const service = new WorkerPurgeService({
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

  it("plans stopped worker purge candidates with row and file counts without mutating", async () => {
    const {pool, envRoot, service, threadStore} = await createHarness();
    await threadStore.enqueueInput("worker-thread", {
      source: "test",
      message: {role: "user", content: "hello"},
    });
    await threadStore.appendRuntimeMessage("worker-thread", {
      source: "test",
      message: {role: "assistant", content: "done"},
    });
    await pool.query(`
      UPDATE "runtime"."execution_environments"
      SET updated_at = $1
      WHERE id = 'worker:worker-session'
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
      JSON.stringify({sessionId: "worker-session"}),
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
      sessionId: "worker-session",
      environment: {
        id: "worker:worker-session",
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
      externalFileReferenceCount: 1,
    });
    await expect(service.plan({selector: {sessionId: "main-session"}})).rejects.toThrow(
      "No worker-owned disposable environment matched",
    );
  });

  it("hard purges non-cascading rows, cascaded session rows, environment row, and env files", async () => {
    const {pool, a2a, environmentStore, envRoot, manager, requests, service, sessionStore} = await createHarness();
    await a2a.bindSession({
      senderSessionId: "main-session",
      recipientSessionId: "worker-session",
    });
    await requests.enqueueRequest({
      kind: "create_worker_session",
      payload: {
        sessionId: "worker-session",
        threadId: "worker-thread",
        task: "old work",
      },
    });
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
        'worker-thread',
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
      JSON.stringify({workerSessionId: "worker-session"}),
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
      JSON.stringify([{type: "text", text: "mentions worker-session but is not worker-owned"}]),
      JSON.stringify({note: "mentions worker:worker-session"}),
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
      JSON.stringify({text: "mentions worker-session but has no ownership fields"}),
      JSON.stringify({text: "mentions worker:worker-session but has no ownership fields"}),
    ]);

    const plan = await service.purge({
      selector: {
        sessionId: "worker-session",
      },
      execute: true,
    });

    expect(plan.dryRun).toBe(false);
    expect(manager.stopped).toEqual([]);
    await expect(sessionStore.getSession("worker-session")).rejects.toThrow("Unknown session");
    await expect(environmentStore.getEnvironment("worker:worker-session")).rejects.toThrow("Unknown execution environment");
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

  it("does not delete files when the DB purge fails", async () => {
    const {pool, environmentStore, envRoot, manager, sessionStore} = await createHarness();
    const service = new WorkerPurgeService({
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
        sessionId: "worker-session",
      },
      execute: true,
    })).rejects.toThrow("simulated session delete failure");

    await expect(lstat(envRoot)).resolves.toBeTruthy();
    await expect(sessionStore.getSession("worker-session")).resolves.toMatchObject({id: "worker-session"});
  });

  it("uses the core-visible environment root when host path is unavailable", async () => {
    const {environmentStore, environmentsRoot, envRoot, service} = await createHarness();
    const existing = await environmentStore.getEnvironment("worker:worker-session");
    const envDir = "worker-session";
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
        sessionId: "worker-session",
      },
    });

    expect(plan.candidates[0]?.filesystem).toMatchObject({
      status: "safe",
      rootPath: envRoot,
    });
  });

  it("refuses active unexpired ready workers unless forced and stops them through the manager", async () => {
    const {environmentStore, manager, service} = await createHarness();
    const existing = await environmentStore.getEnvironment("worker:worker-session");
    await environmentStore.createEnvironment({
      ...existing,
      state: "ready",
      expiresAt: Date.now() + 60_000,
    });

    await expect(service.purge({
      selector: {
        sessionId: "worker-session",
      },
      execute: true,
      now: Date.now(),
    })).rejects.toThrow("Refusing to purge worker worker-session");

    await service.purge({
      selector: {
        sessionId: "worker-session",
      },
      execute: true,
      force: true,
      now: Date.now(),
    });

    expect(manager.stopped).toEqual(["worker:worker-session"]);
  });

  it("fails execute on missing filesystem roots unless skip-files is set", async () => {
    const {envRoot, service, sessionStore} = await createHarness();
    await rm(envRoot, {recursive: true, force: true});

    const plan = await service.plan({
      selector: {
        sessionId: "worker-session",
      },
    });
    expect(plan.candidates[0]?.filesystem.status).toBe("missing");

    await expect(service.purge({
      selector: {
        sessionId: "worker-session",
      },
      execute: true,
    })).rejects.toThrow("filesystem root is missing");

    await service.purge({
      selector: {
        sessionId: "worker-session",
      },
      execute: true,
      skipFiles: true,
    });
    await expect(sessionStore.getSession("worker-session")).rejects.toThrow("Unknown session");
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
