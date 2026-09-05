import {afterEach, describe, expect, it, vi} from "vitest";

const runtimeClientMocks = vi.hoisted(() => {
  const pool = {
    end: vi.fn(async () => undefined),
  };
  const state: {
    enqueued: unknown[];
    requestResult: unknown;
    readRequest?: (id: string) => Promise<Record<string, unknown>>;
    readTimes: number[];
    threadId: string;
  } = {
    enqueued: [],
    readTimes: [],
    requestResult: {
      threadId: "subagent-thread",
      sessionId: "subagent-session",
      profile: "workspace",
      execution: "isolated_environment",
      environmentId: "env-subagent",
      environment: {
        id: "env-subagent",
        runnerCwd: "/workspace",
        rootPath: "/workspace",
        metadata: {filesystem: {envDir: "env-subagent"}},
      },
    },
    threadId: "subagent-thread",
  };

  class MockIdentityStore {
    readonly getIdentityByHandle = vi.fn(async (handle: string) => ({
      id: "identity-1",
      handle,
      displayName: "Patrik",
      status: "active",
      createdAt: 1,
      updatedAt: 1,
    }));

    constructor(_options: unknown) {}
  }

  class MockAgentStore {
    readonly listIdentityPairings = vi.fn(async () => [{
      identityId: "identity-1",
      agentKey: "panda",
      createdAt: 1,
      updatedAt: 1,
    }]);

    constructor(_options: unknown) {}
  }

  class MockSessionStore {
    readonly getSession = vi.fn();
    readonly listAgentSessions = vi.fn(async () => []);
    readonly resolveSessionRef = vi.fn();

    constructor(_options: unknown) {}
  }

  class MockThreadStore {
    readonly getThread = vi.fn(async (threadId: string) => ({
      id: threadId,
      sessionId: "subagent-session",
      createdAt: 1,
      updatedAt: 1,
    }));
    readonly listRuns = vi.fn(async () => []);

    constructor(_options: unknown) {}
  }

  class MockRuntimeRequestRepo {
    readonly enqueueRequest = vi.fn(async (input: unknown) => {
      state.enqueued.push(input);
      return {
        id: "request-subagent",
        kind: "create_subagent_session",
        status: "pending",
        payload: {},
        createdAt: 1,
        updatedAt: 1,
      };
    });
    readonly getRequest = vi.fn(async (id: string) => {
      state.readTimes.push(Date.now());
      if (state.readRequest) return state.readRequest(id);
      return {
        id: "request-subagent",
        kind: "create_subagent_session",
        status: "completed",
        payload: {},
        result: state.requestResult,
        createdAt: 1,
        updatedAt: 1,
      };
    });

    constructor(_options: unknown) {}
  }

  class MockDaemonStateRepo {
    readonly readState = vi.fn(async () => ({
      daemonKey: "default",
      heartbeatAt: Date.now(),
      startedAt: Date.now(),
      updatedAt: Date.now(),
    }));

    constructor(_options: unknown) {}
  }

  return {
    pool,
    state,
    defaultResult: state.requestResult,
    MockAgentStore,
    MockDaemonStateRepo,
    MockIdentityStore,
    MockRuntimeRequestRepo,
    MockSessionStore,
    MockThreadStore,
    createPostgresPool: vi.fn(() => pool),
    assertSchemaCurrent: vi.fn(async () => undefined),
  };
});

vi.mock("../src/app/runtime/create-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/app/runtime/create-runtime.js")>();
  return {
    ...actual,
    createPostgresPool: runtimeClientMocks.createPostgresPool,
    requireDatabaseUrl: vi.fn((dbUrl?: string) => dbUrl ?? "postgres://runtime-client-test"),
  };
});

vi.mock("../src/integrations/postgres/schema-version.js", () => ({
  createPandaSchemaVerifier: () => ({assertCurrent: runtimeClientMocks.assertSchemaCurrent}),
}));

vi.mock("../src/domain/identity/postgres.js", () => ({
  PostgresIdentityStore: runtimeClientMocks.MockIdentityStore,
}));

vi.mock("../src/domain/agents/postgres.js", () => ({
  PostgresAgentStore: runtimeClientMocks.MockAgentStore,
}));

vi.mock("../src/domain/sessions/postgres.js", () => ({
  PostgresSessionStore: runtimeClientMocks.MockSessionStore,
}));

vi.mock("../src/domain/threads/runtime/postgres.js", () => ({
  PostgresThreadRuntimeStore: runtimeClientMocks.MockThreadStore,
}));

vi.mock("../src/domain/threads/requests/repo.js", () => ({
  RuntimeRequestRepo: runtimeClientMocks.MockRuntimeRequestRepo,
}));

vi.mock("../src/app/runtime/state/repo.js", () => ({
  DaemonStateRepo: runtimeClientMocks.MockDaemonStateRepo,
}));

import {createRuntimeClient} from "../src/app/runtime/client.js";

describe("RuntimeClient", () => {
  afterEach(() => {
    runtimeClientMocks.state.enqueued = [];
    runtimeClientMocks.state.readTimes = [];
    runtimeClientMocks.state.readRequest = undefined;
    runtimeClientMocks.state.requestResult = runtimeClientMocks.defaultResult;
    runtimeClientMocks.pool.end.mockClear();
    vi.useRealTimers();
  });

  it("enqueues V2 subagent session requests and exposes no legacy worker creator", async () => {
    const client = await createRuntimeClient({
      identity: "Patrik",
      dbUrl: "postgres://runtime-client-test",
    });

    expect(client).not.toHaveProperty("createWorkerSession");
    expect("createWorkerSession" in client).toBe(false);

    const result = await client.createSubagentSession({
      sessionId: "subagent-session",
      threadId: "subagent-thread",
      agentKey: " panda ",
      parentSessionId: "parent-session",
      prompt: "Inspect the repository.",
      context: " Focus on runtime client. ",
      profile: " workspace ",
      execution: "isolated_environment",
      environmentId: " env-subagent ",
      credentialAllowlist: ["API_KEY"],
      toolGroups: ["core"],
      model: "openai/gpt-5.1",
      thinking: "high",
      inferenceProjection: {mode: "compact"},
    });

    expect(runtimeClientMocks.state.enqueued).toEqual([
      {
        kind: "create_subagent_session",
        payload: {
          identityId: "identity-1",
          sessionId: "subagent-session",
          threadId: "subagent-thread",
          agentKey: "panda",
          parentSessionId: "parent-session",
          prompt: "Inspect the repository.",
          context: "Focus on runtime client.",
          profile: "workspace",
          execution: "isolated_environment",
          environmentId: "env-subagent",
          credentialAllowlist: ["API_KEY"],
          toolGroups: ["core"],
          model: "openai/gpt-5.1",
          thinking: "high",
          inferenceProjection: {mode: "compact"},
        },
      },
    ]);
    expect(result).toMatchObject({
      sessionId: "subagent-session",
      threadId: "subagent-thread",
      profile: "workspace",
      execution: "isolated_environment",
      environmentId: "env-subagent",
      thread: {
        id: "subagent-thread",
        sessionId: "subagent-session",
      },
      environment: {
        id: "env-subagent",
        runnerCwd: "/workspace",
        rootPath: "/workspace",
      },
    });

    await client.close();
    expect(runtimeClientMocks.pool.end).toHaveBeenCalledOnce();
  });

  it.each([
    {error: "Daemon refused the request.", message: "Daemon refused the request."},
    {error: undefined, message: "Runtime request returned-request-id failed."},
    {error: "", message: ""},
  ])("returns the persisted failure message ($message)", async ({error, message}) => {
    runtimeClientMocks.state.readRequest = async () => ({id: "returned-request-id", status: "failed", error});
    const client = await createRuntimeClient({identity: "Patrik"});
    try {
      await expect(client.abortThread("thread-current")).rejects.toMatchObject({message});
      expect(runtimeClientMocks.state.enqueued).toHaveLength(1);
    } finally {
      await client.close();
    }
  });

  it.each([undefined, null, false, 0, ""])("preserves the nullish result fallback for %s", async (result) => {
    runtimeClientMocks.state.requestResult = result;
    const client = await createRuntimeClient({identity: "Patrik"});
    try {
      await expect(client.submitTextInput({text: "hello", actorId: "operator", externalMessageId: "input-1"}))
        .resolves.toEqual(result ?? {});
    } finally {
      await client.close();
    }
  });

  it("propagates request read errors without retrying or replacing them", async () => {
    const failure = new Error("Request store unavailable.");
    runtimeClientMocks.state.readRequest = async () => { throw failure; };
    const client = await createRuntimeClient({identity: "Patrik"});
    try {
      await expect(client.abortThread("thread-current")).rejects.toBe(failure);
      expect(runtimeClientMocks.state.readTimes).toHaveLength(1);
      expect(runtimeClientMocks.state.enqueued).toHaveLength(1);
    } finally {
      await client.close();
    }
  });

  it.each([
    {operation: "abort", timeoutMs: 30_000, completes: true},
    {operation: "abort", timeoutMs: 30_000, completes: false},
    {operation: "compact", timeoutMs: 15 * 60_000, completes: true},
    {operation: "compact", timeoutMs: 15 * 60_000, completes: false},
  ])("waits through the inclusive $operation deadline (completes=$completes)", async ({operation, timeoutMs, completes}) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    runtimeClientMocks.state.readRequest = async () => ({
      id: "returned-request-id",
      status: completes && Date.now() === timeoutMs ? "completed" : Date.now() ? "running" : "pending",
      result: {aborted: true, compacted: true},
    });
    const client = await createRuntimeClient({identity: "Patrik"});
    try {
      const result = operation === "abort"
        ? client.abortThread("thread-current")
        : client.compactThread("thread-current", "Preserve decisions.");
      const assertion = completes
        ? expect(result).resolves.toEqual(operation === "abort" ? true : {aborted: true, compacted: true})
        : expect(result).rejects.toThrow("Timed out waiting for runtime request request-subagent.");
      let settled = false;
      void result.then(() => { settled = true; }, () => { settled = true; });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(99);
      expect(runtimeClientMocks.state.readTimes).toEqual([0]);
      await vi.advanceTimersByTimeAsync(1);
      expect(runtimeClientMocks.state.readTimes).toEqual([0, 100]);
      vi.setSystemTime(timeoutMs - 100);
      await vi.advanceTimersByTimeAsync(100);
      expect(runtimeClientMocks.state.readTimes).toEqual([0, 100, timeoutMs]);
      expect(settled).toBe(completes);
      if (!completes) await vi.advanceTimersByTimeAsync(100);
      await assertion;
      expect(runtimeClientMocks.state.enqueued).toHaveLength(1);
      expect(runtimeClientMocks.state.readTimes).toEqual([0, 100, timeoutMs]);
    } finally {
      await client.close();
    }
  });
});
