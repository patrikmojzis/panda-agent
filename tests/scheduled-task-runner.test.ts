import {afterEach, describe, expect, it, vi} from "vitest";

import {
  ScheduledTaskRunner,
  type ClaimedScheduledTaskRunRecord,
  type ScheduledTaskRecord,
  type ScheduledTaskRunnerOptions,
} from "../src/domain/scheduling/tasks/index.js";
import type {ThreadEnqueueResult} from "../src/domain/threads/runtime/store.js";
import type {
  ThreadInputPayload,
  ThreadInputRecord,
  ThreadRunRecord,
} from "../src/domain/threads/runtime/types.js";
import {sleep, waitFor} from "./helpers/wait-for.js";

const RUNNER_WAIT_TIMEOUT_MS = 5_000;

function createTask(overrides: Partial<ScheduledTaskRecord> = {}): ScheduledTaskRecord {
  const scheduledFor = Date.now() - 1_000;
  return {
    id: "00000000-0000-4000-8000-000000000001",
    sessionId: "session-main",
    createdByIdentityId: "alice-id",
    title: "Morning report",
    instruction: "Prepare the morning report.",
    schedule: {
      kind: "once",
      runAt: new Date(scheduledFor).toISOString(),
    },
    enabled: true,
    nextFireAt: scheduledFor,
    createdAt: scheduledFor,
    updatedAt: scheduledFor,
    ...overrides,
  };
}

function createClaim(
  task: ScheduledTaskRecord,
  overrides: Partial<ClaimedScheduledTaskRunRecord> = {},
): ClaimedScheduledTaskRunRecord {
  const claimedAt = Date.now();
  return {
    id: "00000000-0000-4000-8000-000000000002",
    taskId: task.id,
    sessionId: task.sessionId,
    createdByIdentityId: task.createdByIdentityId,
    scheduledFor: task.nextFireAt ?? claimedAt,
    status: "claimed",
    claimToken: "00000000-0000-4000-8000-000000000003",
    claimedAt,
    claimedBy: "scheduled-task-runner",
    claimExpiresAt: claimedAt + 60_000,
    createdAt: claimedAt,
    ...overrides,
  };
}

function createInput(inputId: string, threadId: string, payload: ThreadInputPayload): ThreadInputRecord {
  return {
    id: inputId,
    threadId,
    order: 1,
    deliveryMode: "wake",
    status: "pending",
    connectorKey: "",
    source: payload.source,
    externalMessageId: payload.externalMessageId,
    identityId: payload.identityId,
    createdAt: Date.now(),
  };
}

function createThreadRun(
  threadId: string,
  overrides: Partial<ThreadRunRecord> = {},
): ThreadRunRecord {
  const startedAt = Date.now();
  return {
    id: "00000000-0000-4000-8000-000000000005",
    threadId,
    status: "completed",
    startedAt,
    finishedAt: startedAt + 1,
    ...overrides,
  };
}

function createHarness(options: {
  task?: ScheduledTaskRecord;
  run?: ClaimedScheduledTaskRunRecord;
  threadRun?: ThreadRunRecord;
  renewTaskRunClaim?: ScheduledTaskRunnerOptions["tasks"]["renewTaskRunClaim"];
  waitForInputRun?: (inputId: string) => Promise<ThreadRunRecord>;
} = {}) {
  const task = options.task ?? createTask();
  const run = options.run ?? createClaim(task);
  const threadId = run.resolvedThreadId ?? "thread-current";
  const threadRun = options.threadRun ?? createThreadRun(threadId);
  let claimed = false;
  let materialized = task.nextFireAt === undefined;

  const tasks: ScheduledTaskRunnerOptions["tasks"] = {
    listDueTasks: vi.fn()
      .mockResolvedValueOnce(task.nextFireAt === undefined ? [] : [task])
      .mockResolvedValue([]),
    materializeTaskRuns: vi.fn(async ({runs}) => {
      if (runs.length === 0) return [];
      materialized = true;
      return [run];
    }),
    claimTaskRun: vi.fn(async () => {
      if (claimed || !materialized) return null;
      claimed = true;
      return {task, run};
    }),
    renewTaskRunClaim: vi.fn(options.renewTaskRunClaim ?? (async () => run)),
    startTaskRun: vi.fn(async () => ({
      ...run,
      status: "running",
      resolvedThreadId: threadId,
      threadInputId: run.id,
      startedAt: Date.now(),
    })),
    completeTaskRun: vi.fn(async ({threadRunId}) => ({
      ...run,
      status: "succeeded",
      resolvedThreadId: threadId,
      threadInputId: run.id,
      threadRunId,
      finishedAt: Date.now(),
    })),
    failTaskRun: vi.fn(async ({threadRunId, error}) => ({
      ...run,
      status: "failed",
      resolvedThreadId: threadId,
      ...(threadRunId ? {threadRunId} : {}),
      error,
      finishedAt: Date.now(),
    })),
  };

  const submitSessionInput = vi.fn(async (
    _sessionId: string,
    payload: ThreadInputPayload,
    _mode: "wake",
    options: {inputId: string},
  ): Promise<ThreadEnqueueResult> => ({
    input: createInput(options.inputId, threadId, payload),
    disposition: "inserted",
  }));
  const waitForInputRun = vi.fn(options.waitForInputRun ?? (async () => threadRun));
  const sessions = {
    getSession: vi.fn(async () => ({
      id: task.sessionId,
      agentKey: "panda",
      kind: "main" as const,
      currentThreadId: threadId,
      createdByIdentityId: "session-creator-id",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })),
  };
  const runner = new ScheduledTaskRunner({
    tasks,
    sessions,
    coordinator: {submitSessionInput, waitForInputRun},
  });

  return {
    runner,
    run,
    sessions,
    submitSessionInput,
    task,
    tasks,
    threadId,
    threadRun,
    waitForInputRun,
  };
}

async function drainRunner(runner: ScheduledTaskRunner): Promise<void> {
  await runner.start();
  await runner.triggerDrain();
  await runner.stop();
}

describe("ScheduledTaskRunner", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("materializes due occurrences in one batch and settles the exact consuming run", async () => {
    const harness = createHarness();

    await drainRunner(harness.runner);

    expect(harness.tasks.materializeTaskRuns).toHaveBeenCalledWith({
      runs: [{
        taskId: harness.task.id,
        scheduledFor: harness.task.nextFireAt,
        nextFireAt: undefined,
      }],
    });
    expect(harness.submitSessionInput).toHaveBeenCalledTimes(1);
    expect(harness.sessions.getSession).not.toHaveBeenCalled();
    const [submittedSessionId, payload, mode, options] = harness.submitSessionInput.mock.calls[0]!;
    expect(submittedSessionId).toBe(harness.task.sessionId);
    expect(mode).toBe("wake");
    expect(options).toEqual({inputId: harness.run.id});
    expect(payload).toMatchObject({
      source: "scheduled_task",
      externalMessageId: harness.run.id,
      identityId: harness.task.createdByIdentityId,
      metadata: {
        scheduledTask: {
          taskId: harness.task.id,
          taskRunId: harness.run.id,
          title: harness.task.title,
        },
      },
    });
    expect(harness.tasks.startTaskRun).toHaveBeenCalledWith({
      runId: harness.run.id,
      claimToken: harness.run.claimToken,
    });
    expect(harness.waitForInputRun).toHaveBeenCalledWith(harness.run.id);
    expect(harness.tasks.completeTaskRun).toHaveBeenCalledWith({
      runId: harness.run.id,
      claimToken: harness.run.claimToken,
      threadRunId: harness.threadRun.id,
    });
    expect(harness.tasks.failTaskRun).not.toHaveBeenCalled();
  });

  it("resumes an already-linked occurrence without enqueuing duplicate input", async () => {
    const task = createTask({nextFireAt: undefined});
    const run = createClaim(task, {
      status: "running",
      resolvedThreadId: "thread-before-restart",
      threadInputId: "00000000-0000-4000-8000-000000000099",
      startedAt: Date.now() - 5_000,
    });
    const harness = createHarness({task, run});

    await drainRunner(harness.runner);

    expect(harness.submitSessionInput).not.toHaveBeenCalled();
    expect(harness.tasks.startTaskRun).not.toHaveBeenCalled();
    expect(harness.waitForInputRun).toHaveBeenCalledWith(run.threadInputId);
    expect(harness.tasks.completeTaskRun).toHaveBeenCalledTimes(1);
  });

  it("records the exact failed thread run as the occurrence failure", async () => {
    const failedRun = createThreadRun("thread-current", {
      status: "failed",
      error: "Provider exhausted retries.",
    });
    const harness = createHarness({threadRun: failedRun});

    await drainRunner(harness.runner);

    expect(harness.tasks.failTaskRun).toHaveBeenCalledWith({
      runId: harness.run.id,
      claimToken: harness.run.claimToken,
      threadRunId: failedRun.id,
      error: failedRun.error,
    });
    expect(harness.tasks.completeTaskRun).not.toHaveBeenCalled();
  });

  it("fails an occurrence whose stable input was discarded instead of recreating it", async () => {
    const harness = createHarness();
    harness.submitSessionInput.mockImplementation(async (_sessionId, payload, _mode, options) => ({
      input: {
        ...createInput(options.inputId, harness.threadId, payload),
        status: "discarded",
        discardedAt: Date.now(),
      },
      disposition: "duplicate_discarded",
    }));

    await drainRunner(harness.runner);

    expect(harness.tasks.startTaskRun).not.toHaveBeenCalled();
    expect(harness.tasks.failTaskRun).toHaveBeenCalledWith({
      runId: harness.run.id,
      claimToken: harness.run.claimToken,
      error: `Scheduled task input ${harness.run.id} was discarded before execution.`,
    });
  });

  it("submits by durable session instead of retaining a thread target across reset", async () => {
    const task = createTask({createdByIdentityId: undefined});
    const harness = createHarness({task, run: createClaim(task)});

    await drainRunner(harness.runner);

    expect(harness.sessions.getSession).toHaveBeenCalledWith(harness.task.sessionId);
    expect(harness.submitSessionInput).toHaveBeenCalledWith(
      harness.task.sessionId,
      expect.any(Object),
      "wake",
      {inputId: harness.run.id},
    );
  });

  it("cannot mark an enqueued input failed when the linkage response is lost", async () => {
    const harness = createHarness();
    vi.mocked(harness.tasks.startTaskRun).mockRejectedValueOnce(new Error("link response lost"));
    vi.mocked(harness.tasks.failTaskRun).mockRejectedValueOnce(
      new Error("exact input exists; occurrence remains recoverable"),
    );

    await drainRunner(harness.runner);

    expect(harness.submitSessionInput).toHaveBeenCalledTimes(1);
    expect(harness.tasks.failTaskRun).toHaveBeenCalledWith({
      runId: harness.run.id,
      claimToken: harness.run.claimToken,
      error: "link response lost",
    });
    expect(harness.tasks.completeTaskRun).not.toHaveBeenCalled();
  });

  it("does not block start on active work, renews its claim, and makes stop drain it", async () => {
    let releaseRun!: () => void;
    const runFinished = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const harness = createHarness({
      waitForInputRun: async () => {
        await runFinished;
        return createThreadRun("thread-current");
      },
    });
    const runner = new ScheduledTaskRunner({
      tasks: harness.tasks,
      sessions: harness.sessions,
      coordinator: {
        submitSessionInput: harness.submitSessionInput,
        waitForInputRun: harness.waitForInputRun,
      },
      claimTtlMs: 3_000,
    });

    const startResult = await Promise.race([
      runner.start().then(() => "resolved"),
      sleep(25).then(() => "blocked"),
    ]);
    expect(startResult).toBe("resolved");
    await waitFor(() => {
      expect(harness.tasks.startTaskRun).toHaveBeenCalledTimes(1);
    }, RUNNER_WAIT_TIMEOUT_MS);

    await sleep(1_100);
    expect(harness.tasks.renewTaskRunClaim).toHaveBeenCalledWith({
      runId: harness.run.id,
      claimToken: harness.run.claimToken,
      claimTtlMs: 3_000,
    });

    const stopPromise = runner.stop();
    const stopResult = await Promise.race([
      stopPromise.then(() => "resolved"),
      sleep(25).then(() => "blocked"),
    ]);
    expect(stopResult).toBe("blocked");

    releaseRun();
    await stopPromise;
    expect(harness.tasks.completeTaskRun).toHaveBeenCalledTimes(1);
  });

  it("does not let one long run block unrelated scheduled occurrences", async () => {
    let releaseFirst!: () => void;
    const firstFinished = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstTask = createTask({nextFireAt: undefined});
    const firstRun = createClaim(firstTask);
    const secondTask = createTask({
      id: "00000000-0000-4000-8000-000000000007",
      sessionId: "session-other",
      nextFireAt: undefined,
    });
    const secondRun = createClaim(secondTask, {
      id: "00000000-0000-4000-8000-000000000008",
      sessionId: secondTask.sessionId,
      taskId: secondTask.id,
    });
    const harness = createHarness({task: firstTask, run: firstRun});
    harness.tasks.listDueTasks = vi.fn(async () => []);
    harness.tasks.claimTaskRun = vi.fn()
      .mockResolvedValueOnce({task: firstTask, run: firstRun})
      .mockResolvedValueOnce({task: secondTask, run: secondRun})
      .mockResolvedValue(null);
    harness.waitForInputRun.mockImplementation(async (inputId) => {
      if (inputId === firstRun.id) {
        await firstFinished;
      }
      return createThreadRun("thread-current", {
        id: inputId === firstRun.id
          ? "00000000-0000-4000-8000-000000000009"
          : "00000000-0000-4000-8000-000000000010",
      });
    });
    const runner = new ScheduledTaskRunner({
      tasks: harness.tasks,
      sessions: harness.sessions,
      coordinator: {
        submitSessionInput: harness.submitSessionInput,
        waitForInputRun: harness.waitForInputRun,
      },
      maxConcurrentRuns: 2,
    });

    await runner.start();
    await waitFor(() => {
      expect(harness.tasks.completeTaskRun).toHaveBeenCalledWith(expect.objectContaining({
        runId: secondRun.id,
      }));
    }, RUNNER_WAIT_TIMEOUT_MS);
    expect(harness.tasks.completeTaskRun).not.toHaveBeenCalledWith(expect.objectContaining({
      runId: firstRun.id,
    }));

    releaseFirst();
    await runner.stop();
    expect(harness.tasks.completeTaskRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: firstRun.id,
    }));
  });

  it("does not materialize backlog while every execution slot is occupied", async () => {
    let releaseRun!: () => void;
    const runFinished = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const harness = createHarness({
      waitForInputRun: async () => {
        await runFinished;
        return createThreadRun("thread-current");
      },
    });
    // Model a pending occurrence from an earlier daemon alongside an overdue
    // definition. Capacity must be spent on the durable occurrence first;
    // creating fresh backlog while it runs would amplify downtime catch-up.
    harness.tasks.claimTaskRun = vi.fn()
      .mockResolvedValueOnce({task: harness.task, run: harness.run})
      .mockResolvedValue(null);
    const runner = new ScheduledTaskRunner({
      tasks: harness.tasks,
      sessions: harness.sessions,
      coordinator: {
        submitSessionInput: harness.submitSessionInput,
        waitForInputRun: harness.waitForInputRun,
      },
      maxConcurrentRuns: 1,
    });

    await runner.start();
    await waitFor(() => {
      expect(harness.tasks.startTaskRun).toHaveBeenCalledTimes(1);
    }, RUNNER_WAIT_TIMEOUT_MS);
    vi.mocked(harness.tasks.listDueTasks).mockClear();
    vi.mocked(harness.tasks.materializeTaskRuns).mockClear();
    vi.mocked(harness.tasks.claimTaskRun).mockClear();

    await runner.triggerDrain();

    expect(harness.tasks.listDueTasks).not.toHaveBeenCalled();
    expect(harness.tasks.materializeTaskRuns).not.toHaveBeenCalled();
    expect(harness.tasks.claimTaskRun).not.toHaveBeenCalled();
    releaseRun();
    await runner.stop();
  });

  it("leaves an occurrence recoverable when claim renewal becomes uncertain", async () => {
    let releaseSubmit!: () => void;
    const submitBlocked = new Promise<void>((resolve) => {
      releaseSubmit = resolve;
    });
    const onError = vi.fn();
    const harness = createHarness({
      renewTaskRunClaim: async () => null,
    });
    harness.submitSessionInput.mockImplementation(async (_sessionId, payload, _mode, options) => {
      await submitBlocked;
      return {
        input: createInput(options.inputId, harness.threadId, payload),
        disposition: "inserted",
      };
    });
    vi.mocked(harness.tasks.startTaskRun).mockRejectedValue(
      new Error("old claim token is fenced"),
    );
    const runner = new ScheduledTaskRunner({
      tasks: harness.tasks,
      sessions: harness.sessions,
      coordinator: {
        submitSessionInput: harness.submitSessionInput,
        waitForInputRun: harness.waitForInputRun,
      },
      claimTtlMs: 3_000,
      onError,
    });

    await runner.start();
    await waitFor(() => {
      expect(harness.submitSessionInput).toHaveBeenCalledTimes(1);
    }, RUNNER_WAIT_TIMEOUT_MS);
    await sleep(1_100);
    await runner.stop();

    expect(harness.tasks.renewTaskRunClaim).toHaveBeenCalledTimes(1);
    expect(harness.tasks.startTaskRun).not.toHaveBeenCalled();
    expect(harness.tasks.failTaskRun).not.toHaveBeenCalled();
    expect(harness.tasks.completeTaskRun).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({name: "ScheduledTaskClaimLostError"}),
      harness.task.id,
    );

    releaseSubmit();
    await waitFor(() => {
      expect(harness.tasks.startTaskRun).toHaveBeenCalledWith({
        runId: harness.run.id,
        claimToken: harness.run.claimToken,
      });
    }, RUNNER_WAIT_TIMEOUT_MS);
    expect(harness.tasks.failTaskRun).not.toHaveBeenCalled();
    expect(harness.tasks.completeTaskRun).not.toHaveBeenCalled();
  });

  it("keeps catching up one overdue recurring definition until no occurrence advances", async () => {
    const firstFire = Date.now() - 120_000;
    const task = createTask({
      schedule: {kind: "recurring", cron: "* * * * *", timezone: "UTC"},
      nextFireAt: firstFire,
    });
    const firstRun = createClaim(task, {scheduledFor: firstFire});
    const secondFire = firstFire + 60_000;
    const secondRun = createClaim(task, {
      id: "00000000-0000-4000-8000-000000000006",
      scheduledFor: secondFire,
    });
    const harness = createHarness({task, run: firstRun});
    harness.tasks.listDueTasks = vi.fn()
      .mockResolvedValueOnce([task])
      .mockResolvedValueOnce([{...task, nextFireAt: secondFire}])
      .mockResolvedValue([]);
    harness.tasks.materializeTaskRuns = vi.fn()
      .mockResolvedValueOnce([firstRun])
      .mockResolvedValueOnce([secondRun])
      .mockResolvedValue([]);
    harness.tasks.claimTaskRun = vi.fn()
      .mockResolvedValueOnce({task, run: firstRun})
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({task, run: secondRun})
      .mockResolvedValue(null);

    const runner = new ScheduledTaskRunner({
      tasks: harness.tasks,
      sessions: harness.sessions,
      coordinator: {
        submitSessionInput: harness.submitSessionInput,
        waitForInputRun: harness.waitForInputRun,
      },
      maxConcurrentRuns: 1,
    });
    await runner.start();
    await waitFor(() => {
      expect(harness.submitSessionInput).toHaveBeenCalledTimes(2);
    }, RUNNER_WAIT_TIMEOUT_MS);
    await runner.stop();

    expect(vi.mocked(harness.tasks.listDueTasks).mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(harness.tasks.materializeTaskRuns).toHaveBeenCalledTimes(2);
    expect(harness.submitSessionInput).toHaveBeenCalledTimes(2);
  });
});
