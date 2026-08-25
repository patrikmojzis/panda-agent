import type {Message, ThinkingLevel} from "@earendil-works/pi-ai";

import {runInBackground, sleep, withFallbackTimeout} from "../../../lib/async.js";
import {runThreadStep, Thread, type ThreadResumeState, type ThreadStepResult} from "../../../kernel/agent/thread.js";
import {stringToUserMessage} from "../../../kernel/agent/helpers/input.js";
import {resolveModelRuntimeBudget} from "../../../kernel/models/model-context-policy.js";
import {ContextWindowExceededError, ProviderRuntimeError} from "../../../kernel/agent/exceptions.js";
import {resolveRuntimeDefaultModelSelector} from "../../../kernel/models/default-model.js";
import type {ThreadRunEvent} from "../../../kernel/agent/types.js";
import type {LlmModelCallObserver} from "../../../kernel/agent/runtime.js";
import {stringifyUnknown} from "../../../kernel/agent/helpers/stringify.js";
import type {
  AutoCompactionRuntimeState,
  InferenceProjection,
  ResolvedThreadDefinition,
  ThreadDefinitionResolver,
  ThreadEnqueueOptions,
  ThreadInputPayload,
  ThreadMessageRecord,
  ThreadRecord,
  ThreadRunRecord,
  ThreadRunOwner,
  ThreadTranscriptSnapshot,
} from "./types.js";
import {DEFAULT_THREAD_RUN_ABORT_REASON} from "./types.js";
import {
  ThreadRunClaimLostError,
  type ThreadEnqueueResult,
  type ThreadRuntimeStore,
} from "./store.js";
import {
  appendCompactionFailureNotice,
  AUTO_COMPACT_BREAKER_COOLDOWN_MS,
  AUTO_COMPACT_BREAKER_FAILURE_THRESHOLD,
  compactThread,
  CompactThreadError,
  estimateTranscriptTokens,
  readAutoCompactionRuntimeState,
  shouldAutoCompactThread,
  updateAutoCompactionRuntimeState,
} from "../../../kernel/transcript/compaction.js";
import {
  applyImageProjectionForInference,
  projectTranscriptForInference,
} from "../../../kernel/transcript/inference-projection.js";
import {rehydrateProjectedToolArtifacts} from "./tool-artifact-replay.js";
import {isRecord} from "../../../lib/records.js";
import {renderRuntimeAutonomyContext} from "../../../prompts/runtime/autonomy-context.js";
import type {ThreadRuntimeNotification} from "./postgres-notifications.js";
import {
  ThreadRunScheduler,
  type ThreadRunExecutionResult,
} from "./scheduler.js";

export type ThreadWakeMode = "wake" | "queue";

export type OrphanedRunRecoveryTrigger = "coordinator_call" | "daemon_startup_or_restart";
export type OrphanedRunRecoveryProbableCause =
  | "unknown"
  | "previous_runtime_stopped_before_run_completed";

const NOTIFICATION_FALLBACK_INTERVAL_MS = 5_000;
const RUNNABLE_RECONCILIATION_BATCH_SIZE = 100;
const RUNNABLE_BACKLOG_RETRY_INTERVAL_MS = 5_000;
const ORPHANED_RUN_RECOVERY_BATCH_SIZE = 1_000;
const ORPHANED_TOOL_JOB_RECOVERY_BATCH_SIZE = 1_000;
const RUN_SETTLEMENT_MAX_RETRY_DELAY_MS = 1_000;
const THREAD_SETTLEMENT_RECONCILIATION_INITIAL_RETRY_DELAY_MS = 25;
const THREAD_SETTLEMENT_RECONCILIATION_MAX_RETRY_DELAY_MS = 1_000;
const ORPHANED_RUN_RECOVERY_MECHANISM = "daemon_lease_fenced_run_claim_sweep";
const ORPHANED_TOOL_JOB_REASON = "The owning runtime stopped before the background tool job finished.";

export function formatOrphanedRunRecoveryReason(input: {
  recoveryTrigger: OrphanedRunRecoveryTrigger;
  probableCause?: OrphanedRunRecoveryProbableCause;
  recoveredAt?: number;
}): string {
  const recoveredAt = new Date(input.recoveredAt ?? Date.now()).toISOString();
  const probableCause = input.probableCause ?? "unknown";

  return `Run marked failed during orphaned-run recovery; recoveryTrigger=${input.recoveryTrigger}; recoveryMechanism=${ORPHANED_RUN_RECOVERY_MECHANISM}; probableCause=${probableCause}; recoveredAt=${recoveredAt}.`;
}

export interface ThreadRuntimeCoordinatorOptions {
  store: ThreadRuntimeStore;
  resolveDefinition: ThreadDefinitionResolver;
  maxConcurrentRuns: number;
  shutdownDrainTimeoutMs?: number;
  modelCallObserver?: LlmModelCallObserver;
  onEvent?: (event: ThreadRuntimeEvent) => Promise<void> | void;
}

export type ThreadRuntimeEvent =
  | {
    type: "run_started";
    threadId: string;
    run: ThreadRunRecord;
  }
  | {
    type: "inputs_applied";
    threadId: string;
    runId: string;
    messages: readonly ThreadMessageRecord[];
  }
  | {
    type: "thread_event";
    threadId: string;
    runId: string;
    event: ThreadRunEvent;
  }
  | {
    type: "run_finished";
    threadId: string;
    run: ThreadRunRecord;
  };

interface ThreadBoundaryState {
  hasAdmittedInputs: boolean;
  hadPendingWake: boolean;
}

export type ThreadRuntimeNotificationStatus = "listening" | "reconnecting" | "closed";

interface ActiveRunSignal {
  threadId: string;
  signal: AbortSignal;
}

interface ThreadChangeWaiter {
  promise: Promise<void>;
  resolve(): void;
}

export interface ThreadExclusiveAccess {
  signal: AbortSignal;
  owner: ThreadRunOwner;
}

const IDLE_REROLL_SUPPRESSED_INPUT_SOURCES = new Set([
  "heartbeat",
]);

function isPersistedThreadMessage(event: ThreadRunEvent): event is Extract<ThreadRunEvent, { role: string }> {
  return "role" in event && (event.role === "assistant" || event.role === "toolResult");
}

function runtimeSourceForMessage(message: Message): string {
  if (message.role === "assistant") {
    return "assistant";
  }

  if (message.role === "toolResult") {
    return `tool:${message.toolName}`;
  }

  return message.role;
}

function grantsIdleReroll(input: Pick<ThreadMessageRecord, "source">): boolean {
  return !IDLE_REROLL_SUPPRESSED_INPUT_SOURCES.has(input.source);
}

interface RunInputContext {
  messageId: string;
  source: string;
  channelId?: string;
  externalMessageId?: string;
  actorId?: string;
  identityId?: string;
  metadata?: ThreadMessageRecord["metadata"];
}

function buildInputContext(entry: ThreadMessageRecord): RunInputContext {
  return {
    messageId: entry.id,
    source: entry.source,
    channelId: entry.channelId,
    externalMessageId: entry.externalMessageId,
    actorId: entry.actorId,
    identityId: entry.identityId,
    metadata: entry.metadata,
  };
}

function hasRouteMetadata(entry: ThreadMessageRecord): boolean {
  return isRecord(entry.metadata) && isRecord(entry.metadata.route);
}

function buildCurrentInputContext(
  messages: readonly ThreadMessageRecord[],
): RunInputContext | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index];
    if (!entry || entry.origin !== "input") {
      continue;
    }
    return buildInputContext(entry);
  }

  return undefined;
}

function buildCurrentRouteInputContext(
  messages: readonly ThreadMessageRecord[],
): RunInputContext | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index];
    if (!entry || entry.origin !== "input" || !hasRouteMetadata(entry)) {
      continue;
    }
    return buildInputContext(entry);
  }

  return undefined;
}

function buildRunContextValue(
  baseContext: unknown,
  messages: readonly ThreadMessageRecord[],
  runId?: string,
  routeMessages: readonly ThreadMessageRecord[] = messages,
): unknown {
  const currentInput = buildCurrentInputContext(messages);
  const currentRouteInput = buildCurrentRouteInputContext(routeMessages);
  if (!currentInput && !currentRouteInput && runId === undefined) {
    return baseContext;
  }

  if (!isRecord(baseContext)) {
    return {
      ...(currentInput ? { currentInput } : {}),
      ...(currentRouteInput ? { currentRouteInput } : {}),
      ...(runId ? { runId } : {}),
    };
  }

  const {
    identityId: _identityId,
    identityHandle: _identityHandle,
    ...sanitizedBaseContext
  } = baseContext;

  return {
    ...sanitizedBaseContext,
    ...(currentInput ? { currentInput } : {}),
    ...(currentRouteInput ? { currentRouteInput } : {}),
    ...(runId ? { runId } : {}),
  };
}

function sanitizePersistedMessage(message: Message, tools: Thread["agent"]["tools"]): Message {
  if (message.role === "assistant") {
    const content = message.content.map((block) => {
      if (block.type !== "toolCall") {
        return block;
      }

      const tool = tools.find((candidate) => candidate.name === block.name);
      if (!tool || typeof block.arguments !== "object" || block.arguments === null || Array.isArray(block.arguments)) {
        return block;
      }

      return {
        ...block,
        arguments: tool.redactCallArguments(block.arguments as Record<string, unknown>),
      };
    });

    return {
      ...message,
      content,
    };
  }

  if (message.role === "toolResult") {
    const tool = tools.find((candidate) => candidate.name === message.toolName);
    return tool ? tool.redactResultMessage(message) : message;
  }

  return message;
}

type AutoCompactionPreflightResult =
  | {
    action: "continue";
    thread: ThreadRecord;
    attemptedAutoCompact?: boolean;
  }
  | {
    action: "restart";
    attemptedAutoCompact?: boolean;
  };

export class ThreadRuntimeCoordinator {
  private readonly store: ThreadRuntimeStore;
  private readonly resolveDefinition: ThreadDefinitionResolver;
  private readonly modelCallObserver?: LlmModelCallObserver;
  private readonly onEvent?: (event: ThreadRuntimeEvent) => Promise<void> | void;
  private readonly scheduler: ThreadRunScheduler;
  private readonly shutdownDrainTimeoutMs: number;
  private readonly activeSignalsByRun = new Map<string, ActiveRunSignal>();
  private readonly changeWaitersByThread = new Map<string, Set<ThreadChangeWaiter>>();
  private readonly abortReconciliations = new Set<Promise<void>>();
  private notificationFallbackTimer: NodeJS.Timeout | null = null;
  private notificationFallbackInFlight = false;
  private runnableReconciliation: Promise<void> | null = null;
  private runnableBacklog = false;
  private runnableBacklogRetryTimer: NodeJS.Timeout | null = null;
  private notificationStatus: ThreadRuntimeNotificationStatus = "closed";
  private notificationStatusGeneration = 0;
  private owner: ThreadRunOwner | null = null;
  private shutdownSettlementDeadlineAt: number | null = null;
  private stopped = true;
  private closed = false;

  constructor(options: ThreadRuntimeCoordinatorOptions) {
    this.store = options.store;
    this.resolveDefinition = options.resolveDefinition;
    this.modelCallObserver = options.modelCallObserver;
    this.onEvent = options.onEvent;
    this.shutdownDrainTimeoutMs = options.shutdownDrainTimeoutMs ?? 30_000;
    if (!Number.isInteger(this.shutdownDrainTimeoutMs) || this.shutdownDrainTimeoutMs <= 0) {
      throw new Error("Thread run shutdown drain timeout must be a positive integer.");
    }
    this.scheduler = new ThreadRunScheduler({
      maxConcurrentRuns: options.maxConcurrentRuns,
      shutdownDrainTimeoutMs: this.shutdownDrainTimeoutMs,
      run: (threadId, signal) => this.runUntilIdle(threadId, signal),
      onRunSettled: async (threadId, result) => {
        if (result.outcome === "completed" || result.outcome === "no_claim") {
          await this.reconcileThreadSettlement(
            threadId,
            () => this.store.isThreadRunnable(threadId),
          );
        } else if (result.outcome === "aborted") {
          // Claiming a run consumes the wake bit that admitted it. An abort
          // leaves original inputs pending, so only a fresh durable wake may
          // re-admit them without turning abort into a reclaim loop.
          await this.reconcileThreadSettlement(
            threadId,
            () => this.store.hasPendingWake(threadId),
          );
        }
      },
      onExclusiveSettled: (threadId) => this.reconcileThreadSettlement(
        threadId,
        () => this.store.isThreadRunnable(threadId),
      ),
      onCapacityAvailable: async () => {
        if (this.shouldRefillRunnableBacklog()) {
          await this.reconcileRunnableThreads();
        }
      },
      onError: (threadId, error) => {
        console.error("Thread run failed", {
          threadId,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });
  }

  async resolveThreadRunConfig(
    threadOrId: ThreadRecord | string,
  ): Promise<{
    model: string;
    thinking: ThinkingLevel | undefined;
    inferenceProjection: InferenceProjection | undefined;
  }> {
    const thread = typeof threadOrId === "string"
      ? await this.store.getThread(threadOrId)
      : threadOrId;
    const definition = await this.resolveDefinition(thread);
    return this.resolveModelConfig(definition);
  }

  async submitInput(
    threadId: string,
    payload: ThreadInputPayload,
    mode: ThreadWakeMode = "wake",
    enqueueOptions?: ThreadEnqueueOptions,
  ): Promise<ThreadEnqueueResult> {
    const result = await this.store.enqueueInput(threadId, payload, mode, enqueueOptions);
    if (result.disposition === "duplicate_applied" || result.disposition === "duplicate_discarded") {
      return result;
    }

    if (mode === "wake") {
      this.scheduler.schedule(result.input.threadId);
    }
    return result;
  }

  async submitSessionInput(
    sessionId: string,
    payload: ThreadInputPayload,
    mode: ThreadWakeMode = "wake",
    enqueueOptions?: ThreadEnqueueOptions,
  ): Promise<ThreadEnqueueResult> {
    const result = await this.store.enqueueSessionInput(sessionId, payload, mode, enqueueOptions);
    if (
      mode === "wake"
      && result.disposition !== "duplicate_applied"
      && result.disposition !== "duplicate_discarded"
    ) {
      this.scheduler.schedule(result.input.threadId);
    }
    return result;
  }

  async start(owner: ThreadRunOwner, orphanedRunReason?: string): Promise<void> {
    if (this.closed) {
      throw new Error("Thread runtime coordinator cannot be restarted after shutdown.");
    }
    if (!this.stopped || this.owner) {
      throw new Error("Thread runtime coordinator is already running.");
    }
    this.owner = {...owner};
    this.shutdownSettlementDeadlineAt = null;
    this.stopped = false;
    try {
      await this.recoverOrphanedRuns(orphanedRunReason);
      await this.recoverOrphanedToolJobs();
      this.scheduler.start();
      await this.reconcileRunnableThreads();
      if (this.notificationStatus !== "listening") {
        this.startNotificationFallback();
      }
    } catch (error) {
      await this.stop(error);
      throw error;
    }
  }

  async wake(threadId: string, mode: ThreadWakeMode = "wake"): Promise<void> {
    if (mode === "queue") {
      return;
    }

    await this.store.requestWake(threadId);
    this.scheduler.schedule(threadId);
  }

  async flushQueued(threadId: string): Promise<void> {
    const wokenThreadIds = await this.store.wakePendingInputs(threadId);
    for (const queuedThreadId of wokenThreadIds) {
      this.scheduler.schedule(queuedThreadId);
    }
  }

  async abort(
    threadId: string,
    reason = DEFAULT_THREAD_RUN_ABORT_REASON,
    operationId?: string,
    options: {blocksNewRuns?: boolean} = {},
  ): Promise<boolean> {
    const requestedRun = await this.store.requestRunAbort(threadId, reason, operationId, options);
    if (!requestedRun) {
      return false;
    }

    const active = this.activeSignalsByRun.get(requestedRun.id);
    if (active) {
      this.scheduler.abort(active.threadId, new Error(requestedRun.abortReason ?? reason));
    }
    return true;
  }

  async handleStoreNotification(notification: ThreadRuntimeNotification): Promise<void> {
    if (this.stopped) {
      return;
    }

    if (notification.kind === "thread_changed") {
      this.pulseThreadChange(notification.threadId);
      return;
    }

    if (notification.kind === "thread_runnable") {
      this.pulseThreadChange(notification.threadId);
      this.scheduler.schedule(notification.threadId);
      return;
    }

    const active = this.activeSignalsByRun.get(notification.runId);
    if (!active || active.threadId !== notification.threadId || active.signal.aborted) {
      return;
    }

    // NOTIFY is broadcast to every daemon. Filter by local run ownership before
    // spending a query, then confirm the hint against authoritative durable state.
    try {
      await this.reconcileAbortRequests([notification.runId]);
    } catch (error) {
      // A notification is only a hint. If its confirmation read fails, keep a
      // bounded fallback sweep alive even though LISTEN itself still looks healthy.
      this.startNotificationFallback();
      throw error;
    }
  }

  async handleStoreNotificationStatus(status: ThreadRuntimeNotificationStatus): Promise<void> {
    if (this.closed) {
      return;
    }

    // Listener state callbacks are fire-and-forget and may finish out of order.
    // Only the newest generation may change fallback reconciliation mode.
    const generation = ++this.notificationStatusGeneration;
    this.notificationStatus = status;
    this.pulseAllThreadChanges();
    if (this.stopped) {
      return;
    }

    if (status === "closed") {
      this.stopNotificationFallback();
      return;
    }

    if (status === "reconnecting") {
      this.startNotificationFallback();
      return;
    }

    try {
      await Promise.all([
        this.reconcileAbortRequests([...this.activeSignalsByRun.keys()]),
        this.reconcileRunnableThreads(),
      ]);
      if (
        !this.stopped
        && this.notificationStatusGeneration === generation
        && this.notificationStatus === "listening"
      ) {
        this.stopNotificationFallback();
      }
    } catch (error) {
      if (
        !this.stopped
        && this.notificationStatusGeneration === generation
        && this.notificationStatus === "listening"
      ) {
        this.startNotificationFallback();
      }
      throw error;
    }
  }

  async stop(reason: unknown = new Error("Thread runtime stopped.")): Promise<void> {
    if (this.stopped && !this.owner) {
      return;
    }
    this.shutdownSettlementDeadlineAt ??= Date.now() + this.shutdownDrainTimeoutMs;
    this.stopped = true;
    this.closed = true;
    this.notificationStatus = "closed";
    this.notificationStatusGeneration += 1;
    this.stopNotificationFallback();
    this.stopRunnableBacklogRetry();
    this.runnableBacklog = false;
    this.pulseAllThreadChanges();
    await this.scheduler.stop(reason);
    const reconciliations = Promise.allSettled([
      ...this.abortReconciliations,
      ...(this.runnableReconciliation ? [this.runnableReconciliation] : []),
    ]);
    // These reads are only notification reconciliation. A half-open database
    // query must not defeat the bounded scheduler drain and retain the daemon
    // lease forever during shutdown.
    await withFallbackTimeout(reconciliations, this.shutdownDrainTimeoutMs, () => null);
    this.owner = null;
  }

  async poke(threadId: string): Promise<void> {
    if (!this.stopped) {
      this.scheduler.schedule(threadId);
    }
  }

  async waitForIdle(threadId: string): Promise<void> {
    await this.reconcileRunnableThread(threadId);
    await this.scheduler.waitForIdle(threadId);
  }

  async waitForInputRun(inputId: string): Promise<ThreadRunRecord> {
    while (true) {
      if (this.stopped) {
        throw new Error("Thread runtime stopped while waiting for an input run.");
      }

      const input = await this.store.getInput(inputId);
      if (input.status === "discarded") {
        throw new Error(`Thread input ${inputId} was discarded before execution.`);
      }

      const waiter = this.createThreadChangeWaiter(input.threadId);
      try {
        // Register before the authoritative reads so a commit between the read
        // and wait cannot strand a cross-daemon scheduled-task claim.
        const refreshedInput = await this.store.getInput(inputId);
        if (refreshedInput.status === "discarded") {
          throw new Error(`Thread input ${inputId} was discarded before execution.`);
        }
        if (refreshedInput.appliedRunId) {
          const run = await this.store.getRun(refreshedInput.appliedRunId);
          if (run.status !== "running") {
            return run;
          }
        }

        if (this.notificationStatus === "listening") {
          await waiter.promise;
        } else {
          let timeout: NodeJS.Timeout | undefined;
          try {
            await Promise.race([
              waiter.promise,
              new Promise<void>((resolve) => {
                timeout = setTimeout(resolve, NOTIFICATION_FALLBACK_INTERVAL_MS);
                timeout.unref?.();
              }),
            ]);
          } finally {
            if (timeout) {
              clearTimeout(timeout);
            }
          }
        }
      } finally {
        this.removeThreadChangeWaiter(input.threadId, waiter);
      }
    }
  }

  async waitForCurrentRun(threadId: string): Promise<void> {
    await this.scheduler.waitForCurrent(threadId);
  }

  async isThreadBusy(threadId: string): Promise<boolean> {
    if (this.scheduler.isBusy(threadId)) {
      return true;
    }

    return (await this.store.hasPendingInputs(threadId)) || (await this.store.hasPendingWake(threadId));
  }

  async runExclusively<T>(
    threadId: string,
    fn: (access: ThreadExclusiveAccess) => Promise<T>,
    options: {
      abortActiveReason?: unknown;
      beforeActiveAbort?: () => Promise<void>;
    } = {},
  ): Promise<T> {
    const owner = this.owner;
    if (this.stopped || !owner) {
      throw new Error("Thread runtime is not running.");
    }
    const result = await this.scheduler.runExclusively(
      threadId,
      (signal) => fn({signal, owner}),
      options,
    );
    return result;
  }

  async recoverOrphanedRuns(
    reason = formatOrphanedRunRecoveryReason({ recoveryTrigger: "coordinator_call" }),
  ): Promise<readonly ThreadRunRecord[]> {
    const owner = this.owner;
    if (!owner) {
      throw new Error("Thread runtime has no daemon owner.");
    }
    const recoveredRuns: ThreadRunRecord[] = [];
    while (true) {
      const batch = await this.store.failOrphanedRuns(
        owner,
        reason,
        ORPHANED_RUN_RECOVERY_BATCH_SIZE,
      );
      recoveredRuns.push(...batch);
      if (batch.length < ORPHANED_RUN_RECOVERY_BATCH_SIZE) {
        break;
      }
    }

    return recoveredRuns;
  }

  private async recoverOrphanedToolJobs(): Promise<void> {
    const owner = this.owner;
    if (!owner) {
      throw new Error("Thread runtime has no daemon owner.");
    }
    while (true) {
      const recovered = await this.store.markOrphanedToolJobsLost(
        owner,
        ORPHANED_TOOL_JOB_REASON,
        ORPHANED_TOOL_JOB_RECOVERY_BATCH_SIZE,
      );
      if (recovered < ORPHANED_TOOL_JOB_RECOVERY_BATCH_SIZE) {
        return;
      }
    }
  }

  private async emit(event: ThreadRuntimeEvent): Promise<void> {
    await this.onEvent?.(event);
  }

  private shouldContinueFromBoundary(boundary: ThreadBoundaryState): boolean {
    return boundary.hasAdmittedInputs || boundary.hadPendingWake;
  }

  private async reconcileRunnableThreads(): Promise<void> {
    if (this.stopped) {
      return;
    }
    if (this.runnableReconciliation) {
      return this.runnableReconciliation;
    }

    const reconciliation = (async () => {
      // Fetch one sentinel row beyond the admission batch. The sentinel keeps
      // backlog state explicit without loading an unbounded runnable set.
      const threadIds = await this.store.listRunnableThreadIds(RUNNABLE_RECONCILIATION_BATCH_SIZE + 1);
      if (this.stopped) {
        return;
      }
      const hasMore = threadIds.length > RUNNABLE_RECONCILIATION_BATCH_SIZE;
      // A successful scan supersedes any failure retry that was armed by an
      // older scan. Re-arm only if this result cannot create settling work.
      this.stopRunnableBacklogRetry();
      this.runnableBacklog = hasMore;
      for (const threadId of threadIds.slice(0, RUNNABLE_RECONCILIATION_BATCH_SIZE)) {
        this.scheduler.schedule(threadId, "backlog");
      }
      const snapshot = this.scheduler.getSnapshot();
      if (hasMore && snapshot.active === 0 && snapshot.queued === 0) {
        this.startRunnableBacklogRetry();
      }
    })();
    this.runnableReconciliation = reconciliation;
    try {
      await reconciliation;
    } catch (error) {
      if (this.runnableBacklog) {
        this.startRunnableBacklogRetry();
      }
      throw error;
    } finally {
      if (this.runnableReconciliation === reconciliation) {
        this.runnableReconciliation = null;
      }
    }
  }

  private startRunnableBacklogRetry(): void {
    if (this.stopped || !this.runnableBacklog || this.runnableBacklogRetryTimer) {
      return;
    }
    this.runnableBacklogRetryTimer = setTimeout(() => {
      this.runnableBacklogRetryTimer = null;
      if (this.stopped || !this.runnableBacklog) {
        return;
      }
      runInBackground(
        () => this.reconcileRunnableThreads(),
        {label: "Runnable thread backlog reconciliation"},
      );
    }, RUNNABLE_BACKLOG_RETRY_INTERVAL_MS);
    this.runnableBacklogRetryTimer.unref?.();
  }

  private shouldRefillRunnableBacklog(): boolean {
    if (!this.runnableBacklog || this.runnableBacklogRetryTimer) {
      return false;
    }
    const snapshot = this.scheduler.getSnapshot();
    return snapshot.queued <= snapshot.maxConcurrentRuns;
  }

  private stopRunnableBacklogRetry(): void {
    if (!this.runnableBacklogRetryTimer) {
      return;
    }
    clearTimeout(this.runnableBacklogRetryTimer);
    this.runnableBacklogRetryTimer = null;
  }

  private async reconcileRunnableThread(threadId: string): Promise<void> {
    if (this.stopped) {
      return;
    }
    if (await this.store.isThreadRunnable(threadId)) {
      this.scheduler.schedule(threadId);
    }
  }

  private async reconcileThreadSettlement(
    threadId: string,
    isRunnable: () => Promise<boolean>,
  ): Promise<void> {
    let retryDelayMs = THREAD_SETTLEMENT_RECONCILIATION_INITIAL_RETRY_DELAY_MS;
    while (!this.stopped) {
      try {
        if (await isRunnable()) {
          this.scheduler.schedule(threadId);
        }
        return;
      } catch {
        if (this.stopped) {
          return;
        }
        // A coalesced NOTIFY may already be gone. Keep the lane settling until
        // an authoritative read succeeds; unrelated threads retain capacity.
        await sleep(retryDelayMs);
        retryDelayMs = Math.min(
          retryDelayMs * 2,
          THREAD_SETTLEMENT_RECONCILIATION_MAX_RETRY_DELAY_MS,
        );
      }
    }
  }

  private startNotificationFallback(): void {
    if (this.stopped || this.notificationFallbackTimer) {
      return;
    }

    // NOTIFY is a delivery hint, not durable state. Poll bounded global state
    // while LISTEN is unhealthy or a notification-dependent confirmation is
    // uncertain, then stop after one successful healthy reconciliation.
    this.notificationFallbackTimer = setInterval(() => {
      this.scheduleNotificationFallback();
    }, NOTIFICATION_FALLBACK_INTERVAL_MS);
    this.notificationFallbackTimer.unref?.();
    this.scheduleNotificationFallback();
  }

  private stopNotificationFallback(): void {
    if (!this.notificationFallbackTimer) {
      return;
    }

    clearInterval(this.notificationFallbackTimer);
    this.notificationFallbackTimer = null;
  }

  private scheduleNotificationFallback(): void {
    if (this.notificationFallbackInFlight) {
      return;
    }

    const generation = this.notificationStatusGeneration;
    this.notificationFallbackInFlight = true;
    runInBackground(async () => {
      try {
        await Promise.all([
          this.reconcileAbortRequests([...this.activeSignalsByRun.keys()]),
          this.reconcileRunnableThreads(),
        ]);
        if (
          !this.stopped
          && this.notificationStatusGeneration === generation
          && this.notificationStatus === "listening"
        ) {
          this.stopNotificationFallback();
        }
      } finally {
        this.notificationFallbackInFlight = false;
      }
    }, {label: "Runtime notification fallback reconciliation"});
  }

  private reconcileAbortRequests(runIds: readonly string[]): Promise<void> {
    if (this.stopped || runIds.length === 0) {
      return Promise.resolve();
    }

    const reconciliation = this.loadAbortRequests(runIds);
    this.abortReconciliations.add(reconciliation);
    return reconciliation.then(
      () => {
        this.abortReconciliations.delete(reconciliation);
      },
      (error: unknown) => {
        this.abortReconciliations.delete(reconciliation);
        throw error;
      },
    );
  }

  private createThreadChangeWaiter(threadId: string): ThreadChangeWaiter {
    let resolve!: () => void;
    const waiter: ThreadChangeWaiter = {
      promise: new Promise<void>((resolvePromise) => {
        resolve = resolvePromise;
      }),
      resolve: () => resolve(),
    };
    const waiters = this.changeWaitersByThread.get(threadId) ?? new Set<ThreadChangeWaiter>();
    waiters.add(waiter);
    this.changeWaitersByThread.set(threadId, waiters);
    return waiter;
  }

  private removeThreadChangeWaiter(threadId: string, waiter: ThreadChangeWaiter): void {
    const waiters = this.changeWaitersByThread.get(threadId);
    if (!waiters) {
      return;
    }
    waiters.delete(waiter);
    if (waiters.size === 0) {
      this.changeWaitersByThread.delete(threadId);
    }
  }

  private pulseThreadChange(threadId: string): void {
    const waiters = this.changeWaitersByThread.get(threadId);
    if (!waiters) {
      return;
    }
    this.changeWaitersByThread.delete(threadId);
    for (const waiter of waiters) {
      waiter.resolve();
    }
  }

  private pulseAllThreadChanges(): void {
    for (const threadId of [...this.changeWaitersByThread.keys()]) {
      this.pulseThreadChange(threadId);
    }
  }

  private async loadAbortRequests(runIds: readonly string[]): Promise<void> {
    const abortedRuns = await this.store.listAbortRequestedRuns(runIds);
    for (const run of abortedRuns) {
      const active = this.activeSignalsByRun.get(run.id);
      if (!active || active.threadId !== run.threadId || active.signal.aborted) {
        continue;
      }

      this.scheduler.abort(
        active.threadId,
        new Error(run.abortReason ?? DEFAULT_THREAD_RUN_ABORT_REASON),
      );
    }
  }

  private buildThreadOptions(
    run: ThreadRunRecord,
    definition: ResolvedThreadDefinition,
    messages: readonly ThreadMessageRecord[],
    signal?: AbortSignal,
    resumeState?: ThreadResumeState,
    routeMessages?: readonly ThreadMessageRecord[],
  ): ConstructorParameters<typeof Thread>[0] {
    const modelConfig = this.resolveModelConfig(definition);

    return {
      agent: definition.agent,
      messages: messages.map((entry) => entry.message),
      systemPrompt: definition.systemPrompt,
      maxTurns: definition.maxTurns,
      context: buildRunContextValue(definition.context, messages, run.id, routeMessages),
      llmContexts: definition.llmContexts,
      hooks: definition.hooks,
      promptCacheKey: definition.promptCacheKey,
      runPipelines: definition.runPipelines,
      model: modelConfig.model,
      temperature: definition.temperature,
      thinking: modelConfig.thinking,
      runtime: definition.runtime,
      modelCallObserver: this.modelCallObserver,
      countTokens: definition.countTokens,
      signal,
      resumeState,
      checkpoint: async (checkpoint) => {
        const pendingToolCalls = checkpoint.phase === "after_assistant"
          ? checkpoint.toolCalls
          : checkpoint.remainingToolCalls;

        if (signal?.aborted) {
          const reason = signal.reason instanceof Error
            ? signal.reason.message
            : typeof signal.reason === "string" && signal.reason.trim()
              ? signal.reason
              : DEFAULT_THREAD_RUN_ABORT_REASON;
          return {
            action: "interrupt",
            reason,
            cancelPendingToolCalls: pendingToolCalls.length > 0,
          } as const;
        }
        await this.store.assertRunActive(run.id);
        return { action: "continue" } as const;
      },
    };
  }

  private resolveModelConfig(
    definition: ResolvedThreadDefinition,
  ): {
    model: string;
    thinking: ThinkingLevel | undefined;
    inferenceProjection: InferenceProjection | undefined;
  } {
    const defaultModel = resolveRuntimeDefaultModelSelector();
    return {
      model: definition.model ?? defaultModel,
      thinking: definition.thinking,
      inferenceProjection: definition.inferenceProjection,
    };
  }

  private async setAutoCompactionState(
    thread: ThreadRecord,
    next: AutoCompactionRuntimeState | null,
    runId: string,
  ): Promise<ThreadRecord> {
    const runtimeState = updateAutoCompactionRuntimeState(thread, next);
    return this.store.updateThreadForRun(thread.id, runId, {runtimeState: runtimeState ?? null});
  }

  private async clearAutoCompactionState(thread: ThreadRecord, runId: string): Promise<ThreadRecord> {
    const state = readAutoCompactionRuntimeState(thread);
    if (
      state.consecutiveFailures === 0
      && state.lastFailureReason === undefined
      && state.lastFailureAt === undefined
      && state.cooldownUntil === undefined
      && state.lastAttempt === undefined
    ) {
      return thread;
    }

    return this.setAutoCompactionState(thread, null, runId);
  }

  private async recordAutoCompactionFailure(options: {
    thread: ThreadRecord;
    run: ThreadRunRecord;
    reason: string;
    now: number;
    diagnostics?: CompactThreadError["diagnostics"];
    blocked?: boolean;
  }): Promise<ThreadRecord> {
    const currentState = readAutoCompactionRuntimeState(options.thread);
    const consecutiveFailures = currentState.consecutiveFailures + 1;
    const cooldownUntil = consecutiveFailures >= AUTO_COMPACT_BREAKER_FAILURE_THRESHOLD
      ? options.now + AUTO_COMPACT_BREAKER_COOLDOWN_MS
      : undefined;

    const nextState: AutoCompactionRuntimeState = {
      consecutiveFailures,
      lastFailureReason: options.reason,
      lastFailureAt: options.now,
      cooldownUntil,
      ...(options.diagnostics ? {lastAttempt: options.diagnostics} : {}),
    };

    const updatedThread = await this.setAutoCompactionState(options.thread, nextState, options.run.id);
    await appendCompactionFailureNotice({
      store: this.store,
      threadId: updatedThread.id,
      reason: options.reason,
      consecutiveFailures,
      cooldownUntil,
      runId: options.run.id,
      diagnostics: options.diagnostics,
      blocked: options.blocked,
    });

    return updatedThread;
  }

  private async handleAutoCompactionPreflight(options: {
    run: ThreadRunRecord;
    thread: ThreadRecord;
    definition: ResolvedThreadDefinition;
    transcript: ThreadTranscriptSnapshot;
    allowAttempt: boolean;
    signal: AbortSignal;
  }): Promise<AutoCompactionPreflightResult> {
    let thread = options.thread;
    const now = Date.now();
    const currentState = readAutoCompactionRuntimeState(thread);
    if (currentState.cooldownUntil !== undefined && currentState.cooldownUntil <= now) {
      thread = await this.clearAutoCompactionState(thread, options.run.id);
    }

    const transcriptTokens = estimateTranscriptTokens(options.transcript.records, {
      replayToolArtifacts: true,
    });
    const modelConfig = this.resolveModelConfig(options.definition);
    const budget = resolveModelRuntimeBudget(modelConfig.model);
    const autoCompactCheck = shouldAutoCompactThread({
      thread,
      transcriptTokens,
      compactTriggerTokens: budget.compactTriggerTokens,
      now,
    });
    if (!autoCompactCheck.shouldCompact) {
      if (autoCompactCheck.cooldownUntil === undefined) {
        return { action: "continue", thread };
      }

      // The failure that opened cooldown already wrote a visible notice. Re-appending
      // it on every wake just bloats the transcript that compaction is trying to save.
      return { action: "continue", thread };
    }

    if (!options.allowAttempt) {
      return { action: "continue", thread };
    }

    try {
      await compactThread({
        store: this.store,
        thread,
        transcript: options.transcript,
        model: modelConfig.model,
        thinking: modelConfig.thinking,
        trigger: "auto",
        owningRunId: options.run.id,
        signal: options.signal,
      });

      await this.clearAutoCompactionState(thread, options.run.id);
      return { action: "restart", attemptedAutoCompact: true };
    } catch (error) {
      const reason = stringifyUnknown(error, { preferErrorMessage: true });
      const exceedsHardWindow = transcriptTokens >= budget.hardWindow;
      const updatedThread = await this.recordAutoCompactionFailure({
        thread,
        run: options.run,
        reason,
        now,
        diagnostics: error instanceof CompactThreadError ? error.diagnostics : undefined,
        blocked: exceedsHardWindow,
      });
      if (exceedsHardWindow) {
        throw new ContextWindowExceededError();
      }

      return { action: "continue", thread: updatedThread, attemptedAutoCompact: true };
    }
  }

  private async recoverProviderContextOverflow(options: {
    run: ThreadRunRecord;
    thread: ThreadRecord;
    definition: ResolvedThreadDefinition;
    transcript: ThreadTranscriptSnapshot;
    signal: AbortSignal;
  }): Promise<boolean> {
    const modelConfig = this.resolveModelConfig(options.definition);

    try {
      await compactThread({
        store: this.store,
        thread: options.thread,
        transcript: options.transcript,
        model: modelConfig.model,
        thinking: modelConfig.thinking,
        trigger: "auto",
        owningRunId: options.run.id,
        signal: options.signal,
      });
      await this.clearAutoCompactionState(options.thread, options.run.id);
      return true;
    } catch (error) {
      await this.recordAutoCompactionFailure({
        thread: options.thread,
        run: options.run,
        reason: stringifyUnknown(error, { preferErrorMessage: true }),
        now: Date.now(),
        diagnostics: error instanceof CompactThreadError ? error.diagnostics : undefined,
        blocked: true,
      });
      return false;
    }
  }

  /**
   * Resolve an ambiguous terminal write before releasing process-local
   * serialization. A connection failure can happen after Postgres commits;
   * rereading the row distinguishes that case from a genuinely pending run.
   * While this daemon still owns the run, retrying is the only safe way to
   * avoid leaving a permanent `running` row that blocks every later wake.
   */
  private async settleRun(
    runId: string,
    settlement: {kind: "complete"} | {kind: "fail"; error: string},
  ): Promise<ThreadRunRecord | null> {
    let retryDelayMs = 25;
    let failedAttempts = 0;
    let claimLost = false;

    while (true) {
      const shutdownDeadline = this.shutdownSettlementDeadlineAt;
      if (this.stopped && shutdownDeadline !== null && Date.now() >= shutdownDeadline) {
        return null;
      }

      if (!claimLost) {
        try {
          return settlement.kind === "complete"
            ? await this.store.completeRun(runId)
            : await this.store.failRun(runId, settlement.error);
        } catch (error) {
          claimLost = error instanceof ThreadRunClaimLostError;
        }
      }

      try {
        const observed = await this.store.getRun(runId);
        if (observed.status !== "running") {
          return observed;
        }
        if (claimLost) {
          // The immutable run owner no longer has a live lease. A successor
          // now owns orphan recovery; this process must not mutate the row.
          return null;
        }
      } catch {
        // A read can fail in the same transient outage as the write. Retrying
        // below is bounded by coordinator shutdown and the daemon lease.
      }

      failedAttempts += 1;
      if (failedAttempts === 3 || failedAttempts % 30 === 0) {
        console.error("Thread run terminal settlement is retrying", {
          runId,
          settlement: settlement.kind,
          failedAttempts,
        });
      }
      const remainingShutdownMs = shutdownDeadline === null
        ? Number.POSITIVE_INFINITY
        : Math.max(0, shutdownDeadline - Date.now());
      if (remainingShutdownMs === 0) {
        return null;
      }
      await sleep(Math.min(retryDelayMs, remainingShutdownMs));
      retryDelayMs = Math.min(retryDelayMs * 2, RUN_SETTLEMENT_MAX_RETRY_DELAY_MS);
    }
  }

  private async runUntilIdle(
    threadId: string,
    signal: AbortSignal,
  ): Promise<ThreadRunExecutionResult> {
    const owner = this.owner;
    if (this.stopped || !owner) {
      return {outcome: "stopped"};
    }
    signal.throwIfAborted();
    const run = await this.store.tryStartRun(threadId, owner);
    if (!run) {
      return {outcome: "no_claim"};
    }
    this.activeSignalsByRun.set(run.id, {threadId, signal});

    let finishedRun: ThreadRunRecord | null = null;
    let resumeState: ThreadResumeState | undefined;
    let autoCompactionAttemptedThisRun = false;
    let overflowRecoveryAttemptedThisRun = false;
    // Stop once is a bit too eager for Panda's current autonomy model.
    // Eligible input waves get one blind extra step before we finally let the
    // run go idle. Keep the source denylist small and intentional.
    let idleRerollAvailable = false;

    try {
      // A durable abort can commit before this process registers its controller.
      // Reconcile once at registration so that a missed notification cannot start model work.
      await this.reconcileAbortRequests([run.id]);
      await this.emit({
        type: "run_started",
        threadId,
        run,
      });
      signal.throwIfAborted();

      runLoop: while (true) {
        const appliedInputs = await this.store.applyPendingInputs(threadId, run.id);
        if (appliedInputs.length > 0) {
          // Eligible input waves arm one blind extra step. Suppressed internal
          // inputs may arrive later in the same run; they should not disarm an
          // already-armed human/channel continuation.
          if (appliedInputs.some(grantsIdleReroll)) {
            idleRerollAvailable = true;
          }
          await this.emit({
            type: "inputs_applied",
            threadId,
            runId: run.id,
            messages: appliedInputs,
          });
        }

        const thread = await this.store.getThread(threadId);
        const definition = await this.resolveDefinition(thread);
        const transcript = await this.store.loadActiveTranscript(threadId);
        const preflight = await this.handleAutoCompactionPreflight({
          run,
          thread,
          definition,
          transcript,
          allowAttempt: !autoCompactionAttemptedThisRun,
          signal,
        });
        autoCompactionAttemptedThisRun = autoCompactionAttemptedThisRun || preflight.attemptedAutoCompact === true;
        if (preflight.action === "restart") {
          continue;
        }

        const inferenceProjection = definition.inferenceProjection;
        const projectedTranscript = projectTranscriptForInference(
          transcript.records,
          inferenceProjection
            ? {
                ...inferenceProjection,
                dropImages: undefined,
              }
            : undefined,
        );
        const replayedTranscript = await rehydrateProjectedToolArtifacts(projectedTranscript);
        const finalTranscript = applyImageProjectionForInference(
          replayedTranscript,
          inferenceProjection?.dropImages,
        );
        // The provider call is an external side effect and cannot share a DB
        // transaction with the run. Check immediately before it; all persisted
        // results are fenced again by their own SQL mutations.
        await this.store.assertRunActive(run.id);
        const executor = new Thread(
          this.buildThreadOptions(
            run,
            definition,
            finalTranscript,
            signal,
            resumeState,
            transcript.records,
          ),
        );

        const step = runThreadStep(executor);
        let stepResult: ThreadStepResult | undefined;

        try {
          while (true) {
            const next = await step.next();
            if (next.done) {
              stepResult = next.value;
              break;
            }

            const event = next.value;
            if (isPersistedThreadMessage(event)) {
              await this.store.appendRuntimeMessage(threadId, {
                message: sanitizePersistedMessage(event, definition.agent.tools),
                source: runtimeSourceForMessage(event),
                runId: run.id,
              });
            }

            await this.emit({
              type: "thread_event",
              threadId,
              runId: run.id,
              event,
            });
          }
        } catch (error) {
          const isRecoverableOverflow = error instanceof ProviderRuntimeError
            && error.failureKind === "provider_context_overflow"
            && !overflowRecoveryAttemptedThisRun;
          if (!isRecoverableOverflow) {
            throw error;
          }

          overflowRecoveryAttemptedThisRun = true;
          autoCompactionAttemptedThisRun = true;
          const recovered = await this.recoverProviderContextOverflow({
            run,
            thread,
            definition,
            transcript,
            signal,
          });
          if (recovered) {
            continue runLoop;
          }
          throw error;
        }

        resumeState = stepResult?.resumeState;
        const boundary = await this.store.takeRunBoundary(threadId, run.id);
        const continueForWakeCycle = this.shouldContinueFromBoundary(boundary);
        const continueForThread = stepResult?.needsAnotherTurn ?? false;
        if (continueForThread || continueForWakeCycle) {
          continue;
        }

        if (idleRerollAvailable) {
          // Continuation turns need a real transcript-visible delta. Anthropic
          // happily accepts the step without one, but in practice often returns
          // an empty stop. A machine-generated runtime user message gives the
          // model an explicit continuation event while keeping the source honest.
          idleRerollAvailable = false;
          await this.store.appendRuntimeMessage(threadId, {
            message: stringToUserMessage(renderRuntimeAutonomyContext()),
            source: "runtime",
            runId: run.id,
            metadata: {
              autonomy: {
                kind: "idle_reroll",
              },
            },
          });
          continue;
        }

        if (!continueForThread && !continueForWakeCycle) {
          break;
        }
      }

      finishedRun = await this.settleRun(run.id, {kind: "complete"});
    } catch (error) {
      if (error instanceof ThreadRunClaimLostError) {
        return {outcome: "claim_lost"};
      }
      finishedRun = await this.settleRun(run.id, {
        kind: "fail",
        error: stringifyUnknown(error, {preferErrorMessage: true}),
      });
      if (signal.aborted) {
        return {outcome: finishedRun?.abortRequestedAt !== undefined ? "aborted" : "stopped"};
      }
      throw error;
    } finally {
      if (finishedRun) {
        try {
          await this.emit({
            type: "run_finished",
            threadId,
            run: finishedRun,
          });
        } catch (error) {
          // The terminal mutation already committed. Observer delivery is
          // post-commit and must not erase that durable outcome or suppress
          // final-boundary reconciliation.
          console.error("Thread run-finished observer failed", {
            threadId,
            runId: finishedRun.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      this.activeSignalsByRun.delete(run.id);
    }
    if (finishedRun?.status === "completed") {
      return {outcome: "completed"};
    }
    return {outcome: finishedRun?.abortRequestedAt !== undefined ? "aborted" : "stopped"};
  }
}
