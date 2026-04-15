import {stringToUserMessage} from "../../../kernel/agent/index.js";
import {renderScheduledTaskPrompt} from "../../../prompts/runtime/scheduled-tasks.js";
import type {RememberedRoute} from "../../channels/types.js";
import type {SessionRouteRepo, SessionStore} from "../../sessions/index.js";
import {summarizeMessageText} from "../../../personas/panda/message-preview.js";
import type {OutboundDeliveryStore} from "../../channels/deliveries/store.js";
import type {ThreadRuntimeCoordinator} from "../../threads/runtime/coordinator.js";
import type {ThreadRuntimeStore} from "../../threads/runtime/store.js";
import {computeClaimNextFireAt} from "./schedule.js";
import type {ScheduledTaskStore} from "./store.js";
import type {
    ClaimScheduledTaskResult,
    ScheduledTaskFireKind,
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
  sessionRoutes: SessionRouteRepo;
  outboundDeliveries: OutboundDeliveryStore;
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
  assistantText: string | null;
  outboundUsed: boolean;
}

function buildScheduledTaskMetadata(
  task: ScheduledTaskRecord,
  fireKind: ScheduledTaskFireKind,
  scheduledFor: number,
): ScheduledTaskThreadInputMetadata {
  return {
    scheduledTask: {
      taskId: task.id,
      title: task.title,
      phase: fireKind,
      deliveryMode: task.schedule.kind === "once" && task.schedule.deliverAt ? "deferred" : "immediate",
      runAt: new Date(scheduledFor).toISOString(),
      deliverAt: task.schedule.kind === "once" ? task.schedule.deliverAt ?? null : null,
    },
  };
}

function buildScheduledTaskPrompt(task: ScheduledTaskRecord, scheduledFor: number): string {
  return renderScheduledTaskPrompt({
    title: task.title,
    instruction: task.instruction,
    scheduledIso: new Date(scheduledFor).toISOString(),
    prepareOnly: task.schedule.kind === "once" && Boolean(task.schedule.deliverAt),
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

  const transcript = await threadStore.loadTranscript(threadId);
  const runMessages = transcript.filter((entry) => entry.runId === threadRun.id);
  const assistantMessage = [...runMessages].reverse().find((entry) => entry.message.role === "assistant");

  if (threadRun.status !== "completed" && threadRun.status !== "failed") {
    throw new Error(`Scheduled task thread run ${threadRun.id} did not settle cleanly.`);
  }

  return {
    threadRunId: threadRun.id,
    status: threadRun.status,
    error: threadRun.error,
    assistantText: assistantMessage ? summarizeMessageText(assistantMessage.message) || null : null,
    outboundUsed: runMessages.some((entry) => entry.source === "tool:outbound"),
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
    metadata: buildScheduledTaskMetadata(options.task, options.run.fireKind, options.run.scheduledFor),
  });
  await options.coordinator.waitForIdle(options.threadId);

  return readLatestThreadRunSummary(options.threadStore, options.threadId, previousRunIds);
}

async function enqueueTextDelivery(options: {
  outboundDeliveries: OutboundDeliveryStore;
  threadId: string;
  route: RememberedRoute;
  text: string;
}): Promise<void> {
  await options.outboundDeliveries.enqueueDelivery({
    threadId: options.threadId,
    channel: options.route.source,
    target: {
      source: options.route.source,
      connectorKey: options.route.connectorKey,
      externalConversationId: options.route.externalConversationId,
      externalActorId: options.route.externalActorId,
    },
    items: [{
      type: "text",
      text: options.text,
    }],
  });
}

export class ScheduledTaskRunner {
  private readonly tasks: ScheduledTaskStore;
  private readonly sessions: SessionStore;
  private readonly sessionRoutes: SessionRouteRepo;
  private readonly outboundDeliveries: OutboundDeliveryStore;
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
    this.sessionRoutes = options.sessionRoutes;
    this.outboundDeliveries = options.outboundDeliveries;
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
      void this.triggerDrain();
    }, this.pollIntervalMs);
    await this.triggerDrain();
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
    if (claim.run.fireKind === "deliver") {
      await this.processDeliverPhase(claim);
      return;
    }

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

    const route = await this.sessionRoutes.getLastRoute({
      sessionId: claim.task.sessionId,
      identityId: claim.task.createdByIdentityId,
    });

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

    if (claim.task.schedule.kind === "once" && claim.task.schedule.deliverAt) {
      await this.tasks.completeTaskRun({
        runId: claim.run.id,
        resolvedThreadId,
        threadRunId: threadRun.threadRunId,
        deliveryStatus: "not_requested",
      });
      await this.tasks.markTaskWaitingDelivery(claim.task.id);
      return;
    }

    let deliveryStatus: ScheduledTaskRunRecord["deliveryStatus"] = "not_requested";
    if (threadRun.outboundUsed) {
      deliveryStatus = "sent";
    } else if (threadRun.assistantText) {
      if (!route) {
        deliveryStatus = "unavailable";
      } else {
      try {
        await enqueueTextDelivery({
          outboundDeliveries: this.outboundDeliveries,
          threadId: resolvedThreadId,
          route,
          text: threadRun.assistantText,
        });
        deliveryStatus = "sent";
      } catch (error) {
        deliveryStatus = "failed";
        await this.tasks.completeTaskRun({
          runId: claim.run.id,
          resolvedThreadId,
          threadRunId: threadRun.threadRunId,
          deliveryStatus,
        });
        if (claim.task.schedule.kind === "recurring") {
          await this.tasks.clearTaskClaim(claim.task.id);
        } else {
          await this.tasks.markTaskCompleted(claim.task.id);
        }
        throw error;
      }
      }
    } else {
      deliveryStatus = "unavailable";
    }

    await this.tasks.completeTaskRun({
      runId: claim.run.id,
      resolvedThreadId,
      threadRunId: threadRun.threadRunId,
      deliveryStatus,
    });
    if (claim.task.schedule.kind === "recurring") {
      await this.tasks.clearTaskClaim(claim.task.id);
    } else {
      await this.tasks.markTaskCompleted(claim.task.id);
    }
  }

  private async processDeliverPhase(claim: ClaimScheduledTaskResult): Promise<void> {
    const executeRun = await this.tasks.getLatestTaskRun(claim.task.id, "execute");
    const sourceThreadId = executeRun?.resolvedThreadId;
    const threadRunId = executeRun?.threadRunId;
    if (!executeRun || !sourceThreadId || !threadRunId) {
      await this.tasks.failTaskRun({
        runId: claim.run.id,
        error: `Scheduled task ${claim.task.id} has no prepared output to deliver.`,
        deliveryStatus: "unavailable",
      });
      await this.tasks.markTaskCompleted(claim.task.id);
      return;
    }

    const transcript = await this.threadStore.loadTranscript(sourceThreadId);
    const assistantMessage = [...transcript].reverse().find((entry) => {
      return entry.runId === threadRunId && entry.message.role === "assistant";
    });
    const assistantText = assistantMessage ? summarizeMessageText(assistantMessage.message) || null : null;
    if (!assistantText) {
      await this.tasks.failTaskRun({
        runId: claim.run.id,
        resolvedThreadId: sourceThreadId,
        threadRunId,
        deliveryStatus: "unavailable",
        error: `Scheduled task ${claim.task.id} has no assistant output to deliver.`,
      });
      await this.tasks.markTaskCompleted(claim.task.id);
      return;
    }

    const resolvedThreadId = await resolveTargetThreadId(claim.task, this.sessions);
    if (!resolvedThreadId) {
      await this.tasks.failTaskRun({
        runId: claim.run.id,
        resolvedThreadId: sourceThreadId,
        threadRunId,
        deliveryStatus: "unavailable",
        error: `Scheduled task ${claim.task.id} has no resolved session thread to deliver through.`,
      });
      await this.tasks.markTaskCompleted(claim.task.id);
      return;
    }

    const route = await this.sessionRoutes.getLastRoute({
      sessionId: claim.task.sessionId,
      identityId: claim.task.createdByIdentityId,
    });
    if (!route) {
      await this.tasks.failTaskRun({
        runId: claim.run.id,
        resolvedThreadId,
        threadRunId,
        deliveryStatus: "unavailable",
        error: `Scheduled task ${claim.task.id} has no remembered route to deliver to.`,
      });
      await this.tasks.markTaskCompleted(claim.task.id);
      return;
    }

    await this.tasks.startTaskRun({
      runId: claim.run.id,
      resolvedThreadId,
    });

    try {
      await enqueueTextDelivery({
        outboundDeliveries: this.outboundDeliveries,
        threadId: resolvedThreadId,
        route,
        text: assistantText,
      });
      await this.tasks.completeTaskRun({
        runId: claim.run.id,
        resolvedThreadId,
        threadRunId,
        deliveryStatus: "sent",
      });
    } catch (error) {
      await this.tasks.failTaskRun({
        runId: claim.run.id,
        resolvedThreadId,
        threadRunId,
        deliveryStatus: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      await this.tasks.markTaskCompleted(claim.task.id);
      throw error;
    }

    await this.tasks.markTaskCompleted(claim.task.id);
  }
}
