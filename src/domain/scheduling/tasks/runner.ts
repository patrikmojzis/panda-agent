import {stringToUserMessage} from "../../../kernel/agent/index.js";
import {runInBackground} from "../../../lib/async.js";
import {renderScheduledTaskPrompt} from "../../../prompts/runtime/scheduled-tasks.js";
import type {SessionStore} from "../../sessions/index.js";
import type {ThreadRuntimeCoordinator} from "../../threads/runtime/coordinator.js";
import type {ThreadRuntimeStore} from "../../threads/runtime/store.js";
import {computeClaimNextFireAt} from "./schedule.js";
import type {ScheduledTaskStore} from "./store.js";
import type {
    ClaimScheduledTaskResult,
    ScheduledTaskRecord,
    ScheduledTaskRunRecord,
    ScheduledTaskThreadInputMetadata,
} from "./types.js";

const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_CLAIM_TTL_MS = 10 * 60_000;
const DEFAULT_BATCH_SIZE = 25;
const SCHEDULED_TASK_SOURCE = "scheduled_task";

export interface ScheduledTaskRunnerOptions {
  tasks: ScheduledTaskStore;
  sessions: SessionStore;
  threadStore: ThreadRuntimeStore;
  coordinator: ThreadRuntimeCoordinator;
  pollIntervalMs?: number;
  claimTtlMs?: number;
  onError?: (error: unknown, taskId?: string) => Promise<void> | void;
}

interface ThreadRunSummary {
  threadRunId: string;
  status: "completed" | "failed";
  error?: string;
}

function buildScheduledTaskMetadata(
  task: ScheduledTaskRecord,
  scheduledFor: number,
): ScheduledTaskThreadInputMetadata {
  return {
    scheduledTask: {
      taskId: task.id,
      title: task.title,
      runAt: new Date(scheduledFor).toISOString(),
    },
  };
}

function buildScheduledTaskPrompt(task: ScheduledTaskRecord, scheduledFor: number): string {
  return renderScheduledTaskPrompt({
    title: task.title,
    instruction: task.instruction,
    scheduledIso: new Date(scheduledFor).toISOString(),
  });
}

async function resolveTargetThreadId(task: ScheduledTaskRecord, sessions: SessionStore): Promise<string | undefined> {
  const session = await sessions.getSession(task.sessionId);
  return session.currentThreadId;
}

async function readLatestThreadRunSummary(
  threadStore: ThreadRuntimeStore,
  threadId: string,
  previousRunIds: ReadonlySet<string>,
): Promise<ThreadRunSummary> {
  const runs = await threadStore.listRuns(threadId);
  const threadRun = [...runs].reverse().find((run) => !previousRunIds.has(run.id)) ?? runs.at(-1);
  if (!threadRun) {
    throw new Error(`Scheduled task thread ${threadId} did not produce a run.`);
  }

  if (threadRun.status !== "completed" && threadRun.status !== "failed") {
    throw new Error(`Scheduled task thread run ${threadRun.id} did not settle cleanly.`);
  }

  return {
    threadRunId: threadRun.id,
    status: threadRun.status,
    error: threadRun.error,
  };
}

async function executeScheduledTaskThreadRun(options: {
  coordinator: ThreadRuntimeCoordinator;
  threadStore: ThreadRuntimeStore;
  threadId: string;
  task: ScheduledTaskRecord;
  run: ScheduledTaskRunRecord;
}): Promise<ThreadRunSummary> {
  await options.coordinator.waitForCurrentRun(options.threadId);
  const previousRunIds = new Set((await options.threadStore.listRuns(options.threadId)).map((entry) => entry.id));

  await options.coordinator.submitInput(options.threadId, {
    message: stringToUserMessage(buildScheduledTaskPrompt(options.task, options.run.scheduledFor)),
    source: SCHEDULED_TASK_SOURCE,
    identityId: options.task.createdByIdentityId,
    metadata: buildScheduledTaskMetadata(options.task, options.run.scheduledFor),
  });
  await options.coordinator.waitForIdle(options.threadId);

  return readLatestThreadRunSummary(options.threadStore, options.threadId, previousRunIds);
}

export class ScheduledTaskRunner {
  private readonly tasks: ScheduledTaskStore;
  private readonly sessions: SessionStore;
  private readonly threadStore: ThreadRuntimeStore;
  private readonly coordinator: ThreadRuntimeCoordinator;
  private readonly pollIntervalMs: number;
  private readonly claimTtlMs: number;
  private readonly onError?: (error: unknown, taskId?: string) => Promise<void> | void;
  private readonly claimOwner = "scheduled-task-runner";

  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private drainPromise: Promise<void> | null = null;
  private pendingDrain = false;

  constructor(options: ScheduledTaskRunnerOptions) {
    this.tasks = options.tasks;
    this.sessions = options.sessions;
    this.threadStore = options.threadStore;
    this.coordinator = options.coordinator;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.claimTtlMs = options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
    this.onError = options.onError;
  }

  async start(): Promise<void> {
    if (!this.stopped) {
      return;
    }

    this.stopped = false;
    this.timer = setInterval(() => {
      this.kickDrain();
    }, this.pollIntervalMs);
    this.kickDrain();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    if (this.drainPromise) {
      await this.drainPromise;
    }
  }

  async triggerDrain(): Promise<void> {
    if (this.stopped) {
      return;
    }

    if (this.drainPromise) {
      this.pendingDrain = true;
      return;
    }

    this.drainPromise = this.drain();
    try {
      await this.drainPromise;
    } finally {
      this.drainPromise = null;
      if (this.pendingDrain && !this.stopped) {
        this.pendingDrain = false;
        await this.triggerDrain();
      }
    }
  }

  private kickDrain(): void {
    runInBackground(() => this.triggerDrain(), {
      label: "Scheduled task runner drain",
      onError: this.onError ? (error) => this.onError?.(error) : undefined,
    });
  }

  private async drain(): Promise<void> {
    while (!this.stopped) {
      const dueTasks = await this.tasks.listDueTasks({
        limit: DEFAULT_BATCH_SIZE,
      });
      if (dueTasks.length === 0) {
        return;
      }

      let claimedAny = false;
      for (const task of dueTasks) {
        if (this.stopped) {
          return;
        }

        const claim = await this.tasks.claimTask({
          taskId: task.id,
          claimedBy: this.claimOwner,
          claimExpiresAt: Date.now() + this.claimTtlMs,
          nextFireAt: task.nextFireAt === undefined ? undefined : computeClaimNextFireAt(task.schedule, task.nextFireAt),
        });
        if (!claim) {
          continue;
        }

        claimedAny = true;
        try {
          await this.processClaim(claim);
        } catch (error) {
          await this.onError?.(error, claim.task.id);
        }
      }

      if (!claimedAny) {
        return;
      }
    }
  }

  private async processClaim(claim: ClaimScheduledTaskResult): Promise<void> {
    await this.processExecutePhase(claim);
  }

  private async processExecutePhase(claim: ClaimScheduledTaskResult): Promise<void> {
    const resolvedThreadId = await resolveTargetThreadId(claim.task, this.sessions);
    if (!resolvedThreadId) {
      await this.tasks.failTaskRun({
        runId: claim.run.id,
        error: `Scheduled task ${claim.task.id} has no resolved thread target.`,
      });
      if (claim.task.schedule.kind === "recurring") {
        await this.tasks.clearTaskClaim(claim.task.id);
      } else {
        await this.tasks.markTaskFailed(claim.task.id);
      }
      return;
    }

    await this.tasks.startTaskRun({
      runId: claim.run.id,
      resolvedThreadId,
    });

    const threadRun = await executeScheduledTaskThreadRun({
      coordinator: this.coordinator,
      threadStore: this.threadStore,
      threadId: resolvedThreadId,
      task: claim.task,
      run: claim.run,
    });

    if (threadRun.status === "failed") {
      await this.tasks.failTaskRun({
        runId: claim.run.id,
        resolvedThreadId,
        threadRunId: threadRun.threadRunId,
        error: threadRun.error ?? "Scheduled task execution failed.",
      });
      if (claim.task.schedule.kind === "recurring") {
        await this.tasks.clearTaskClaim(claim.task.id);
      } else {
        await this.tasks.markTaskFailed(claim.task.id);
      }
      return;
    }

    await this.tasks.completeTaskRun({
      runId: claim.run.id,
      resolvedThreadId,
      threadRunId: threadRun.threadRunId,
    });
    if (claim.task.schedule.kind === "recurring") {
      await this.tasks.clearTaskClaim(claim.task.id);
    } else {
      await this.tasks.markTaskCompleted(claim.task.id);
    }
  }
}
