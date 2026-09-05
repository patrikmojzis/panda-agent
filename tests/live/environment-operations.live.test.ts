import {randomUUID} from "node:crypto";
import {mkdtemp, mkdir, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from "vitest";

import {PANDA_SCHEMA_MIGRATIONS} from "../../src/app/database/migration-catalog.js";
import {createPostgresPool} from "../../src/lib/postgres-database.js";
import {ExecutionEnvironmentLifecycleService} from "../../src/app/runtime/execution-environment-service.js";
import {ExecutionEnvironmentResolver} from "../../src/app/runtime/execution-environment-resolver.js";
import {SubagentPurgeService} from "../../src/app/runtime/subagent-purge-service.js";
import {recreateSmokeDatabase} from "../../src/app/smoke/database.js";
import {PostgresAgentStore} from "../../src/domain/agents/postgres.js";
import {PostgresExecutionEnvironmentStore} from "../../src/domain/execution-environments/postgres.js";
import type {ExecutionEnvironmentManager, ExecutionEnvironmentRecord} from "../../src/domain/execution-environments/types.js";
import {PostgresSessionStore} from "../../src/domain/sessions/postgres.js";
import {createPostgresMigrator} from "../../src/lib/postgres-migrations.js";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
const liveIt = databaseUrl ? it : it.skip;

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {...fs, rm: vi.fn(fs.rm)};
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return {promise, release};
}

describe.sequential("execution environment operation ownership with PostgreSQL", () => {
  let pool: ReturnType<typeof createPostgresPool>;
  let store: PostgresExecutionEnvironmentStore;
  const tempRoots: string[] = [];
  const session = {id: "environment-owner", agentKey: "panda", kind: "main" as const};

  beforeAll(async () => {
    if (!databaseUrl) return;
    const target = await recreateSmokeDatabase(databaseUrl);
    pool = createPostgresPool({connectionString: target.connectionString, applicationName: "panda/environment-operations-test", max: 4});
    const index = PANDA_SCHEMA_MIGRATIONS.findIndex(({id}) => id === "0021_environment_operation_ownership");
    if (index < 0) throw new Error("Environment ownership migration is missing.");
    const migrate = (count: number) => createPostgresMigrator({
      pool, migrations: PANDA_SCHEMA_MIGRATIONS.slice(0, count),
      schemaName: "runtime", tableName: "schema_migrations", lockName: "panda:environment-operations-test",
    }).migrate();
    await migrate(index);
    await new PostgresAgentStore({pool}).bootstrapAgent({agentKey: "panda", displayName: "Panda"});
    await new PostgresSessionStore({pool}).createSession({...session, currentThreadId: "environment-owner-thread"});
    await pool.query(`
      INSERT INTO runtime.execution_environments (id,agent_key,kind,state,created_by_session_id,expires_at)
      VALUES ('legacy-provisioning','panda','disposable_container','provisioning',$1,NOW() - INTERVAL '1 day')
    `, [session.id]);
    await migrate(PANDA_SCHEMA_MIGRATIONS.length);
    store = new PostgresExecutionEnvironmentStore({pool});
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    for (const root of tempRoots.splice(0)) await fs.rm(root, {recursive: true, force: true});
  });
  afterAll(async () => { await pool?.end(); });

  function manager() {
    return {
      createDisposableEnvironment: vi.fn(async () => ({runnerUrl: "http://fake-runner:8080", runnerCwd: "/workspace", metadata: {containerName: "fake"}})),
      stopEnvironment: vi.fn(async () => {}),
    } satisfies ExecutionEnvironmentManager;
  }

  async function existing(state: "ready" | "stopped" = "ready") {
    return store.createEnvironment({
      id: randomUUID(), agentKey: session.agentKey, kind: "disposable_container", state,
      createdBySessionId: session.id, expiresAt: Date.now() - 60_000,
      metadata: {ownerNote: "keep"},
    });
  }

  async function binding(environment: ExecutionEnvironmentRecord) {
    return store.bindSession({sessionId: session.id, environmentId: environment.id, alias: `env-${environment.id}`, isDefault: true});
  }

  async function purgeFilesystem() {
    const environment = await existing("stopped");
    const root = await mkdtemp(path.join(os.tmpdir(), "panda-environment-ownership-"));
    tempRoots.push(root);
    const envRoot = path.join(root, session.agentKey, environment.id);
    await mkdir(envRoot, {recursive: true});
    const directory = (name: string) => ({corePath: path.join(envRoot, name), workerPath: `/${name}`});
    await store.createEnvironment({...environment, metadata: {filesystem: {
      envDir: environment.id, root: {corePath: envRoot},
      workspace: directory("workspace"), inbox: directory("inbox"), artifacts: directory("artifacts"),
    }}});
    const purge = new SubagentPurgeService({pool, environmentStore: store, manager: manager(), env: {PANDA_CORE_ENVIRONMENTS_ROOT: root}});
    return {environment, envRoot, purge};
  }

  liveIt("preserves legacy in-progress rows and never reclaims them after expiry", async () => {
    const environment = await store.getEnvironment("legacy-provisioning");
    expect(environment).toMatchObject({state: "provisioning", operationId: undefined});
    const fake = manager();
    const lifecycle = new ExecutionEnvironmentLifecycleService({store, manager: fake});
    await expect(lifecycle.attachSessionToDisposableEnvironment({session, environmentId: environment.id, ownerSessionId: session.id})).rejects.toThrow("must finish");
    await expect(lifecycle.stopEnvironment(environment.id)).rejects.toThrow("must finish");
    expect(fake.createDisposableEnvironment).not.toHaveBeenCalled();
    expect(fake.stopEnvironment).not.toHaveBeenCalled();
    expect((await store.getEnvironment(environment.id)).expiresAt).toBe(environment.expiresAt);
  });

  liveIt("reserves a new id once across concurrent creates", async () => {
    const fake = manager();
    const lifecycle = new ExecutionEnvironmentLifecycleService({store, manager: fake});
    const input = {agentKey: session.agentKey, createdBySessionId: session.id, environmentId: randomUUID()};
    const results = await Promise.allSettled([
      lifecycle.createStandaloneDisposableEnvironment(input),
      lifecycle.createStandaloneDisposableEnvironment(input),
    ]);
    expect(results.filter(({status}) => status === "fulfilled")).toHaveLength(1);
    expect(fake.createDisposableEnvironment).toHaveBeenCalledTimes(1);
    expect((await store.getEnvironment(input.environmentId)).state).toBe("ready");
  });

  liveIt("gates stop against resolver restart and preserves concurrent metadata", async () => {
    const environment = await existing();
    await binding(environment);
    const entered = gate();
    const finish = gate();
    const fake = manager();
    fake.stopEnvironment.mockImplementation(async () => { entered.release(); await finish.promise; });
    const lifecycle = new ExecutionEnvironmentLifecycleService({store, manager: fake});
    const stopping = lifecycle.stopEnvironment(environment.id);
    await entered.promise;
    const resolver = new ExecutionEnvironmentResolver({store, lifecycle, defaultToolPolicy: {}});
    await expect(resolver.resolveDefault(session)).rejects.toThrow("stopping");
    await expect(store.createEnvironment({...environment, state: "ready"})).rejects.toThrow("cannot be replaced");
    await pool.query(`UPDATE runtime.execution_environments SET metadata = metadata || '{"operatorNote":"new"}'::jsonb WHERE id = $1`, [environment.id]);
    finish.release();
    await expect(stopping).resolves.toMatchObject({state: "stopped", metadata: {ownerNote: "keep", operatorNote: "new"}});
    expect(fake.createDisposableEnvironment).not.toHaveBeenCalled();
    expect(fake.stopEnvironment).toHaveBeenCalledTimes(1);
  });

  liveIt("does not sweep an environment while resolver restart is provisioning", async () => {
    const environment = await existing();
    const attached = await binding(environment);
    const entered = gate();
    const finish = gate();
    const fake = manager();
    fake.createDisposableEnvironment.mockImplementation(async () => {
      entered.release(); await finish.promise;
      return {runnerUrl: "http://fake-runner:8080", runnerCwd: "/workspace", metadata: {containerName: "fake"}};
    });
    const lifecycle = new ExecutionEnvironmentLifecycleService({store, manager: fake});
    const restarting = lifecycle.ensureBoundEnvironmentReady({session, binding: attached});
    await entered.promise;
    await lifecycle.sweepExpiredEnvironments();
    expect(fake.stopEnvironment).not.toHaveBeenCalled();
    finish.release();
    await expect(restarting).resolves.toMatchObject({state: "ready", metadata: {ownerNote: "keep", containerName: "fake"}});
  });

  liveIt("rechecks expiry when sweep claims a stale candidate", async () => {
    const environment = await existing();
    vi.spyOn(store, "listExpiredDisposableEnvironments").mockImplementationOnce(async () => {
      await pool.query(`UPDATE runtime.execution_environments SET expires_at = NOW() + INTERVAL '1 day' WHERE id = $1`, [environment.id]);
      return [environment];
    });
    const fake = manager();
    const lifecycle = new ExecutionEnvironmentLifecycleService({store, manager: fake});
    await expect(lifecycle.sweepExpiredEnvironments()).resolves.toMatchObject({stopped: 0, failed: 1});
    expect(fake.stopEnvironment).not.toHaveBeenCalled();
    expect((await store.getEnvironment(environment.id)).state).toBe("ready");
  });

  liveIt("keeps a timed-out manager operation unresolved and does not overlap it", async () => {
    const environment = await existing();
    const fake = manager();
    fake.stopEnvironment.mockRejectedValueOnce(new Error("HTTP response timed out while manager still runs"));
    const lifecycle = new ExecutionEnvironmentLifecycleService({store, manager: fake});
    await expect(lifecycle.stopEnvironment(environment.id)).rejects.toThrow("unresolved outcome");
    await expect(lifecycle.stopEnvironment(environment.id)).rejects.toThrow("must finish");
    await expect(lifecycle.attachSessionToDisposableEnvironment({session, environmentId: environment.id, ownerSessionId: session.id})).rejects.toThrow("must finish");
    expect(fake.stopEnvironment).toHaveBeenCalledTimes(1);
    expect(fake.createDisposableEnvironment).not.toHaveBeenCalled();
  });

  liveIt("accepts a lost ready receipt acknowledgement without cleanup or repeated create", async () => {
    const settle = store.settleEnvironmentOperation.bind(store);
    vi.spyOn(store, "settleEnvironmentOperation").mockImplementationOnce(async (input) => {
      await settle(input);
      throw new Error("commit acknowledgement lost");
    });
    const fake = manager();
    const lifecycle = new ExecutionEnvironmentLifecycleService({store, manager: fake});
    await expect(lifecycle.createStandaloneDisposableEnvironment({agentKey: session.agentKey, createdBySessionId: session.id})).resolves.toMatchObject({state: "ready"});
    expect(fake.createDisposableEnvironment).toHaveBeenCalledTimes(1);
    expect(fake.stopEnvironment).not.toHaveBeenCalled();
  });

  liveIt("retains a timed-out create claim without cleanup or duplicate provisioning", async () => {
    const fake = manager();
    fake.createDisposableEnvironment.mockRejectedValueOnce(new Error("response lost while manager creates"));
    const lifecycle = new ExecutionEnvironmentLifecycleService({store, manager: fake});
    const input = {agentKey: session.agentKey, createdBySessionId: session.id, environmentId: randomUUID()};
    await expect(lifecycle.createStandaloneDisposableEnvironment(input)).rejects.toThrow("unresolved outcome");
    await expect(lifecycle.createStandaloneDisposableEnvironment(input)).rejects.toThrow("already exists");
    expect(fake.createDisposableEnvironment).toHaveBeenCalledTimes(1);
    expect(fake.stopEnvironment).not.toHaveBeenCalled();
    expect((await store.getEnvironment(input.environmentId)).state).toBe("provisioning");
  });

  liveIt("retains provisioning when receipt retries fail without cleaning up known create success", async () => {
    const receipt = vi.spyOn(store, "settleEnvironmentOperation").mockRejectedValue(new Error("database unavailable"));
    const fake = manager();
    const lifecycle = new ExecutionEnvironmentLifecycleService({store, manager: fake});
    const environmentId = randomUUID();
    await expect(lifecycle.createStandaloneDisposableEnvironment({agentKey: session.agentKey, createdBySessionId: session.id, environmentId})).rejects.toThrow("receipt is unresolved");
    expect(receipt).toHaveBeenCalledTimes(3);
    expect(fake.createDisposableEnvironment).toHaveBeenCalledTimes(1);
    expect(fake.stopEnvironment).not.toHaveBeenCalled();
    expect((await store.getEnvironment(environmentId)).state).toBe("provisioning");
  });

  liveIt("allows one concurrent claim and rejects stale terminal settlement", async () => {
    const environment = await existing();
    const input = {environmentId: environment.id, expectedState: "ready" as const, state: "stopping" as const};
    const claims = await Promise.all([
      store.claimEnvironmentOperation({...input, operationId: randomUUID()}),
      new PostgresExecutionEnvironmentStore({pool}).claimEnvironmentOperation({...input, operationId: randomUUID()}),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const claimed = claims.find(Boolean)!;
    await store.settleEnvironmentOperation({environmentId: environment.id, operationId: claimed.operationId!, operationState: "stopping", state: "stopped"});
    const successor = await store.claimEnvironmentOperation({environmentId: environment.id, expectedOperationId: claimed.operationId, expectedState: "stopped", state: "provisioning", operationId: randomUUID()});
    await expect(store.settleEnvironmentOperation({environmentId: environment.id, operationId: claimed.operationId!, operationState: "stopping", state: "stopped"})).resolves.toBeNull();
    expect(await store.getEnvironment(environment.id)).toMatchObject({state: "provisioning", operationId: successor!.operationId});
  });

  liveIt("routes forced purge through the same fence", async () => {
    const environment = await existing();
    const claimed = await store.claimEnvironmentOperation({environmentId: environment.id, expectedState: "ready", operationId: randomUUID(), state: "stopping"});
    const fake = manager();
    const purge = new SubagentPurgeService({pool, environmentStore: store, manager: fake});
    await expect(purge.purge({selector: {environmentId: environment.id}, execute: true, force: true, skipFiles: true})).rejects.toThrow("must finish");
    expect(fake.stopEnvironment).not.toHaveBeenCalled();
    expect((await store.getEnvironment(environment.id)).operationId).toBe(claimed!.operationId);
  });

  liveIt("rechecks terminal state under the purge deletion lock", async () => {
    const environment = await existing("stopped");
    const fake = manager();
    const purge = new SubagentPurgeService({pool, environmentStore: store, manager: fake});
    const plan = purge.plan.bind(purge);
    vi.spyOn(purge, "plan").mockImplementationOnce(async (input) => {
      const snapshot = await plan(input);
      await store.claimEnvironmentOperation({environmentId: environment.id, expectedState: "stopped", operationId: randomUUID(), state: "provisioning"});
      return snapshot;
    });
    await expect(purge.purge({selector: {environmentId: environment.id}, execute: true, skipFiles: true})).rejects.toThrow("became provisioning after planning");
    expect((await store.getEnvironment(environment.id)).state).toBe("provisioning");
    expect(fake.stopEnvironment).not.toHaveBeenCalled();
  });

  liveIt("does not purge a successor that completed after planning", async () => {
    const environment = await existing("stopped");
    const purge = new SubagentPurgeService({pool, environmentStore: store, manager: manager()});
    const plan = purge.plan.bind(purge);
    vi.spyOn(purge, "plan").mockImplementationOnce(async (input) => {
      const snapshot = await plan(input);
      const claimed = await store.claimEnvironmentOperation({environmentId: environment.id, expectedState: "stopped", operationId: randomUUID(), state: "provisioning"});
      await store.settleEnvironmentOperation({environmentId: environment.id, operationId: claimed!.operationId!, operationState: "provisioning", state: "failed"});
      return snapshot;
    });
    await expect(purge.purge({selector: {environmentId: environment.id}, execute: true, skipFiles: true})).rejects.toThrow("operation changed after planning");
    expect((await store.getEnvironment(environment.id)).state).toBe("failed");
  });

  liveIt("blocks reuse of an id until its old filesystem cleanup finishes", async () => {
    const {environment, purge} = await purgeFilesystem();
    const entered = gate();
    const finish = gate();
    const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(rm).mockImplementationOnce(async (root, options) => {
      entered.release(); await finish.promise; await fs.rm(root, options);
    });
    const purging = purge.purge({selector: {environmentId: environment.id}, execute: true});
    await entered.promise;
    const replacement = store.reserveEnvironment({...environment, operationId: randomUUID()});
    await expect.poll(async () => {
      const result = await pool.query(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()) AS waiting`);
      return result.rows[0]?.waiting;
    }).toBe(true);
    finish.release();
    await purging;
    await expect(replacement).resolves.toMatchObject({id: environment.id, state: "provisioning"});
  });

  liveIt("rolls back durable purge deletion when filesystem removal fails", async () => {
    const {environment, purge} = await purgeFilesystem();
    vi.mocked(rm).mockRejectedValueOnce(new Error("filesystem unavailable"));
    await expect(purge.purge({selector: {environmentId: environment.id}, execute: true})).rejects.toThrow("filesystem unavailable");
    expect(await store.getEnvironment(environment.id)).toMatchObject({id: environment.id, state: "stopped"});
  });
});
