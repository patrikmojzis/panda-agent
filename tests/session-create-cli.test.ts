import {afterEach, describe, expect, it, vi} from "vitest";
import {Command} from "commander";
import {DataType, newDb} from "pg-mem";

import {createRuntimeStores} from "./helpers/runtime-store-setup.js";
import {ConversationRepo} from "../src/domain/sessions/conversations/repo.js";
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


  it("creates labels and resolves aliases for inspect heartbeat and conversation bind", async () => {
    vi.stubEnv("DATA_DIR", "/tmp/panda-session-create-alias");
    const {pool, sessionStore} = await createHarness();
    pools.push(pool);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync([
      "session",
      "create",
      "panda",
      "--alias",
      "Ops-Inbox",
      "--display-name",
      "Ops Inbox",
      "--db-url",
      "postgres://session-create-test",
    ], {from: "user"});

    const createOutput = collectWrites(write);
    const sessionId = readOutputValue(createOutput, "sessionId");
    const threadId = readOutputValue(createOutput, "initialThread");
    expect(createOutput).toContain("alias ops-inbox\n");
    expect(createOutput).toContain("displayName Ops Inbox\n");
    await expect(sessionStore.getSession(sessionId)).resolves.toMatchObject({
      id: sessionId,
      alias: "ops-inbox",
      displayName: "Ops Inbox",
      currentThreadId: threadId,
    });

    write.mockClear();
    await createProgram().parseAsync([
      "session",
      "inspect",
      "OPS-INBOX",
      "--agent",
      "panda",
      "--db-url",
      "postgres://session-create-test",
    ], {from: "user"});
    const inspectOutput = collectWrites(write);
    expect(inspectOutput).toContain(`Session ${sessionId}\n`);
    expect(inspectOutput).toContain("alias ops-inbox\n");
    expect(inspectOutput).toContain("displayName Ops Inbox\n");

    write.mockClear();
    await createProgram().parseAsync([
      "session",
      "inspect",
      "panda:ops-inbox",
      "--db-url",
      "postgres://session-create-test",
    ], {from: "user"});
    expect(collectWrites(write)).toContain(`Session ${sessionId}\n`);

    write.mockClear();
    await createProgram().parseAsync([
      "session",
      "heartbeat",
      "ops-inbox",
      "--agent",
      "panda",
      "--enable",
      "--every",
      "15",
      "--db-url",
      "postgres://session-create-test",
    ], {from: "user"});
    const heartbeatOutput = collectWrites(write);
    expect(heartbeatOutput).toContain(`Updated heartbeat for ${sessionId}.\n`);
    await expect(sessionStore.getHeartbeat(sessionId)).resolves.toMatchObject({
      sessionId,
      enabled: true,
      everyMinutes: 15,
    });

    write.mockClear();
    await createProgram().parseAsync([
      "session",
      "bind-conversation",
      "ops-inbox",
      "telegram",
      "main",
      "chat-1",
      "--agent",
      "panda",
      "--db-url",
      "postgres://session-create-test",
    ], {from: "user"});
    const bindOutput = collectWrites(write);
    expect(bindOutput).toContain(`Bound conversation to session ${sessionId}.\n`);
    const conversations = new ConversationRepo({pool});
    await expect(conversations.getConversationBinding({
      source: "telegram",
      connectorKey: "main",
      externalConversationId: "chat-1",
    })).resolves.toMatchObject({
      sessionId,
    });
  }, SESSION_CREATE_TEST_TIMEOUT_MS);

  it("updates and clears aliases with the label command", async () => {
    const {pool, sessionStore} = await createHarness();
    pools.push(pool);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync([
      "session",
      "create",
      "panda",
      "--db-url",
      "postgres://session-create-test",
    ], {from: "user"});
    const sessionId = readOutputValue(collectWrites(write), "sessionId");

    write.mockClear();
    await createProgram().parseAsync([
      "session",
      "label",
      sessionId,
      "--alias",
      "Room-One",
      "--display-name",
      "Room One",
      "--db-url",
      "postgres://session-create-test",
    ], {from: "user"});
    expect(collectWrites(write)).toContain("alias room-one\n");
    await expect(sessionStore.resolveSessionRef({
      sessionRef: "room-one",
      agentKey: "panda",
    })).resolves.toMatchObject({
      id: sessionId,
      displayName: "Room One",
    });

    write.mockClear();
    await createProgram().parseAsync([
      "session",
      "label",
      "room-one",
      "--agent",
      "panda",
      "--clear-alias",
      "--clear-display-name",
      "--db-url",
      "postgres://session-create-test",
    ], {from: "user"});
    expect(collectWrites(write)).toContain("alias -\n");
    await expect(sessionStore.getSession(sessionId)).resolves.toMatchObject({
      id: sessionId,
      alias: undefined,
      displayName: undefined,
    });
  }, SESSION_CREATE_TEST_TIMEOUT_MS);

  it("keeps alias resolution exact-id-first and enforces agent scope", async () => {
    const {pool, agentStore, sessionStore} = await createHarness();
    pools.push(pool);

    await sessionStore.createSession({
      id: "session-a",
      agentKey: "panda",
      kind: "branch",
      currentThreadId: "thread-a",
    });
    await sessionStore.createSession({
      id: "session-b",
      agentKey: "panda",
      kind: "branch",
      currentThreadId: "thread-b",
      alias: "session-a",
    });
    await agentStore.bootstrapAgent({agentKey: "other", displayName: "Other"});
    await sessionStore.createSession({
      id: "session-other",
      agentKey: "other",
      kind: "branch",
      currentThreadId: "thread-other",
    });

    await expect(sessionStore.resolveSessionRef({
      sessionRef: "session-a",
      agentKey: "panda",
    })).resolves.toMatchObject({
      id: "session-a",
    });
    await expect(sessionStore.resolveSessionRef({
      sessionRef: "panda:session-a",
    })).resolves.toMatchObject({
      id: "session-b",
    });
    await expect(sessionStore.resolveSessionRef({
      sessionRef: "session-other",
      agentKey: "panda",
    })).rejects.toThrow("Session session-other belongs to agent other, not panda.");
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



  it("rejects aliases that collide with legacy readable canonical ids", async () => {
    const {pool} = await createHarness();
    pools.push(pool);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync([
      "session",
      "create",
      "panda",
      "ops-inbox",
      "--db-url",
      "postgres://session-create-test",
    ], {from: "user"});
    write.mockClear();
    await createProgram().parseAsync([
      "session",
      "create",
      "panda",
      "--db-url",
      "postgres://session-create-test",
    ], {from: "user"});
    const generatedSessionId = readOutputValue(collectWrites(write), "sessionId");
    const before = await rowCounts(pool);

    await expect(createProgram().parseAsync([
      "session",
      "create",
      "panda",
      "--alias",
      "ops-inbox",
      "--db-url",
      "postgres://session-create-test",
    ], {from: "user"})).rejects.toThrow(
      "Session alias ops-inbox collides with canonical session panda:ops-inbox. Pick a different alias.",
    );
    await expect(createProgram().parseAsync([
      "session",
      "label",
      generatedSessionId,
      "--alias",
      "ops-inbox",
      "--db-url",
      "postgres://session-create-test",
    ], {from: "user"})).rejects.toThrow(
      "Session alias ops-inbox collides with canonical session panda:ops-inbox. Pick a different alias.",
    );

    await expect(rowCounts(pool)).resolves.toEqual(before);
  }, SESSION_CREATE_TEST_TIMEOUT_MS);

  it("rejects duplicate aliases scoped to an agent without partial creation", async () => {
    const {pool} = await createHarness();
    pools.push(pool);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync([
      "session",
      "create",
      "panda",
      "--alias",
      "daily",
      "--db-url",
      "postgres://session-create-test",
    ], {from: "user"});
    const before = await rowCounts(pool);

    await expect(createProgram().parseAsync([
      "session",
      "create",
      "panda",
      "--alias",
      "DAILY",
      "--db-url",
      "postgres://session-create-test",
    ], {from: "user"})).rejects.toThrow("Session alias daily already exists for agent panda. Pick a different alias.");

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
