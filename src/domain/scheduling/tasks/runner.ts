import {stringToUserMessage} from "../../../kernel/agent/helpers/input.js";
import {DrainLoop} from "../../../lib/drain-loop.js";
import {renderScheduledTaskPrompt} from "../../../prompts/runtime/scheduled-tasks.js";
import type {SessionStore} from "../../sessions/store.js";
import type {ThreadRuntimeCoordinator} from "../../threads/runtime/coordinator.js";
import type {ThreadRunRecord} from "../../threads/runtime/types.js";
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
const MIN_CLAIM_TTL_MS = 3_000;
const DEFAULT_BATCH_SIZE = 25;
export const DEFAULT_SCHEDULED_TASK_CONCURRENCY = 4;
const SCHEDULED_TASK_SOURCE = "scheduled_task";

type ScheduledTaskCoordinator = Pick<ThreadRuntimeCoordinator, "submitSessionInput" | "waitForInputRun">;
type ScheduledTaskSessionStore = Pick<SessionStore, "getSession">;
type ScheduledTaskRunnerStore = Pick<
  ScheduledTaskStore,
  | "claimTaskRun"
  | "completeTaskRun"
  | "failTaskRun"
  | "listDueTasks"
  | "materializeTaskRuns"
  | "renewTaskRunClaim"
  | "startTaskRun"
>;

export interface ScheduledTaskRunnerOptions {
  tasks: ScheduledTaskRunnerStore;
  sessions: ScheduledTaskSessionStore;
  coordinator: ScheduledTaskCoordinator;
  pollIntervalMs?: number;
  claimTtlMs?: number;
  maxConcurrentRuns?: number;
  onError?: (error: unknown, taskId?: string) => Promise<void> | void;
}

function describeClaimFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class ScheduledTaskClaimLostError extends Error {
  constructor(runId: string, options?: ErrorOptions) {
    super(`Scheduled task run ${runId} lost its claim while executing.`, options);
    this.name = "ScheduledTaskClaimLostError";
  }
}

function buildScheduledTaskMetadata(
  task: ScheduledTaskRecord,
  run: ScheduledTaskRunRecord,
): ScheduledTaskThreadInputMetadata {
  return {
    scheduledTask: {
      taskId: task.id,
      taskRunId: run.id,
      title: task.title,
      runAt: new Date(run.scheduledFor).toISOString(),
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

export class ScheduledTaskRunner {
  private readonly tasks: ScheduledTaskRunnerStore;
  private readonly sessions: ScheduledTaskSessionStore;
  private readonly coordinator: ScheduledTaskCoordinator;
  private readonly claimTtlMs: number;
  private readonly maxConcurrentRuns: number;
  private readonly onError?: (error: unknown, taskId?: string) => Promise<void> | void;
  private readonly claimOwner = "scheduled-task-runner";
  private readonly activeClaims = new Set<Promise<void>>();
  private readonly drainLoop: DrainLoop;

  constructor(options: ScheduledTaskRunnerOptions) {
    this.tasks = options.tasks;
    this.sessions = options.sessions;
    this.coordinator = options.coordinator;
    this.claimTtlMs = options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
    if (!Number.isFinite(this.claimTtlMs) || this.claimTtlMs < MIN_CLAIM_TTL_MS) {
      throw new Error(`Scheduled task claim TTL must be at least ${MIN_CLAIM_TTL_MS}ms.`);
    }
    this.maxConcurrentRuns = options.maxConcurrentRuns ?? DEFAULT_SCHEDULED_TASK_CONCURRENCY;
    if (!Number.isInteger(this.maxConcurrentRuns) || this.maxConcurrentRuns <= 0) {
      throw new Error("Scheduled task concurrency must be a positive integer.");
    }
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
    await Promise.allSettled([...this.activeClaims]);
  }

  async triggerDrain(): Promise<void> {
    await this.drainLoop.trigger();
  }

  private async drain(): Promise<void> {
    while (!this.drainLoop.isStopped) {
      if (this.activeClaims.size >= this.maxConcurrentRuns) {
        return;
      }
      while (!this.drainLoop.isStopped && this.activeClaims.size < this.maxConcurrentRuns) {
        const claim = await this.tasks.claimTaskRun({
          claimedBy: this.claimOwner,
          claimTtlMs: this.claimTtlMs,
        });
        if (!claim) {
          break;
        }

        this.superviseClaim(claim);
      }

      if (this.activeClaims.size >= this.maxConcurrentRuns) {
        return;
      }
      const availableSlots = this.maxConcurrentRuns - this.activeClaims.size;
      const materializedDueRun = await this.materializeDueRuns(
        Math.min(DEFAULT_BATCH_SIZE, availableSlots),
      );
      if (!materializedDueRun) {
        return;
      }
    }
  }

  private superviseClaim(claim: ClaimScheduledTaskResult): void {
    let execution!: Promise<void>;
    execution = (async () => {
      try {
        await this.processClaim(claim);
      } catch (error) {
        try {
          await this.onError?.(error, claim.task.id);
        } catch (reportError) {
          console.error("Scheduled task error handler failed", {
            taskId: claim.task.id,
            error: describeClaimFailure(reportError),
          });
        }
      } finally {
        this.activeClaims.delete(execution);
        if (!this.drainLoop.isStopped) {
          this.drainLoop.kick();
        }
      }
    })();
    this.activeClaims.add(execution);
  }

  private async materializeDueRuns(limit: number): Promise<boolean> {
    const dueTasks = await this.tasks.listDueTasks({limit});
    if (this.drainLoop.isStopped || dueTasks.length === 0) {
      return false;
    }

    const materialized = await this.tasks.materializeTaskRuns({
      runs: dueTasks.flatMap((task) => task.nextFireAt === undefined
        ? []
        : [{
            taskId: task.id,
            scheduledFor: task.nextFireAt,
            nextFireAt: computeClaimNextFireAt(task.schedule, task.nextFireAt),
          }]),
    });
    // A recurring definition can remain overdue, but storage admits only one
    // active occurrence per task. Completion kicks another drain, so catch-up
    // stays immediate without overlapping one task or starving other work.
    return materialized.length > 0;
  }

  private async processClaim(claim: ClaimScheduledTaskResult): Promise<void> {
    let threadRun: ThreadRunRecord | undefined;
    try {
      threadRun = await this.executeWithClaimRenewal(claim);
      if (threadRun.status === "failed") {
        await this.tasks.failTaskRun({
          runId: claim.run.id,
          claimToken: claim.run.claimToken,
          threadRunId: threadRun.id,
          error: threadRun.error ?? "Scheduled task execution failed.",
        });
        return;
      }

      await this.tasks.completeTaskRun({
        runId: claim.run.id,
        claimToken: claim.run.claimToken,
        threadRunId: threadRun.id,
      });
    } catch (error) {
      if (error instanceof ScheduledTaskClaimLostError) {
        // Losing the lease says nothing about execution. The stable input may
        // already exist, and the in-flight enqueue cannot be cancelled. Leave
        // the occurrence for the next token holder to recover and reconcile.
        throw error;
      }
      // Once an input is linked, a transient waiter/runtime failure is not an
      // execution result. The store accepts this failure only before delivery
      // or for a discarded tombstone; otherwise the occurrence stays
      // recoverable until a runner can read its exact input receipt.
      await this.tasks.failTaskRun({
        runId: claim.run.id,
        claimToken: claim.run.claimToken,
        ...(threadRun ? {threadRunId: threadRun.id} : {}),
        error: describeClaimFailure(error),
      });
    }
  }

  private async executeWithClaimRenewal(claim: ClaimScheduledTaskResult): Promise<ThreadRunRecord> {
    let renewal = Promise.resolve();
    let claimLost = false;
    let rejectClaimLoss!: (error: unknown) => void;
    const claimLoss = new Promise<never>((_resolve, reject) => {
      rejectClaimLoss = reject;
    });
    const interval = setInterval(() => {
      renewal = renewal.then(async () => {
        try {
          const renewed = await this.tasks.renewTaskRunClaim({
            runId: claim.run.id,
            claimToken: claim.run.claimToken,
            claimTtlMs: this.claimTtlMs,
          });
          if (!renewed) {
            throw new ScheduledTaskClaimLostError(claim.run.id);
          }
        } catch (error) {
          if (!claimLost) {
            claimLost = true;
            rejectClaimLoss(error instanceof ScheduledTaskClaimLostError
              ? error
              : new ScheduledTaskClaimLostError(claim.run.id, {cause: error}));
          }
        }
      });
    }, Math.max(1_000, Math.floor(this.claimTtlMs / 3)));
    interval.unref?.();

    try {
      return await Promise.race([this.executeClaim(claim), claimLoss]);
    } finally {
      clearInterval(interval);
      await renewal;
    }
  }

  private async executeClaim(claim: ClaimScheduledTaskResult): Promise<ThreadRunRecord> {
    if (claim.run.threadInputId && claim.run.resolvedThreadId) {
      return this.coordinator.waitForInputRun(claim.run.threadInputId);
    }

    const identityId = claim.task.createdByIdentityId
      ?? (await this.sessions.getSession(claim.task.sessionId)).createdByIdentityId;
    // The occurrence UUID is also the input idempotency key. Retries across a
    // crash or /reset therefore recover one durable input instead of creating
    // another execution on whichever thread is current later.
    const enqueue = await this.coordinator.submitSessionInput(claim.task.sessionId, {
      message: stringToUserMessage(buildScheduledTaskPrompt(claim.task, claim.run.scheduledFor)),
      source: SCHEDULED_TASK_SOURCE,
      externalMessageId: claim.run.id,
      identityId,
      metadata: buildScheduledTaskMetadata(claim.task, claim.run),
    }, "wake", {inputId: claim.run.id});
    if (enqueue.input.status === "discarded") {
      throw new Error(`Scheduled task input ${enqueue.input.id} was discarded before execution.`);
    }
    await this.tasks.startTaskRun({
      runId: claim.run.id,
      claimToken: claim.run.claimToken,
    });
    return this.coordinator.waitForInputRun(enqueue.input.id);
  }
}
