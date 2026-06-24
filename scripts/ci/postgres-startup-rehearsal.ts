#!/usr/bin/env tsx
import {readdir, readFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {A2ASessionBindingRepo} from "../../src/domain/a2a/repo.js";
import {PostgresAgentAppAuthService} from "../../src/domain/apps/auth.js";
import {PostgresAgentStore} from "../../src/domain/agents/index.js";
import {PostgresChannelActionStore} from "../../src/domain/channels/actions/index.js";
import {PostgresOutboundDeliveryStore} from "../../src/domain/channels/deliveries/index.js";
import {PostgresConnectorLeaseRepo} from "../../src/domain/connector-leases/repo.js";
import {PostgresCredentialStore} from "../../src/domain/credentials/postgres.js";
import {PostgresEmailStore} from "../../src/domain/email/postgres.js";
import {PostgresExecutionEnvironmentStore} from "../../src/domain/execution-environments/postgres.js";
import {PostgresIdentityStore} from "../../src/domain/identity/index.js";
import {PostgresScheduledTaskStore} from "../../src/domain/scheduling/tasks/index.js";
import {ConversationRepo, PostgresSessionStore, SessionRouteRepo} from "../../src/domain/sessions/index.js";
import {RuntimeRequestRepo} from "../../src/domain/threads/requests/index.js";
import {
  ensureReadonlySessionQuerySchema,
  PostgresThreadRuntimeStore,
} from "../../src/domain/threads/runtime/index.js";
import {PostgresWatchStore} from "../../src/domain/watches/index.js";
import {PostgresWikiBindingStore} from "../../src/domain/wiki/postgres.js";
import {recreateSmokeDatabase} from "../../src/app/smoke/database.js";
import {createPostgresPool} from "../../src/app/runtime/database.js";
import {ensureSchemas} from "../../src/app/runtime/postgres-bootstrap.js";
import {DaemonStateRepo} from "../../src/app/runtime/state/repo.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureDir = path.join(repoRoot, "scripts/ci/postgres-fixtures");

function requireTestDatabaseUrl(): string {
  const value = process.env.TEST_DATABASE_URL?.trim();
  if (!value) {
    throw new Error("Postgres startup rehearsal requires TEST_DATABASE_URL.");
  }
  return value;
}

function createStores(pool: ReturnType<typeof createPostgresPool>) {
  return {
    a2aBindings: new A2ASessionBindingRepo({pool}),
    agentStore: new PostgresAgentStore({pool}),
    appAuth: new PostgresAgentAppAuthService({pool}),
    channelActions: new PostgresChannelActionStore({pool}),
    connectorLeases: new PostgresConnectorLeaseRepo({pool}),
    conversationBindings: new ConversationRepo({pool}),
    credentials: new PostgresCredentialStore({pool}),
    daemonState: new DaemonStateRepo({pool}),
    email: new PostgresEmailStore({pool}),
    executionEnvironments: new PostgresExecutionEnvironmentStore({pool}),
    identityStore: new PostgresIdentityStore({pool}),
    outboundDeliveries: new PostgresOutboundDeliveryStore({pool}),
    requests: new RuntimeRequestRepo({pool}),
    scheduledTasks: new PostgresScheduledTaskStore({pool}),
    sessionRoutes: new SessionRouteRepo({pool}),
    sessionStore: new PostgresSessionStore({pool}),
    threadStore: new PostgresThreadRuntimeStore({pool}),
    watches: new PostgresWatchStore({pool}),
    wikiBindings: new PostgresWikiBindingStore({pool}),
  };
}

async function ensureBaseFixtureSchemas(stores: ReturnType<typeof createStores>): Promise<void> {
  await ensureSchemas([
    stores.identityStore,
    stores.agentStore,
    stores.sessionStore,
    stores.threadStore,
  ]);
  await stores.identityStore.ensureIdentity({
    id: "ci-smoke-identity",
    handle: "ci-smoke",
    displayName: "CI Smoke",
  });
  await stores.agentStore.bootstrapAgent({
    agentKey: "panda",
    displayName: "Panda",
  });
}

async function ensureRuntimeStartupSchemas(
  pool: ReturnType<typeof createPostgresPool>,
  stores: ReturnType<typeof createStores>,
): Promise<void> {
  await ensureSchemas([
    stores.identityStore,
    stores.agentStore,
    stores.sessionStore,
    stores.executionEnvironments,
    stores.threadStore,
    stores.credentials,
    stores.appAuth,
    stores.email,
    stores.scheduledTasks,
    stores.watches,
    stores.wikiBindings,
    stores.conversationBindings,
    stores.sessionRoutes,
    stores.outboundDeliveries,
    stores.a2aBindings,
    stores.channelActions,
    stores.connectorLeases,
    stores.requests,
    stores.daemonState,
  ]);
  await ensureReadonlySessionQuerySchema({
    queryable: pool,
    readonlyRole: null,
  });
}

async function applyFixture(pool: ReturnType<typeof createPostgresPool>, fixturePath: string): Promise<void> {
  const sql = await readFile(fixturePath, "utf8");
  await pool.query(sql);
}

async function listFixtures(): Promise<string[]> {
  const entries = await readdir(fixtureDir, {withFileTypes: true});
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => path.join(fixtureDir, entry.name))
    .toSorted();
}

async function assertRegclasses(pool: ReturnType<typeof createPostgresPool>, names: readonly string[]): Promise<void> {
  for (const name of names) {
    const result = await pool.query("SELECT to_regclass($1) AS relation", [name]);
    if (!result.rows[0]?.relation) {
      throw new Error(`Expected relation ${name} to exist after startup rehearsal.`);
    }
  }
}

async function assertLegacyThreadContextColumnDropped(pool: ReturnType<typeof createPostgresPool>): Promise<void> {
  const result = await pool.query(`
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'runtime'
      AND table_name = 'threads'
      AND column_name = 'context'
    LIMIT 1
  `);
  if (result.rows.length > 0) {
    throw new Error("Expected legacy runtime.threads.context column to be dropped after startup rehearsal.");
  }
}

async function assertCoreRelations(pool: ReturnType<typeof createPostgresPool>): Promise<void> {
  await assertRegclasses(pool, [
    "runtime.agents",
    "runtime.identities",
    "runtime.agent_sessions",
    "runtime.threads",
    "runtime.messages",
    "runtime.tool_jobs",
    "runtime.session_routes",
    "runtime.credentials",
    "session.agent_sessions",
    "session.messages",
    "session.tool_results",
    "session.subagent_history",
  ]);
}

async function runScenario(name: string, fixturePath?: string): Promise<void> {
  const target = await recreateSmokeDatabase(requireTestDatabaseUrl());
  const pool = createPostgresPool({
    connectionString: target.connectionString,
    applicationName: `panda/ci-postgres-${name}`,
    max: 1,
  });

  try {
    const stores = createStores(pool);
    if (fixturePath) {
      await ensureBaseFixtureSchemas(stores);
      await applyFixture(pool, fixturePath);
    }
    await ensureRuntimeStartupSchemas(pool, stores);
    await assertCoreRelations(pool);
    await assertLegacyThreadContextColumnDropped(pool);
    process.stdout.write(`Postgres startup rehearsal passed: ${name}\n`);
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  await runScenario("fresh");
  for (const fixturePath of await listFixtures()) {
    await runScenario(path.basename(fixturePath, ".sql"), fixturePath);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
