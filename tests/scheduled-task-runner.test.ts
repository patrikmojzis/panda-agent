import {afterEach, describe, expect, it, vi} from "vitest";
import type {AssistantMessage} from "@mariozechner/pi-ai";
import {DataType, newDb} from "pg-mem";

import {
    Agent,
    PostgresHomeThreadStore,
    PostgresOutboundDeliveryStore,
    PostgresScheduledTaskStore,
    PostgresThreadRuntimeStore,
    ScheduledTaskRunner,
    ThreadRuntimeCoordinator,
} from "../src/index.js";
import {PostgresThreadRouteStore} from "../src/features/thread-routes/index.js";

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
  responseText: string;
  routeSource?: string;
  routeConnectorKey?: string;
}) {
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
  const scheduledTasks = new PostgresScheduledTaskStore({pool});
  await scheduledTasks.ensureSchema();
  const homeThreads = new PostgresHomeThreadStore({pool});
  await homeThreads.ensureSchema();
  const threadRoutes = new PostgresThreadRouteStore({pool});
  await threadRoutes.ensureSchema();
  const outboundDeliveries = new PostgresOutboundDeliveryStore({pool});
  await outboundDeliveries.ensureSchema();

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

  if (options.routeSource) {
    await threadRoutes.rememberLastRoute({
      threadId: "home-thread",
      route: {
        source: options.routeSource,
        connectorKey: options.routeConnectorKey ?? "connector-1",
        externalConversationId: "conversation-1",
        externalActorId: "actor-1",
        capturedAt: Date.now(),
      },
    });
  }

  const runtime = createMockRuntime(createAssistantMessage(options.responseText));
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

  const runner = new ScheduledTaskRunner({
    tasks: scheduledTasks,
    homeThreads,
    threadRoutes,
    outboundDeliveries,
    threadStore,
    coordinator,
  });

  return {
    alice,
    pool,
    threadStore,
    scheduledTasks,
    homeThreads,
    threadRoutes,
    outboundDeliveries,
    coordinator,
    runner,
    runtime,
  };
}

describe("ScheduledTaskRunner", () => {
  const pools: Array<{end(): Promise<void>}> = [];

  afterEach(async () => {
    vi.useRealTimers();

    while (pools.length > 0) {
      const pool = pools.pop();
      if (!pool) {
        continue;
      }

      await pool.end();
    }
  });

  it("completes a once task and queues a delivery", async () => {
    const harness = await createHarness({
      responseText: "Buy apples tomorrow.",
      routeSource: "telegram",
      routeConnectorKey: "bot-1",
    });
    pools.push(harness.pool);

    const task = await harness.scheduledTasks.createTask({
      identityId: harness.alice.id,
      agentKey: "panda",
      title: "Buy apples",
      instruction: "Remind me to buy apples.",
      schedule: {
        kind: "once",
        runAt: new Date(Date.now() - 60_000).toISOString(),
      },
    });

    await harness.runner.start();
    await harness.runner.stop();

    const updated = await harness.scheduledTasks.getTask(task.id);
    expect(updated.completedAt).toBeDefined();
    expect(updated.nextFireAt).toBeUndefined();

    const run = await harness.scheduledTasks.getLatestTaskRun(task.id);
    expect(run).toMatchObject({
      status: "succeeded",
      deliveryStatus: "sent",
    });

    const delivery = await harness.outboundDeliveries.claimNextPendingDelivery({
      channel: "telegram",
      connectorKey: "bot-1",
    });
    expect(delivery).toMatchObject({
      channel: "telegram",
      items: [{type: "text", text: "Buy apples tomorrow."}],
    });
  });

  it("advances recurring tasks before execution and keeps them active after success", async () => {
    const harness = await createHarness({
      responseText: "Here is your morning report.",
      routeSource: "telegram",
      routeConnectorKey: "bot-1",
    });
    pools.push(harness.pool);

    const task = await harness.scheduledTasks.createTask({
      identityId: harness.alice.id,
      agentKey: "panda",
      title: "Morning report",
      instruction: "Deliver the report.",
      schedule: {
        kind: "recurring",
        cron: "* * * * *",
        timezone: "UTC",
      },
    });

    await harness.pool.query(
      `UPDATE "thread_runtime_scheduled_tasks" SET next_fire_at = $2 WHERE id = $1`,
      [task.id, new Date(Date.now() - 1_000)],
    );
    await harness.runner.start();
    await harness.runner.stop();

    const updated = await harness.scheduledTasks.getTask(task.id);
    expect(updated.completedAt).toBeUndefined();
    expect(updated.nextFireAt).toBeGreaterThan(Date.now());
    expect(updated.claimedAt).toBeUndefined();
  });

  it("transitions delayed once tasks from execute to deliver and then completes them", async () => {
    const harness = await createHarness({
      responseText: "Bee research is ready.",
      routeSource: "telegram",
      routeConnectorKey: "bot-1",
    });
    pools.push(harness.pool);
    const deliverAt = new Date(Date.now() + 60_000).toISOString();

    const task = await harness.scheduledTasks.createTask({
      identityId: harness.alice.id,
      agentKey: "panda",
      title: "Bee research",
      instruction: "Research bees and prepare a report.",
      schedule: {
        kind: "once",
        runAt: new Date(Date.now() - 60_000).toISOString(),
        deliverAt,
      },
    });

    await harness.runner.start();
    await harness.runner.stop();

    let updated = await harness.scheduledTasks.getTask(task.id);
    expect(updated.nextFireKind).toBe("deliver");
    expect(updated.nextFireAt).toBe(Date.parse(deliverAt));
    expect(await harness.outboundDeliveries.claimNextPendingDelivery({
      channel: "telegram",
      connectorKey: "bot-1",
    })).toBeNull();

    await harness.pool.query(
      `UPDATE "thread_runtime_scheduled_tasks" SET next_fire_at = $2 WHERE id = $1`,
      [task.id, new Date(Date.now() - 1_000)],
    );
    await harness.runner.start();
    await harness.runner.stop();

    updated = await harness.scheduledTasks.getTask(task.id);
    expect(updated.completedAt).toBeDefined();
    expect(updated.nextFireAt).toBeUndefined();

    const runs = [
      await harness.scheduledTasks.getLatestTaskRun(task.id, "execute"),
      await harness.scheduledTasks.getLatestTaskRun(task.id, "deliver"),
    ];
    expect(runs[0]).toMatchObject({
      status: "succeeded",
      deliveryStatus: "not_requested",
    });
    expect(runs[1]).toMatchObject({
      status: "succeeded",
      deliveryStatus: "sent",
    });
  });

  it("still executes due tasks when there is no remembered route, but marks delivery unavailable", async () => {
    const harness = await createHarness({
      responseText: "This should stay in the thread.",
    });
    pools.push(harness.pool);

    const task = await harness.scheduledTasks.createTask({
      identityId: harness.alice.id,
      agentKey: "panda",
      title: "No route",
      instruction: "Do the work anyway.",
      schedule: {
        kind: "once",
        runAt: new Date(Date.now() - 60_000).toISOString(),
      },
    });

    await harness.runner.start();
    await harness.runner.stop();

    const updated = await harness.scheduledTasks.getTask(task.id);
    expect(updated.completedAt).toBeDefined();

    const run = await harness.scheduledTasks.getLatestTaskRun(task.id);
    expect(run).toMatchObject({
      status: "succeeded",
      deliveryStatus: "unavailable",
    });
    expect(await harness.outboundDeliveries.claimNextPendingDelivery({
      channel: "telegram",
      connectorKey: "bot-1",
    })).toBeNull();
  });
});
