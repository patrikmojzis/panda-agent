import {afterEach, describe, expect, it, vi} from "vitest";
import type {AssistantMessage} from "@earendil-works/pi-ai";
import {DataType, newDb} from "pg-mem";

import {Agent, stringToUserMessage,} from "../src/index.js";
import {HeartbeatRunner, type HeartbeatRunnerOptions} from "../src/domain/scheduling/heartbeats/runner.js";
import {type SessionHeartbeatRecord, type SessionRecord} from "../src/domain/sessions/index.js";
import {ThreadRuntimeCoordinator,} from "../src/domain/threads/runtime/index.js";
import {createRuntimeStores} from "./helpers/runtime-store-setup.js";
import {waitFor} from "./helpers/wait-for.js";

function createAssistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{type: "text", text}],
    api: "openai-responses",
    model: "openai/gpt-5.1",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0},
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function createMockRuntime(...responses: AssistantMessage[]) {
  return {
    complete: vi.fn().mockImplementation(async () => {
      const response = responses.shift();
      if (!response) {
        throw new Error("No more runtime responses queued.");
      }

      return response;
    }),
    stream: vi.fn(() => {
      throw new Error("Streaming was not expected in this test.");
    }),
  };
}

class SelectiveLeaseManager {
  async tryAcquire(threadId: string) {
    return {
      threadId,
      release: async () => {},
    };
  }
}

function createDueHeartbeatSessionStore(input: {
  heartbeat: SessionHeartbeatRecord;
  session: SessionRecord;
}): {
  getSession: ReturnType<typeof vi.fn>;
  store: HeartbeatRunnerOptions["sessions"];
} {
  let listed = false;
  const getSession = vi.fn(async () => input.session);
  const store: HeartbeatRunnerOptions["sessions"] = {
    getSession,
    listDueHeartbeats: vi.fn(async () => {
      if (listed) {
        return [];
      }

      listed = true;
      return [input.heartbeat];
    }),
    claimHeartbeat: vi.fn(async () => input.heartbeat),
    recordHeartbeatResult: vi.fn(async () => input.heartbeat),
  };

  return {getSession, store};
}

async function createHarness(options: {
  responseText?: string;
  heartbeatInstructions?: string | null;
} = {}) {
  const db = newDb();
  db.public.registerFunction({
    name: "pg_notify",
    args: [DataType.text, DataType.text],
    returns: DataType.text,
    implementation: () => "",
  });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();

  const {identityStore, sessionStore, threadStore} = await createRuntimeStores(pool);

  const alice = await identityStore.createIdentity({
    id: "alice-id",
    handle: "alice",
    displayName: "Alice",
  });
  await sessionStore.createSession({
    id: "session-main",
    agentKey: "panda",
    kind: "main",
    currentThreadId: "session-thread",
    createdByIdentityId: alice.id,
  });
  await threadStore.createThread({
    id: "session-thread",
    sessionId: "session-main",
  });

  const runtime = createMockRuntime(
    createAssistantMessage(options.responseText ?? "Heartbeat handled."),
  );
  const coordinator = new ThreadRuntimeCoordinator({
    store: threadStore,
    leaseManager: new SelectiveLeaseManager(),
    resolveDefinition: async () => ({
      agent: new Agent({
        name: "panda",
        instructions: "Reply briefly.",
      }),
      runtime,
    }),
  });

  const runner = new HeartbeatRunner({
    sessions: sessionStore,
    coordinator,
    resolveInstructions: async () => options.heartbeatInstructions ?? null,
  });

  return {
    alice,
    pool,
    threadStore,
    sessionStore,
    coordinator,
    runner,
    runtime,
  };
}

describe("HeartbeatRunner", () => {
  const pools: Array<{end(): Promise<void>}> = [];

  afterEach(async () => {
    while (pools.length > 0) {
      const pool = pools.pop();
      if (!pool) {
        continue;
      }

      await pool.end();
    }
  });

  it("fires due heartbeats into the current session thread", async () => {
    const harness = await createHarness({
      heartbeatInstructions: "Always check unfinished promises before going quiet.",
    });
    pools.push(harness.pool);

    await harness.pool.query(
      `UPDATE "runtime"."session_heartbeats" SET next_fire_at = $2 WHERE session_id = $1`,
      ["session-main", new Date(Date.now() - 1_000)],
    );

    await harness.runner.start();
    await waitFor(async () => {
      const heartbeat = await harness.sessionStore.getHeartbeat("session-main");
      expect(heartbeat?.lastFireAt).toEqual(expect.any(Number));
    });
    await harness.coordinator.waitForIdle("session-thread");
    await harness.runner.stop();

    const transcript = await harness.threadStore.loadTranscript("session-thread");
    const heartbeatInput = transcript.find((entry) => entry.origin === "input" && entry.source === "heartbeat");
    expect(heartbeatInput?.identityId).toBe(harness.alice.id);
    expect(heartbeatInput?.metadata).toMatchObject({
      heartbeat: {
        kind: "interval",
        sessionId: "session-main",
      },
    });
    expect(heartbeatInput?.message).toMatchObject({
      role: "user",
      content: expect.stringContaining("Always check unfinished promises before going quiet."),
    });
    expect(heartbeatInput?.message).toMatchObject({
      role: "user",
      content: expect.stringContaining("This is a periodic system heartbeat wake."),
    });
    expect(harness.runtime.complete).toHaveBeenCalledTimes(1);

    const heartbeat = await harness.sessionStore.getHeartbeat("session-main");
    expect(heartbeat?.lastFireAt).toEqual(expect.any(Number));
    expect(heartbeat?.lastSkipReason).toBeUndefined();
    expect(heartbeat?.nextFireAt).toBeGreaterThan(Date.now());
  });

  it("skips busy session threads instead of queueing stale heartbeats", async () => {
    const harness = await createHarness();
    pools.push(harness.pool);

    await harness.coordinator.submitInput("session-thread", {
      message: stringToUserMessage("queued work"),
      source: "tui",
    }, "queue");
    await harness.pool.query(
      `UPDATE "runtime"."session_heartbeats" SET next_fire_at = $2 WHERE session_id = $1`,
      ["session-main", new Date(Date.now() - 1_000)],
    );

    await harness.runner.start();
    await waitFor(async () => {
      const heartbeat = await harness.sessionStore.getHeartbeat("session-main");
      expect(heartbeat?.lastSkipReason).toBe("busy");
    });
    await harness.runner.stop();

    const heartbeatInputs = await harness.pool.query(
      `SELECT id FROM "runtime"."inputs" WHERE thread_id = $1 AND source = 'heartbeat'`,
      ["session-thread"],
    );
    expect(heartbeatInputs.rows).toHaveLength(0);
    expect(harness.runtime.complete).not.toHaveBeenCalled();

    const heartbeat = await harness.sessionStore.getHeartbeat("session-main");
    expect(heartbeat?.lastFireAt).toBeUndefined();
    expect(heartbeat?.lastSkipReason).toBe("busy");
    expect(heartbeat?.nextFireAt).toBeGreaterThan(Date.now());
  });

  it("records a skipped heartbeat when the session has no current thread", async () => {
    const heartbeat: SessionHeartbeatRecord = {
      sessionId: "session-main",
      enabled: true,
      everyMinutes: 30,
      nextFireAt: Date.now() - 1_000,
      createdAt: 1,
      updatedAt: 1,
    };
    const session: SessionRecord = {
      id: "session-main",
      agentKey: "panda",
      kind: "main",
      currentThreadId: " ",
      createdAt: 1,
      updatedAt: 1,
    };
    const {store: sessions} = createDueHeartbeatSessionStore({heartbeat, session});
    const coordinator = {
      isThreadBusy: vi.fn(async () => false),
      submitInput: vi.fn(async () => {}),
    };
    const onError = vi.fn();
    const runner = new HeartbeatRunner({
      sessions,
      coordinator,
      onError,
    });

    await runner.start();
    await waitFor(() => {
      expect(sessions.recordHeartbeatResult).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: "session-main",
        claimedBy: "heartbeat-runner",
        lastSkipReason: "Session session-main has no current thread.",
      }));
    });
    await runner.stop();

    expect(coordinator.isThreadBusy).not.toHaveBeenCalled();
    expect(coordinator.submitInput).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), "session-main");
  });

  it("submits heartbeat input to the current thread after the busy check", async () => {
    const heartbeat: SessionHeartbeatRecord = {
      sessionId: "session-main",
      enabled: true,
      everyMinutes: 30,
      nextFireAt: Date.now() - 1_000,
      createdAt: 1,
      updatedAt: 1,
    };
    const session: SessionRecord = {
      id: "session-main",
      agentKey: "panda",
      kind: "main" as const,
      currentThreadId: "old-home",
      createdAt: 1,
      updatedAt: 1,
    };
    const {store: sessions} = createDueHeartbeatSessionStore({heartbeat, session});
    const submitInput = vi.fn(async (threadId: string) => {
      expect(threadId).toBe("new-home");
    });
    const busyChecks: string[] = [];
    const coordinator = {
      isThreadBusy: vi.fn(async (threadId: string) => {
        busyChecks.push(threadId);
        if (threadId === "old-home") {
          session.currentThreadId = "new-home";
        }
        return false;
      }),
      submitInput,
    };

    const runner = new HeartbeatRunner({
      sessions,
      coordinator,
    });

    await runner.start();
    await waitFor(() => {
      expect(submitInput).toHaveBeenCalled();
    });
    await runner.stop();

    expect(busyChecks).toEqual(["old-home", "new-home"]);
  });

  it("skips when the reset target becomes busy before heartbeat submit", async () => {
    const heartbeat: SessionHeartbeatRecord = {
      sessionId: "session-main",
      enabled: true,
      everyMinutes: 30,
      nextFireAt: Date.now() - 1_000,
      createdAt: 1,
      updatedAt: 1,
    };
    const session: SessionRecord = {
      id: "session-main",
      agentKey: "panda",
      kind: "main" as const,
      currentThreadId: "old-home",
      createdAt: 1,
      updatedAt: 1,
    };
    const {store: sessions} = createDueHeartbeatSessionStore({heartbeat, session});
    const submitInput = vi.fn(async () => {});
    const coordinator = {
      isThreadBusy: vi.fn(async (threadId: string) => {
        if (threadId === "old-home") {
          session.currentThreadId = "new-home";
          return false;
        }
        if (threadId === "new-home") {
          return true;
        }
        throw new Error(`Unexpected heartbeat target ${threadId}`);
      }),
      submitInput,
    };

    const runner = new HeartbeatRunner({
      sessions,
      coordinator,
    });

    await runner.start();
    await waitFor(() => {
      expect(sessions.recordHeartbeatResult).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: "session-main",
        claimedBy: "heartbeat-runner",
        lastSkipReason: "busy",
      }));
    });
    await runner.stop();

    expect(coordinator.isThreadBusy).toHaveBeenNthCalledWith(1, "old-home");
    expect(coordinator.isThreadBusy).toHaveBeenNthCalledWith(2, "new-home");
    expect(submitInput).not.toHaveBeenCalled();
  });

  it("re-resolves the session after claim so a reset thread gets the heartbeat", async () => {
    const oldHeartbeat: SessionHeartbeatRecord = {
      sessionId: "session-main",
      enabled: true,
      everyMinutes: 30,
      nextFireAt: Date.now() - 1_000,
      createdAt: 1,
      updatedAt: 1,
    };

    const {getSession, store: sessions} = createDueHeartbeatSessionStore({
      heartbeat: oldHeartbeat,
      session: {
        id: "session-main",
        agentKey: "panda",
        kind: "main",
        currentThreadId: "new-home",
        createdAt: 1,
        updatedAt: 2,
      },
    });
    const coordinator = {
      isThreadBusy: vi.fn(async (threadId: string) => {
        expect(threadId).toBe("new-home");
        return false;
      }),
      submitInput: vi.fn(async (threadId: string) => {
        expect(threadId).toBe("new-home");
      }),
    };

    const runner = new HeartbeatRunner({
      sessions,
      coordinator,
    });

    await runner.start();
    await waitFor(() => {
      expect(getSession).toHaveBeenCalledWith("session-main");
    });
    await runner.stop();

    expect(getSession).toHaveBeenCalledWith("session-main");
  });
});
