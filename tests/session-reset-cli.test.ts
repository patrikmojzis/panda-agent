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
  } = {
    enqueued: [],
  };

  class MockRuntimeRequestRepo {
    readonly ensureSchema = vi.fn(async () => {});
    readonly enqueueRequest = vi.fn(async (input: unknown) => {
      state.enqueued.push(input);
      return {id: "request-reset"};
    });
    readonly getRequest = vi.fn(async () => ({
      id: "request-reset",
      kind: "reset_session",
      status: "completed",
      payload: {},
      result: {
        threadId: "thread-new",
        previousThreadId: "thread-old",
      },
      createdAt: 1,
      updatedAt: 2,
    }));

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

vi.mock("../src/lib/postgres-bootstrap.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/postgres-bootstrap.js")>();
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
    sessionResetCliMocks.withPostgresPool.mockClear();
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
});
