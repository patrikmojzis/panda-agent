import {describe, expect, it, vi} from "vitest";

import {
    Agent,
    type PandaSessionContext,
    RunContext,
    ScheduledTaskCancelTool,
    ScheduledTaskCreateTool,
    ScheduledTaskUpdateTool,
    ToolError,
} from "../src/index.js";
import type {ScheduledTaskStore} from "../src/domain/scheduling/tasks/index.js";

function createRunContext(context: PandaSessionContext): RunContext<PandaSessionContext> {
  return new RunContext({
    agent: new Agent({
      name: "scheduled-task-test-agent",
      instructions: "Use tools.",
    }),
    turn: 0,
    maxTurns: 10,
    messages: [],
    context,
  });
}

function createStoreMock(): ScheduledTaskStore {
  return {
    ensureSchema: vi.fn(async () => {}),
    createTask: vi.fn(async (input) => ({
      id: "task-1",
      sessionId: input.sessionId,
      createdByIdentityId: input.createdByIdentityId,
      title: input.title,
      instruction: input.instruction,
      schedule: input.schedule,
      enabled: input.enabled ?? true,
      nextFireAt: Date.parse(input.schedule.kind === "once" ? input.schedule.runAt : "2026-04-10T08:00:00.000Z"),
      nextFireKind: "execute",
      createdAt: 1,
      updatedAt: 1,
    })),
    updateTask: vi.fn(async (input) => ({
      id: input.taskId,
      sessionId: input.sessionId,
      title: input.title ?? "task",
      instruction: input.instruction ?? "instruction",
      schedule: input.schedule ?? {
        kind: "once",
        runAt: "2026-04-11T09:00:00.000Z",
      },
      enabled: input.enabled ?? true,
      nextFireAt: 1,
      nextFireKind: "execute",
      createdAt: 1,
      updatedAt: 1,
    })),
    cancelTask: vi.fn(async (input) => ({
      id: input.taskId,
      sessionId: input.sessionId,
      title: "task",
      instruction: "instruction",
      schedule: {
        kind: "once",
        runAt: "2026-04-11T09:00:00.000Z",
      },
      enabled: true,
      nextFireKind: "execute",
      cancelledAt: 1,
      createdAt: 1,
      updatedAt: 1,
    })),
    getTask: vi.fn(),
    listDueTasks: vi.fn(),
    claimTask: vi.fn(),
    startTaskRun: vi.fn(),
    completeTaskRun: vi.fn(),
    failTaskRun: vi.fn(),
    clearTaskClaim: vi.fn(),
    markTaskWaitingDelivery: vi.fn(),
    markTaskCompleted: vi.fn(),
    markTaskFailed: vi.fn(),
    getLatestTaskRun: vi.fn(),
  };
}

describe("scheduled task Panda tools", () => {
  const context: PandaSessionContext = {
    agentKey: "panda",
    sessionId: "session-main",
    threadId: "thread-home",
    currentInput: {
      source: "tui",
      identityId: "identity-1",
    },
  };

  it("creates a once task and normalizes absolute timestamps", async () => {
    const store = createStoreMock();
    const tool = new ScheduledTaskCreateTool({
      store,
    });

    const result = await tool.run({
      title: "Buy apples",
      instruction: "Remind me to buy apples.",
      schedule: {
        kind: "once",
        runAt: "2026-04-11T09:00:00+02:00",
      },
    }, createRunContext(context));

    expect(result).toEqual({
      taskId: "task-1",
    });
    expect(store.createTask).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-main",
      createdByIdentityId: "identity-1",
      schedule: {
        kind: "once",
        runAt: "2026-04-11T07:00:00.000Z",
      },
    }));
  });

  it("rejects once schedules whose deliverAt is not later than runAt", async () => {
    const tool = new ScheduledTaskCreateTool({
      store: createStoreMock(),
    });

    await expect(tool.run({
      title: "Bad reminder",
      instruction: "This should fail.",
      schedule: {
        kind: "once",
        runAt: "2026-04-11T09:00:00+02:00",
        deliverAt: "2026-04-11T09:00:00+02:00",
      },
    }, createRunContext(context))).rejects.toBeInstanceOf(ToolError);
  });

  it("requires recurring schedules to include both cron and timezone", async () => {
    const tool = new ScheduledTaskCreateTool({
      store: createStoreMock(),
    });

    await expect(tool.run({
      title: "Morning news",
      instruction: "Report the news.",
      schedule: {
        kind: "recurring",
        cron: "0 8 * * *",
      } as any,
    }, createRunContext(context))).rejects.toBeInstanceOf(ToolError);
  });

  it("updates a task within the current session", async () => {
    const store = createStoreMock();
    const tool = new ScheduledTaskUpdateTool({
      store,
    });

    const result = await tool.run({
      taskId: "task-1",
      enabled: false,
    }, createRunContext(context));

    expect(result).toEqual({
      taskId: "task-1",
      updated: true,
    });
    expect(store.updateTask).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "task-1",
      sessionId: "session-main",
      enabled: false,
    }));
  });

  it("cancels a task without deleting it", async () => {
    const store = createStoreMock();
    const tool = new ScheduledTaskCancelTool({
      store,
    });

    const result = await tool.run({
      taskId: "task-1",
      reason: "not needed anymore",
    }, createRunContext(context));

    expect(result).toEqual({
      taskId: "task-1",
      cancelled: true,
    });
    expect(store.cancelTask).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "task-1",
      reason: "not needed anymore",
    }));
  });
});
