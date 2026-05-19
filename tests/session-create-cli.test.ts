import {afterEach, describe, expect, it, vi} from "vitest";
import {Command} from "commander";
import {DataType, newDb} from "pg-mem";

import {createRuntimeStores} from "./helpers/runtime-store-setup.js";
import {registerSessionCommands} from "../src/app/sessions/cli.js";
import {resolveAgentDir} from "../src/lib/data-dir.js";

const sessionCreateCliMocks = vi.hoisted(() => {
  const state: {
    pool?: {
      connect(): Promise<unknown>;
      query(text: string, values?: readonly unknown[]): Promise<unknown>;
    };
  } = {};

  return {
    state,
    withPostgresPool: vi.fn(async (
      _dbUrl: string | undefined,
      fn: (pool: NonNullable<typeof state.pool>) => Promise<unknown>,
    ) => {
      if (!state.pool) {
        throw new Error("Expected test pool to be configured.");
      }

      return fn(state.pool);
    }),
  };
});

vi.mock("../src/lib/postgres-bootstrap.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/postgres-bootstrap.js")>();
  return {
    ...actual,
    withPostgresPool: sessionCreateCliMocks.withPostgresPool,
  };
});

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeErr: () => {},
  });
  registerSessionCommands(program);
  return program;
}

function collectWrites(write: {mock: {calls: unknown[][]}}): string {
  return write.mock.calls.map((call) => String(call[0])).join("");
}

function readOutputValue(output: string, label: string): string {
  const match = output.match(new RegExp(`^${label} (.+)$`, "m"));
  if (!match?.[1]) {
    throw new Error(`Missing ${label} in output:\n${output}`);
  }

  return match[1];
}

async function createHarness() {
  const db = newDb({noAstCoverageCheck: true});
  db.public.registerFunction({
    name: "pg_notify",
    args: [DataType.text, DataType.text],
    returns: DataType.text,
    implementation: () => "",
  });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  sessionCreateCliMocks.state.pool = pool;
  const stores = await createRuntimeStores(pool);
  return {
    pool,
    ...stores,
  };
}

interface TestPool {
  query(text: string, values?: readonly unknown[]): Promise<{rows: unknown[]}>;
}

async function tableCount(pool: TestPool, table: string): Promise<number> {
  const result = await pool.query(`SELECT COUNT(*)::INTEGER AS count FROM "runtime"."${table}"`);
  const row = result.rows[0] as {count: number | string};
  return Number(row.count);
}

async function rowCounts(pool: TestPool): Promise<{
  sessions: number;
  threads: number;
  heartbeats: number;
}> {
  return {
    sessions: await tableCount(pool, "agent_sessions"),
    threads: await tableCount(pool, "threads"),
    heartbeats: await tableCount(pool, "session_heartbeats"),
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_CREATE_TEST_TIMEOUT_MS = 15_000;

describe("Session create CLI", () => {
  const pools: Array<{end(): Promise<void>}> = [];

  afterEach(async () => {
    sessionCreateCliMocks.state.pool = undefined;
    sessionCreateCliMocks.withPostgresPool.mockClear();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();

    while (pools.length > 0) {
      await pools.pop()?.end();
    }
  });

  it("creates a generated branch session with a disabled heartbeat", async () => {
    vi.stubEnv("DATA_DIR", "/tmp/panda-session-create-generated");
    const {pool, sessionStore, threadStore} = await createHarness();
    pools.push(pool);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync([
      "session",
      "create",
      "panda",
      "--db-url",
      "postgres://session-create-test",
    ], {from: "user"});

    const output = collectWrites(write);
    const sessionId = readOutputValue(output, "sessionId");
    const threadId = readOutputValue(output, "initialThread");
    expect(sessionId).toMatch(UUID_PATTERN);
    expect(threadId).toMatch(UUID_PATTERN);
    expect(output).toContain("Created branch session.\n");
    expect(output).toContain("agent panda\n");
    expect(output).not.toContain("\nref ");
    expect(output).toContain(
      `panda discord bind-channel --account <accountKey> --channel <discordChannelId> --session ${sessionId}`,
    );

    await expect(sessionStore.getSession(sessionId)).resolves.toMatchObject({
      id: sessionId,
      agentKey: "panda",
      kind: "branch",
      currentThreadId: threadId,
    });
    await expect(threadStore.getThread(threadId)).resolves.toMatchObject({
      id: threadId,
      sessionId,
      context: {
        agentKey: "panda",
        sessionId,
        cwd: resolveAgentDir("panda"),
      },
    });
    await expect(sessionStore.getHeartbeat(sessionId)).resolves.toMatchObject({
      sessionId,
      enabled: false,
    });
  }, SESSION_CREATE_TEST_TIMEOUT_MS);

  it("creates a readable branch session id from a normalized ref", async () => {
    vi.stubEnv("DATA_DIR", "/tmp/panda-session-create-readable");
    const {pool, sessionStore, threadStore} = await createHarness();
    pools.push(pool);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync([
      "session",
      "create",
      "PANDA",
      "Ops-Inbox",
      "--db-url",
      "postgres://session-create-test",
    ], {from: "user"});

    const output = collectWrites(write);
    const threadId = readOutputValue(output, "initialThread");
    expect(output).toContain("agent panda\n");
    expect(output).toContain("ref ops-inbox\n");
    expect(output).toContain("sessionId panda:ops-inbox\n");
    expect(output).toContain(
      "panda discord bind-channel --account <accountKey> --channel <discordChannelId> --session panda:ops-inbox",
    );

    await expect(sessionStore.getSession("panda:ops-inbox")).resolves.toMatchObject({
      id: "panda:ops-inbox",
      agentKey: "panda",
      kind: "branch",
      currentThreadId: threadId,
    });
    await expect(threadStore.getThread(threadId)).resolves.toMatchObject({
      id: threadId,
      sessionId: "panda:ops-inbox",
      context: {
        agentKey: "panda",
        sessionId: "panda:ops-inbox",
        cwd: resolveAgentDir("panda"),
      },
    });
  }, SESSION_CREATE_TEST_TIMEOUT_MS);

  it("rejects unsafe readable refs before opening the database", async () => {
    await expect(createProgram().parseAsync([
      "session",
      "create",
      "panda",
      "../ops",
      "--db-url",
      "postgres://session-create-test",
    ], {from: "user"})).rejects.toThrow("Session ref must use letters, numbers, hyphens, or underscores");

    expect(sessionCreateCliMocks.withPostgresPool).not.toHaveBeenCalled();
  }, SESSION_CREATE_TEST_TIMEOUT_MS);

  it("fails duplicate readable refs without partial creation", async () => {
    const {pool} = await createHarness();
    pools.push(pool);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync([
      "session",
      "create",
      "panda",
      "daily",
      "--db-url",
      "postgres://session-create-test",
    ], {from: "user"});
    const before = await rowCounts(pool);

    await expect(createProgram().parseAsync([
      "session",
      "create",
      "panda",
      "daily",
      "--db-url",
      "postgres://session-create-test",
    ], {from: "user"})).rejects.toThrow("Session panda:daily already exists. Pick a different session ref.");

    await expect(rowCounts(pool)).resolves.toEqual(before);
  }, SESSION_CREATE_TEST_TIMEOUT_MS);

  it("fails unknown agents without partial creation", async () => {
    const {pool} = await createHarness();
    pools.push(pool);
    const before = await rowCounts(pool);

    await expect(createProgram().parseAsync([
      "session",
      "create",
      "ghost",
      "daily",
      "--db-url",
      "postgres://session-create-test",
    ], {from: "user"})).rejects.toThrow("Unknown agent ghost");

    await expect(rowCounts(pool)).resolves.toEqual(before);
  }, SESSION_CREATE_TEST_TIMEOUT_MS);

  it("lets existing session commands inspect readable session ids", async () => {
    const {pool} = await createHarness();
    pools.push(pool);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync([
      "session",
      "create",
      "panda",
      "discord-room",
      "--db-url",
      "postgres://session-create-test",
    ], {from: "user"});
    write.mockClear();

    await createProgram().parseAsync([
      "session",
      "inspect",
      "panda:discord-room",
      "--db-url",
      "postgres://session-create-test",
    ], {from: "user"});

    const output = collectWrites(write);
    expect(output).toContain("Session panda:discord-room\n");
    expect(output).toContain("agent panda\n");
    expect(output).toContain("kind branch\n");
    expect(output).toContain("heartbeat enabled no\n");
  }, SESSION_CREATE_TEST_TIMEOUT_MS);
});
