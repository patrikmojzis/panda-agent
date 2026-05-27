import {describe, expect, it, vi} from "vitest";

const runtimeClientMocks = vi.hoisted(() => {
  const pool = {
    end: vi.fn(async () => undefined),
  };
  const state: {
    enqueued: unknown[];
    requestResult: Record<string, unknown>;
    threadId: string;
  } = {
    enqueued: [],
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
    readonly getRequest = vi.fn(async () => ({
      id: "request-subagent",
      kind: "create_subagent_session",
      status: "completed",
      payload: {},
      result: state.requestResult,
      createdAt: 1,
      updatedAt: 1,
    }));

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
    MockAgentStore,
    MockDaemonStateRepo,
    MockIdentityStore,
    MockRuntimeRequestRepo,
    MockSessionStore,
    MockThreadStore,
    createPostgresPool: vi.fn(() => pool),
    ensureSchemas: vi.fn(async () => undefined),
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

vi.mock("../src/app/runtime/postgres-bootstrap.js", () => ({
  ensureSchemas: runtimeClientMocks.ensureSchemas,
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
      toolGroups: ["core", "workspace_read"],
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
          toolGroups: ["core", "workspace_read"],
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
});
