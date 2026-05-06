import {afterEach, describe, expect, it, vi} from "vitest";
import type {AssistantMessage} from "@mariozechner/pi-ai";
import {DataType, newDb} from "pg-mem";

import {Agent,} from "../src/index.js";
import {PostgresScheduledTaskStore, ScheduledTaskRunner,} from "../src/domain/scheduling/tasks/index.js";
import {ThreadRuntimeCoordinator,} from "../src/domain/threads/runtime/index.js";
import {createRuntimeStores} from "./helpers/runtime-store-setup.js";
import {sleep, waitFor} from "./helpers/wait-for.js";

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

  const {identityStore, sessionStore, threadStore} = await createRuntimeStores(pool);
  const scheduledTasks = new PostgresScheduledTaskStore({pool});
  await scheduledTasks.ensureSchema();

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
    createAssistantMessage(options.responseText),
    createAssistantMessage(options.responseText),
    createAssistantMessage(options.responseText),
    createAssistantMessage(options.responseText),
    createAssistantMessage(options.responseText),
    createAssistantMessage(options.responseText),
    createAssistantMessage(options.responseText),
    createAssistantMessage(options.responseText),
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

  const runner = new ScheduledTaskRunner({
    tasks: scheduledTasks,
    sessions: sessionStore,
    threadStore,
    coordinator,
  });

  return {
    alice,
    pool,
    threadStore,
    sessionStore,
    scheduledTasks,
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

  it("completes a once task without auto-delivering assistant text", async () => {
    const harness = await createHarness({
      responseText: "Buy apples tomorrow.",
    });
    pools.push(harness.pool);

    const task = await harness.scheduledTasks.createTask({
      sessionId: "session-main",
      createdByIdentityId: harness.alice.id,
      title: "Buy apples",
      instruction: "Remind me to buy apples.",
      schedule: {
        kind: "once",
        runAt: new Date(Date.now() - 60_000).toISOString(),
      },
    });

    await harness.runner.start();
    await waitFor(async () => {
      const updated = await harness.scheduledTasks.getTask(task.id);
      expect(updated.completedAt).toBeDefined();
    });
    await harness.runner.stop();

    const updated = await harness.scheduledTasks.getTask(task.id);
    expect(updated.completedAt).toBeDefined();
    expect(updated.nextFireAt).toBeUndefined();

    const runs = await harness.pool.query(
      `SELECT status FROM "runtime"."scheduled_task_runs" WHERE task_id = $1`,
      [task.id],
    );
    expect(runs.rows).toEqual([{status: "succeeded"}]);

    const transcript = await harness.threadStore.loadTranscript("session-thread");
    const input = transcript.find((entry) => entry.origin === "input" && entry.source === "scheduled_task");
    expect(input?.identityId).toBe(harness.alice.id);
    expect(JSON.stringify(input?.message)).toContain("The user is not actively watching this session right now.");
  });

  it("advances recurring tasks before execution and keeps them active after success", async () => {
    const harness = await createHarness({
      responseText: "Here is your morning report.",
    });
    pools.push(harness.pool);

    const task = await harness.scheduledTasks.createTask({
      sessionId: "session-main",
      createdByIdentityId: harness.alice.id,
      title: "Morning report",
      instruction: "Deliver the report.",
      schedule: {
        kind: "recurring",
        cron: "* * * * *",
        timezone: "UTC",
      },
    });

    await harness.pool.query(
      `UPDATE "runtime"."scheduled_tasks" SET next_fire_at = $2 WHERE id = $1`,
      [task.id, new Date(Date.now() - 1_000)],
    );
    await harness.runner.start();
    await waitFor(async () => {
      const updated = await harness.scheduledTasks.getTask(task.id);
      expect(updated.claimedAt).toBeUndefined();
      expect(updated.nextFireAt).toBeGreaterThan(Date.now());
    });
    await harness.runner.stop();

    const updated = await harness.scheduledTasks.getTask(task.id);
    expect(updated.completedAt).toBeUndefined();
    expect(updated.nextFireAt).toBeGreaterThan(Date.now());
    expect(updated.claimedAt).toBeUndefined();
  });

  it("still executes due tasks when there is no channel route", async () => {
    const harness = await createHarness({
      responseText: "This should stay in the thread.",
    });
    pools.push(harness.pool);

    const task = await harness.scheduledTasks.createTask({
      sessionId: "session-main",
      createdByIdentityId: harness.alice.id,
      title: "No route",
      instruction: "Do the work anyway.",
      schedule: {
        kind: "once",
        runAt: new Date(Date.now() - 60_000).toISOString(),
      },
    });

    await harness.runner.start();
    await waitFor(async () => {
      const updated = await harness.scheduledTasks.getTask(task.id);
      expect(updated.completedAt).toBeDefined();
    });
    await harness.runner.stop();

    const updated = await harness.scheduledTasks.getTask(task.id);
    expect(updated.completedAt).toBeDefined();

    const runs = await harness.pool.query(
      `SELECT status FROM "runtime"."scheduled_task_runs" WHERE task_id = $1`,
      [task.id],
    );
    expect(runs.rows).toEqual([{status: "succeeded"}]);
  });

  it("does not block start on an active scheduled task drain but stop still waits", async () => {
    let released = false;
    let releaseIdle!: () => void;
    const idle = new Promise<void>((resolve) => {
      releaseIdle = () => {
        released = true;
        resolve();
      };
    });
    const task = {
      id: "task-1",
      sessionId: "session-main",
      createdByIdentityId: "alice-id",
      title: "Slow task",
      instruction: "Do slow work.",
      schedule: {
        kind: "once",
        runAt: new Date(Date.now() - 1_000).toISOString(),
      },
      nextFireAt: Date.now() - 1_000,
    };
    const run = {
      id: "scheduled-run-1",
      taskId: task.id,
      sessionId: task.sessionId,
      createdByIdentityId: task.createdByIdentityId,
      scheduledFor: Date.now() - 1_000,
      status: "running",
      createdAt: Date.now(),
    };
    let listed = false;
    const tasks = {
      listDueTasks: vi.fn(async () => {
        if (listed) {
          return [];
        }
        listed = true;
        return [task];
      }),
      claimTask: vi.fn(async () => ({task, run})),
      startTaskRun: vi.fn(async () => run),
      completeTaskRun: vi.fn(async () => ({...run, status: "succeeded"})),
      failTaskRun: vi.fn(),
      markTaskCompleted: vi.fn(async () => ({...task, completedAt: Date.now()})),
      markTaskFailed: vi.fn(),
      clearTaskClaim: vi.fn(),
    };
    const runner = new ScheduledTaskRunner({
      tasks: tasks as any,
      sessions: {
        getSession: vi.fn(async () => ({
          id: task.sessionId,
          agentKey: "panda",
          kind: "main",
          currentThreadId: "thread-1",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })),
      } as any,
      threadStore: {
        listRuns: vi.fn(async () => released
          ? [{id: "thread-run-1", status: "completed"}]
          : []),
      } as any,
      coordinator: {
        waitForCurrentRun: vi.fn(async () => {}),
        submitInput: vi.fn(async () => {}),
        waitForIdle: vi.fn(async () => {
          await idle;
        }),
      } as any,
    });

    const startResult = await Promise.race([
      runner.start().then(() => "resolved"),
      sleep(25).then(() => "blocked"),
    ]);
    expect(startResult).toBe("resolved");
    await waitFor(() => {
      expect(tasks.startTaskRun).toHaveBeenCalledTimes(1);
    });

    const stopPromise = runner.stop();
    const stopResult = await Promise.race([
      stopPromise.then(() => "resolved"),
      sleep(25).then(() => "blocked"),
    ]);
    expect(stopResult).toBe("blocked");

    releaseIdle();
    await stopPromise;
    expect(tasks.completeTaskRun).toHaveBeenCalledTimes(1);
  });
});
