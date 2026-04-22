import {afterEach, describe, expect, it, vi} from "vitest";
import type {AssistantMessage} from "@mariozechner/pi-ai";
import {DataType, newDb} from "pg-mem";

import {Agent, stringToUserMessage,} from "../src/index.js";
import {HeartbeatRunner} from "../src/domain/scheduling/heartbeats/runner.js";
import {type SessionHeartbeatRecord, type SessionStore} from "../src/domain/sessions/index.js";
import {ThreadRuntimeCoordinator,} from "../src/domain/threads/runtime/index.js";
import {createRuntimeStores} from "./helpers/runtime-store-setup.js";

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

  const rerollRuntime = createMockRuntime(
    createAssistantMessage(options.responseText ?? "Heartbeat handled."),
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
      runtime: rerollRuntime,
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
    runtime: rerollRuntime,
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
      content: expect.stringContaining("This is a periodic runtime wake."),
    });
    expect(harness.runtime.complete).toHaveBeenCalledTimes(2);

    const heartbeat = await harness.sessionStore.getHeartbeat("session-main");
    expect(heartbeat?.lastFireAt).toBeDefined();
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

  it("re-resolves the session after claim so a reset thread gets the heartbeat", async () => {
    const oldHeartbeat: SessionHeartbeatRecord = {
      sessionId: "session-main",
      enabled: true,
      everyMinutes: 30,
      nextFireAt: Date.now() - 1_000,
      createdAt: 1,
      updatedAt: 1,
    };

    let listed = false;
    const sessions: SessionStore = {
      ensureSchema: async () => {},
      createSession: async () => { throw new Error("not needed"); },
      getSession: vi.fn(async () => ({
        id: "session-main",
        agentKey: "panda",
        kind: "main",
        currentThreadId: "new-home",
        createdAt: 1,
        updatedAt: 2,
      })),
      getMainSession: async () => null,
      listAgentSessions: async () => [],
      updateCurrentThread: async () => { throw new Error("not needed"); },
      getHeartbeat: async () => oldHeartbeat,
      listDueHeartbeats: vi.fn(async () => {
        if (listed) {
          return [];
        }

        listed = true;
        return [oldHeartbeat];
      }),
      claimHeartbeat: vi.fn(async () => oldHeartbeat),
      recordHeartbeatResult: vi.fn(async () => oldHeartbeat),
      updateHeartbeatConfig: vi.fn(async () => oldHeartbeat),
    };
    const coordinator = {
      isThreadBusy: vi.fn(async (threadId: string) => {
        expect(threadId).toBe("new-home");
        return false;
      }),
      submitInput: vi.fn(async (threadId: string) => {
        expect(threadId).toBe("new-home");
      }),
    } as unknown as ThreadRuntimeCoordinator;

    const runner = new HeartbeatRunner({
      sessions,
      coordinator,
    });

    await runner.start();
    await runner.stop();

    expect(sessions.getSession).toHaveBeenCalledWith("session-main");
  });
});
