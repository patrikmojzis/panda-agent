import {afterEach, describe, expect, it, vi} from "vitest";
import type {AssistantMessage} from "@mariozechner/pi-ai";
import {DataType, newDb} from "pg-mem";

import {
    Agent,
    HeartbeatRunner,
    PostgresHomeThreadStore,
    PostgresThreadRuntimeStore,
    stringToUserMessage,
    ThreadRuntimeCoordinator,
} from "../src/index.js";
import type {HomeThreadRecord, HomeThreadStore} from "../src/features/home-threads/index.js";
import type {ThreadRuntimeCoordinator} from "../src/features/thread-runtime/coordinator.js";

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

  const threadStore = new PostgresThreadRuntimeStore({pool});
  await threadStore.ensureSchema();
  const homeThreads = new PostgresHomeThreadStore({pool});
  await homeThreads.ensureSchema();

  const alice = await threadStore.identityStore.createIdentity({
    id: "alice-id",
    handle: "alice",
    displayName: "Alice",
  });
  await threadStore.createThread({
    id: "home-thread",
    identityId: alice.id,
    agentKey: "panda",
  });
  await homeThreads.bindHomeThread({
    identityId: alice.id,
    threadId: "home-thread",
  });

  const runtime = createMockRuntime(createAssistantMessage(options.responseText ?? "Heartbeat handled."));
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
    homeThreads,
    coordinator,
    resolveInstructions: async () => options.heartbeatInstructions ?? null,
  });

  return {
    alice,
    pool,
    threadStore,
    homeThreads,
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

  it("fires due heartbeats into the current home thread", async () => {
    const harness = await createHarness({
      heartbeatInstructions: "Always check unfinished promises before going quiet.",
    });
    pools.push(harness.pool);

    await harness.pool.query(
      `UPDATE "thread_runtime_home_threads" SET heartbeat_next_fire_at = $2 WHERE identity_id = $1`,
      [harness.alice.id, new Date(Date.now() - 1_000)],
    );

    await harness.runner.start();
    await harness.coordinator.waitForIdle("home-thread");
    await harness.runner.stop();

    const transcript = await harness.threadStore.loadTranscript("home-thread");
    const heartbeatInput = transcript.find((entry) => entry.origin === "input" && entry.source === "heartbeat");
    expect(heartbeatInput?.metadata).toMatchObject({
      heartbeat: {
        kind: "interval",
        identityId: harness.alice.id,
      },
    });
    expect(heartbeatInput?.message).toMatchObject({
      role: "user",
      content: expect.stringContaining("Always check unfinished promises before going quiet."),
    });
    expect(harness.runtime.complete).toHaveBeenCalledTimes(1);

    const home = await harness.homeThreads.resolveHomeThread({
      identityId: harness.alice.id,
    });
    expect(home?.heartbeat.lastFireAt).toBeDefined();
    expect(home?.heartbeat.lastSkipReason).toBeUndefined();
    expect(home?.heartbeat.nextFireAt).toBeGreaterThan(Date.now());
  });

  it("skips busy home threads instead of queueing stale heartbeats", async () => {
    const harness = await createHarness();
    pools.push(harness.pool);

    await harness.coordinator.submitInput("home-thread", {
      message: stringToUserMessage("queued work"),
      source: "tui",
    }, "queue");
    await harness.pool.query(
      `UPDATE "thread_runtime_home_threads" SET heartbeat_next_fire_at = $2 WHERE identity_id = $1`,
      [harness.alice.id, new Date(Date.now() - 1_000)],
    );

    await harness.runner.start();
    await harness.runner.stop();

    const heartbeatInputs = await harness.pool.query(
      `SELECT id FROM "thread_runtime_inputs" WHERE thread_id = $1 AND source = 'heartbeat'`,
      ["home-thread"],
    );
    expect(heartbeatInputs.rows).toHaveLength(0);
    expect(harness.runtime.complete).not.toHaveBeenCalled();

    const home = await harness.homeThreads.resolveHomeThread({
      identityId: harness.alice.id,
    });
    expect(home?.heartbeat.lastFireAt).toBeUndefined();
    expect(home?.heartbeat.lastSkipReason).toBe("busy");
    expect(home?.heartbeat.nextFireAt).toBeGreaterThan(Date.now());
  });

  it("re-resolves home after claim so a switched home gets the heartbeat", async () => {
    const oldHome: HomeThreadRecord = {
      identityId: "alice-id",
      threadId: "old-home",
      heartbeat: {
        enabled: true,
        everyMinutes: 30,
        nextFireAt: Date.now() - 1_000,
      },
      createdAt: 1,
      updatedAt: 1,
    };
    const newHome: HomeThreadRecord = {
      ...oldHome,
      threadId: "new-home",
      updatedAt: 2,
    };

    let listed = false;
    const homeThreads: HomeThreadStore = {
      resolveHomeThread: vi.fn(async () => newHome),
      bindHomeThread: vi.fn(async () => {
        throw new Error("bindHomeThread should not be called in this test.");
      }),
      listDueHeartbeats: vi.fn(async () => {
        if (listed) {
          return [];
        }

        listed = true;
        return [oldHome];
      }),
      claimHeartbeat: vi.fn(async () => oldHome),
      recordHeartbeatResult: vi.fn(async () => newHome),
      updateHeartbeatConfig: vi.fn(async () => newHome),
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
      homeThreads,
      coordinator,
    });

    await runner.start();
    await runner.stop();

    expect(homeThreads.resolveHomeThread).toHaveBeenCalledWith({
      identityId: "alice-id",
    });
  });
});
