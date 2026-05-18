import {stringToUserMessage} from "../../../kernel/agent/helpers/input.js";
import {DrainLoop} from "../../../lib/drain-loop.js";
import {renderScheduledTaskPrompt} from "../../../prompts/runtime/scheduled-tasks.js";
import {resolveCurrentSessionThread, type CurrentSessionThread} from "../../sessions/current-thread.js";
import type {SessionStore} from "../../sessions/store.js";
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
type ScheduledTaskCoordinator = Pick<ThreadRuntimeCoordinator, "submitInput" | "waitForCurrentRun" | "waitForIdle">;
type ScheduledTaskSessionStore = Pick<SessionStore, "getSession">;
type ScheduledTaskRunnerStore = Pick<
  ScheduledTaskStore,
  | "claimTask"
  | "clearTaskClaim"
  | "completeTaskRun"
  | "failTaskRun"
  | "listDueTasks"
  | "markTaskCompleted"
  | "markTaskFailed"
  | "startTaskRun"
>;
type ScheduledTaskThreadStore = Pick<ThreadRuntimeStore, "listRuns">;

export interface ScheduledTaskRunnerOptions {
  tasks: ScheduledTaskRunnerStore;
  sessions: ScheduledTaskSessionStore;
  threadStore: ScheduledTaskThreadStore;
  coordinator: ScheduledTaskCoordinator;
  pollIntervalMs?: number;
  claimTtlMs?: number;
  onError?: (error: unknown, taskId?: string) => Promise<void> | void;
}

interface ThreadRunSummary {
  threadRunId: string;
  status: "completed" | "failed";
  error?: string;
}

function describeClaimFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

async function readLatestThreadRunSummary(
  threadStore: ScheduledTaskThreadStore,
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
  coordinator: ScheduledTaskCoordinator;
  threadStore: ScheduledTaskThreadStore;
  threadId: string;
  task: ScheduledTaskRecord;
  run: ScheduledTaskRunRecord;
}): Promise<ThreadRunSummary> {
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
  private readonly tasks: ScheduledTaskRunnerStore;
  private readonly sessions: ScheduledTaskSessionStore;
  private readonly threadStore: ScheduledTaskThreadStore;
  private readonly coordinator: ScheduledTaskCoordinator;
  private readonly claimTtlMs: number;
  private readonly onError?: (error: unknown, taskId?: string) => Promise<void> | void;
  private readonly claimOwner = "scheduled-task-runner";
  private readonly drainLoop: DrainLoop;

  constructor(options: ScheduledTaskRunnerOptions) {
    this.tasks = options.tasks;
    this.sessions = options.sessions;
    this.threadStore = options.threadStore;
    this.coordinator = options.coordinator;
    this.claimTtlMs = options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
    this.onError = options.onError;
    this.drainLoop = new DrainLoop({
      label: "Scheduled task runner drain",
      pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      drain: () => this.drain(),
      onError: this.onError ? (error) => this.onError?.(error) : undefined,
    });
  }

  async start(): Promise<void> {
    this.drainLoop.start();
  }

  async stop(): Promise<void> {
    await this.drainLoop.stop();
  }

  async triggerDrain(): Promise<void> {
    await this.drainLoop.trigger();
  }

  private async drain(): Promise<void> {
    while (!this.drainLoop.isStopped) {
      const dueTasks = await this.tasks.listDueTasks({
        limit: DEFAULT_BATCH_SIZE,
      });
      if (dueTasks.length === 0) {
        return;
      }

      let claimedAny = false;
      for (const task of dueTasks) {
        if (this.drainLoop.isStopped) {
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
    let target = await this.resolveClaimTarget(claim);
    if (!target) {
      return;
    }
    await this.coordinator.waitForCurrentRun(target.threadId);

    target = await this.resolveClaimTarget(claim);
    if (!target) {
      return;
    }
    const deliveryThreadId = target.threadId;

    await this.tasks.startTaskRun({
      runId: claim.run.id,
      resolvedThreadId: deliveryThreadId,
    });

    const threadRun = await executeScheduledTaskThreadRun({
      coordinator: this.coordinator,
      threadStore: this.threadStore,
      threadId: deliveryThreadId,
      task: claim.task,
      run: claim.run,
    });

    if (threadRun.status === "failed") {
      await this.failClaim(claim, threadRun.error ?? "Scheduled task execution failed.", {
        resolvedThreadId: deliveryThreadId,
        threadRunId: threadRun.threadRunId,
      });
      return;
    }

    await this.completeClaim(claim, {
      resolvedThreadId: deliveryThreadId,
      threadRunId: threadRun.threadRunId,
    });
  }

  private async resolveClaimTarget(claim: ClaimScheduledTaskResult): Promise<CurrentSessionThread | null> {
    try {
      return await resolveCurrentSessionThread(this.sessions, claim.task.sessionId);
    } catch (error) {
      await this.failClaim(claim, error);
      return null;
    }
  }

  private async failClaim(
    claim: ClaimScheduledTaskResult,
    error: unknown,
    details: {
      resolvedThreadId?: string;
      threadRunId?: string;
    } = {},
  ): Promise<void> {
    await this.tasks.failTaskRun({
      runId: claim.run.id,
      error: describeClaimFailure(error),
      ...(details.resolvedThreadId ? {resolvedThreadId: details.resolvedThreadId} : {}),
      ...(details.threadRunId ? {threadRunId: details.threadRunId} : {}),
    });
    if (claim.task.schedule.kind === "recurring") {
      await this.tasks.clearTaskClaim(claim.task.id);
      return;
    }

    await this.tasks.markTaskFailed(claim.task.id);
  }

  private async completeClaim(
    claim: ClaimScheduledTaskResult,
    details: {
      resolvedThreadId: string;
      threadRunId: string;
    },
  ): Promise<void> {
    await this.tasks.completeTaskRun({
      runId: claim.run.id,
      resolvedThreadId: details.resolvedThreadId,
      threadRunId: details.threadRunId,
    });
    if (claim.task.schedule.kind === "recurring") {
      await this.tasks.clearTaskClaim(claim.task.id);
      return;
    }

    await this.tasks.markTaskCompleted(claim.task.id);
  }
}
