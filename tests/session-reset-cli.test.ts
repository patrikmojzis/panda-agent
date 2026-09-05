import {afterEach, describe, expect, it, vi} from "vitest";
import {Command} from "commander";
import {DataType, newDb} from "pg-mem";

import {createRuntimeStores} from "./helpers/runtime-store-setup.js";
import {registerSessionCommands} from "../src/app/sessions/cli.js";

const sessionResetCliMocks = vi.hoisted(() => {
  const state: {
    pool?: {
      connect(): Promise<unknown>;
      query(text: string, values?: readonly unknown[]): Promise<unknown>;
    };
    enqueued: unknown[];
    readRequest?: (id: string) => Promise<Record<string, unknown>>;
    readTimes: number[];
  } = {
    enqueued: [],
    readTimes: [],
  };

  class MockRuntimeRequestRepo {
    readonly ensureSchema = vi.fn(async () => {});
    readonly enqueueRequest = vi.fn(async (input: unknown) => {
      state.enqueued.push(input);
      return {id: "request-runtime"};
    });
    readonly getRequest = vi.fn(async (id: string) => {
      state.readTimes.push(Date.now());
      if (state.readRequest) return state.readRequest(id);
      const input = state.enqueued.at(-1) as {kind?: string} | undefined;
      return {
        id: "request-runtime",
        kind: input?.kind ?? "reset_session",
        status: "completed",
        payload: {},
        result: input?.kind === "compact_session"
          ? {
            compacted: true,
            sessionId: "canonical-session",
            threadId: "thread-current",
            tokensBefore: 1200,
            tokensAfter: 350,
          }
          : {
            threadId: "thread-new",
            previousThreadId: "thread-old",
          },
        createdAt: 1,
        updatedAt: 2,
      };
    });

    constructor(_options: unknown) {}
  }

  class MockDaemonStateRepo {
    readonly ensureSchema = vi.fn(async () => {});
    readonly readState = vi.fn(async () => ({
      daemonKey: "default",
      heartbeatAt: Date.now(),
      startedAt: Date.now(),
      updatedAt: Date.now(),
    }));

    constructor(_options: unknown) {}
  }

  return {
    state,
    MockRuntimeRequestRepo,
    MockDaemonStateRepo,
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

vi.mock("../src/lib/postgres-database.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/postgres-database.js")>();
  return {
    ...actual,
    withPostgresPool: sessionResetCliMocks.withPostgresPool,
  };
});

vi.mock("../src/domain/threads/requests/repo.js", () => ({
  RuntimeRequestRepo: sessionResetCliMocks.MockRuntimeRequestRepo,
}));

vi.mock("../src/app/runtime/state/repo.js", () => ({
  DaemonStateRepo: sessionResetCliMocks.MockDaemonStateRepo,
}));

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeErr: () => {},
  });
  registerSessionCommands(program);
  return program;
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
  sessionResetCliMocks.state.pool = pool;
  const stores = await createRuntimeStores(pool);
  return {
    pool,
    ...stores,
  };
}

describe("Session reset CLI", () => {
  const pools: Array<{end(): Promise<void>}> = [];

  afterEach(async () => {
    sessionResetCliMocks.state.pool = undefined;
    sessionResetCliMocks.state.enqueued = [];
    sessionResetCliMocks.state.readRequest = undefined;
    sessionResetCliMocks.state.readTimes = [];
    sessionResetCliMocks.withPostgresPool.mockClear();
    vi.useRealTimers();
    vi.restoreAllMocks();

    while (pools.length > 0) {
      await pools.pop()?.end();
    }
  });

  it("enqueues the canonical session id after resolving an alias", async () => {
    const {pool, sessionStore, threadStore} = await createHarness();
    pools.push(pool);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await sessionStore.createSession({
      id: "canonical-session",
      agentKey: "panda",
      kind: "branch",
      currentThreadId: "thread-current",
      alias: "ops-inbox",
    });
    await threadStore.createThread({
      id: "thread-current",
      sessionId: "canonical-session",
    });

    await createProgram().parseAsync([
      "session",
      "reset",
      "ops-inbox",
      "--agent",
      "panda",
      "--db-url",
      "postgres://session-reset-test",
    ], {from: "user"});

    expect(sessionResetCliMocks.state.enqueued).toEqual([
      {
        kind: "reset_session",
        payload: {
          source: "operator",
          sessionId: "canonical-session",
        },
      },
    ]);
  });

  it("compacts the canonical session with optional instructions and JSON output", async () => {
    const {pool, sessionStore, threadStore} = await createHarness();
    pools.push(pool);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await sessionStore.createSession({
      id: "canonical-session",
      agentKey: "panda",
      kind: "branch",
      currentThreadId: "thread-current",
      alias: "ops-inbox",
    });
    await threadStore.createThread({
      id: "thread-current",
      sessionId: "canonical-session",
    });

    await createProgram().parseAsync([
      "session",
      "compact",
      "ops-inbox",
      "--agent",
      "panda",
      "--instructions",
      "Keep the incident timeline.",
      "--json",
      "--db-url",
      "postgres://session-compact-test",
    ], {from: "user"});

    expect(sessionResetCliMocks.state.enqueued).toEqual([
      {
        kind: "compact_session",
        payload: {
          sessionId: "canonical-session",
          customInstructions: "Keep the incident timeline.",
        },
      },
    ]);
    expect(write).toHaveBeenCalledWith(
      `${JSON.stringify({
        compacted: true,
        sessionId: "canonical-session",
        threadId: "thread-current",
        tokensBefore: 1200,
        tokensAfter: 350,
      })}\n`,
    );
  });

  it("archives and restores the canonical branch session through the daemon", async () => {
    const {pool, sessionStore, threadStore} = await createHarness();
    pools.push(pool);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await sessionStore.createSession({
      id: "canonical-session",
      agentKey: "panda",
      kind: "branch",
      currentThreadId: "thread-current",
      alias: "ops-inbox",
    });
    await threadStore.createThread({
      id: "thread-current",
      sessionId: "canonical-session",
    });

    for (const lifecycle of ["archive", "restore"] as const) {
      await createProgram().parseAsync([
        "session",
        lifecycle,
        "ops-inbox",
        "--agent",
        "panda",
        "--db-url",
        "postgres://session-lifecycle-test",
      ], {from: "user"});
    }

    expect(sessionResetCliMocks.state.enqueued).toEqual([
      {kind: "archive_session", payload: {sessionId: "canonical-session"}},
      {kind: "restore_session", payload: {sessionId: "canonical-session"}},
    ]);
  });

  it.each(["reset", "compact", "archive", "restore"])("uses the enqueued request ID for an unlabelled %s failure", async (command) => {
    const {pool, sessionStore} = await createHarness();
    pools.push(pool);
    await sessionStore.createSession({
      id: "canonical-session", agentKey: "panda", kind: "branch", currentThreadId: "thread-current",
    });
    sessionResetCliMocks.state.readRequest = async () => ({id: "different-returned-id", status: "failed"});

    await expect(createProgram().parseAsync(["session", command, "canonical-session"], {from: "user"}))
      .rejects.toThrow("Runtime request request-runtime failed.");
    expect(sessionResetCliMocks.state.enqueued).toHaveLength(1);
  });

  it.each([
    {command: "reset", timeoutMs: 30_000, completes: true},
    {command: "reset", timeoutMs: 30_000, completes: false},
    {command: "compact", timeoutMs: 15 * 60_000, completes: true},
    {command: "compact", timeoutMs: 15 * 60_000, completes: false},
  ])("waits through the inclusive $command deadline (completes=$completes)", async ({command, timeoutMs, completes}) => {
    const {pool, sessionStore} = await createHarness();
    pools.push(pool);
    await sessionStore.createSession({
      id: "canonical-session", agentKey: "panda", kind: "branch", currentThreadId: "thread-current",
    });
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.useFakeTimers();
    vi.setSystemTime(0);
    sessionResetCliMocks.state.readRequest = async () => ({
      id: "different-returned-id",
      status: completes && Date.now() === timeoutMs ? "completed" : Date.now() ? "running" : "pending",
      result: null,
    });
    const result = createProgram().parseAsync(["session", command, "canonical-session"], {from: "user"});
    const assertion = completes
      ? expect(result).resolves.toBeInstanceOf(Command)
      : expect(result).rejects.toThrow("Timed out waiting for runtime request request-runtime.");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(99);
    expect(sessionResetCliMocks.state.readTimes).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sessionResetCliMocks.state.readTimes).toEqual([0, 100]);
    vi.setSystemTime(timeoutMs - 100);
    await vi.advanceTimersByTimeAsync(100);
    expect(sessionResetCliMocks.state.readTimes).toEqual([0, 100, timeoutMs]);
    if (!completes) await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(sessionResetCliMocks.state.enqueued).toHaveLength(1);
    expect(sessionResetCliMocks.state.readTimes).toEqual([0, 100, timeoutMs]);
    if (completes) {
      expect(write).toHaveBeenCalledWith(command === "reset"
        ? "Reset session canonical-session.\nnew thread -\nprevious thread -\n"
        : "Session canonical-session has no older context to compact.\nthread thread-current\n");
    } else {
      expect(write).not.toHaveBeenCalled();
    }
  });
});
