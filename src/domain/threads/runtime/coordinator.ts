import type {Message} from "@mariozechner/pi-ai";

import {runThreadStep, Thread, type ThreadResumeState, type ThreadStepResult} from "../../../kernel/agent/thread.js";
import {stringToUserMessage} from "../../../kernel/agent/helpers/input.js";
import {resolveModelRuntimeBudget} from "../../../kernel/models/model-context-policy.js";
import {resolveRuntimeDefaultModelSelector} from "../../../kernel/models/default-model.js";
import type {ThreadRunEvent} from "../../../kernel/agent/types.js";
import {stringifyUnknown} from "../../../kernel/agent/helpers/stringify.js";
import type {
  AutoCompactionRuntimeState,
  ResolvedThreadDefinition,
  ThreadDefinitionResolver,
  ThreadInputPayload,
  ThreadMessageRecord,
  ThreadRecord,
  ThreadRunRecord,
} from "./types.js";
import type {ThreadInputApplyScope, ThreadRuntimeStore} from "./store.js";
import {
  appendCompactionFailureNotice,
  AUTO_COMPACT_BREAKER_COOLDOWN_MS,
  AUTO_COMPACT_BREAKER_FAILURE_THRESHOLD,
  compactThread,
  CompactThreadError,
  estimateTranscriptTokens,
  projectTranscriptForRun,
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

export type ThreadWakeMode = "wake" | "queue";
const ABORT_POLL_MS = 250;
const LEASE_RETRY_BACKOFF_MS = 250;

export interface ThreadLease {
  threadId: string;
  release(): Promise<void>;
}

export interface ThreadLeaseManager {
  tryAcquire(threadId: string): Promise<ThreadLease | null>;
}

export interface ThreadRuntimeCoordinatorOptions {
  store: ThreadRuntimeStore;
  resolveDefinition: ThreadDefinitionResolver;
  leaseManager: ThreadLeaseManager;
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
  hasRunnableInputs: boolean;
  hadPendingWake: boolean;
}

interface ThreadRunAttemptResult {
  restartRequested: boolean;
  acquiredLease: boolean;
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

function buildCurrentInputContext(
  messages: readonly ThreadMessageRecord[],
): {
  messageId: string;
  source: string;
  channelId?: string;
  externalMessageId?: string;
  actorId?: string;
  identityId?: string;
  metadata?: ThreadMessageRecord["metadata"];
} | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index];
    if (!entry || entry.origin !== "input") {
      continue;
    }
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

  return undefined;
}

function buildRunContextValue(
  baseContext: unknown,
  messages: readonly ThreadMessageRecord[],
  runId?: string,
): unknown {
  const currentInput = buildCurrentInputContext(messages);
  if (!currentInput && runId === undefined) {
    return baseContext;
  }

  if (!isRecord(baseContext)) {
    return {
      ...(currentInput ? { currentInput } : {}),
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
  private readonly leaseManager: ThreadLeaseManager;
  private readonly onEvent?: (event: ThreadRuntimeEvent) => Promise<void> | void;
  private readonly activeRuns = new Map<string, Promise<ThreadRunAttemptResult>>();
  private readonly activeSignals = new Map<string, AbortController>();

  constructor(options: ThreadRuntimeCoordinatorOptions) {
    this.store = options.store;
    this.resolveDefinition = options.resolveDefinition;
    this.leaseManager = options.leaseManager;
    this.onEvent = options.onEvent;
  }

  async resolveThreadRunConfig(
    threadOrId: ThreadRecord | string,
  ): Promise<{
    model: string;
    thinking: ThreadRecord["thinking"];
  }> {
    const thread = typeof threadOrId === "string"
      ? await this.store.getThread(threadOrId)
      : threadOrId;
    const definition = await this.resolveDefinition(thread);
    return this.resolveModelConfig(thread, definition);
  }

  async submitInput(
    threadId: string,
    payload: ThreadInputPayload,
    mode: ThreadWakeMode = "wake",
  ): Promise<void> {
    const result = await this.store.enqueueInput(threadId, payload, mode);
    if (!result.inserted && result.input.appliedAt !== undefined) {
      return;
    }

    if (mode === "queue") {
      return;
    }

    if (this.activeRuns.has(threadId)) {
      return;
    }

    this.ensureRunning(threadId);
  }

  async wake(threadId: string, mode: ThreadWakeMode = "wake"): Promise<void> {
    if (mode === "queue") {
      return;
    }

    await this.store.requestWake(threadId);

    if (!this.activeRuns.has(threadId)) {
      this.ensureRunning(threadId);
    }
  }

  async flushQueued(threadId?: string): Promise<void> {
    const promotedThreadIds = await this.store.promoteQueuedInputs(threadId);
    for (const queuedThreadId of promotedThreadIds) {
      this.ensureRunning(queuedThreadId);
    }
  }

  async abort(threadId: string, reason = "Aborted by runtime request."): Promise<boolean> {
    const requestedRun = await this.store.requestRunAbort(threadId, reason);
    const controller = this.activeSignals.get(threadId);
    if (controller) {
      controller.abort(new Error(reason));
    }

    return requestedRun !== null || controller !== undefined;
  }

  async poke(threadId: string): Promise<void> {
    if (this.activeRuns.has(threadId)) {
      return;
    }

    if (!(await this.store.hasRunnableInputs(threadId)) && !(await this.store.hasPendingWake(threadId))) {
      return;
    }

    const attempt = this.ensureRunning(threadId);
    if (!attempt) {
      return;
    }

    const result = await attempt;
    if (result.acquiredLease) {
      return;
    }

    await this.sleep(LEASE_RETRY_BACKOFF_MS);
    if (!this.activeRuns.has(threadId)
      && ((await this.store.hasRunnableInputs(threadId)) || (await this.store.hasPendingWake(threadId)))) {
      this.ensureRunning(threadId);
    }
  }

  async waitForIdle(threadId: string): Promise<void> {
    while (true) {
      const activeRun = this.activeRuns.get(threadId);
      if (activeRun) {
        const result = await activeRun;
        if (!result.acquiredLease) {
          await this.sleep(LEASE_RETRY_BACKOFF_MS);
        }
        continue;
      }

      if (!(await this.store.hasRunnableInputs(threadId)) && !(await this.store.hasPendingWake(threadId))) {
        return;
      }

      const result = await this.ensureRunning(threadId);
      if (result && !result.acquiredLease) {
        await this.sleep(LEASE_RETRY_BACKOFF_MS);
      }
    }
  }

  async waitForCurrentRun(threadId: string): Promise<void> {
    const activeRun = this.activeRuns.get(threadId);
    if (!activeRun) {
      return;
    }

    await activeRun;
  }

  async isThreadBusy(threadId: string): Promise<boolean> {
    if (this.activeRuns.has(threadId)) {
      return true;
    }

    return (await this.store.hasPendingInputs(threadId)) || (await this.store.hasPendingWake(threadId));
  }

  async runExclusively<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
    const lease = await this.leaseManager.tryAcquire(threadId);
    if (!lease) {
      throw new Error("Thread is already active. Abort or wait before compacting.");
    }

    try {
      return await fn();
    } finally {
      await lease.release();

      if (this.shouldContinueFromBoundary(await this.takeBoundaryState(threadId))) {
        this.ensureRunning(threadId);
      }
    }
  }

  async recoverOrphanedRuns(
    reason = "Run marked failed before recovery.",
  ): Promise<readonly ThreadRunRecord[]> {
    const recoveredRuns: ThreadRunRecord[] = [];
    const runningRuns = await this.store.listRunningRuns();

    for (const run of runningRuns) {
      const lease = await this.leaseManager.tryAcquire(run.threadId);
      if (!lease) {
        continue;
      }

      try {
        const recovered = await this.store.failRunIfRunning(run.id, reason);
        if (recovered) {
          recoveredRuns.push(recovered);
        }
      } finally {
        await lease.release();
      }
    }

    return recoveredRuns;
  }

  private async emit(event: ThreadRuntimeEvent): Promise<void> {
    await this.onEvent?.(event);
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private shouldContinueFromBoundary(boundary: ThreadBoundaryState): boolean {
    return boundary.hasRunnableInputs || boundary.hadPendingWake;
  }

  private async takeBoundaryState(threadId: string): Promise<ThreadBoundaryState> {
    const hasRunnableInputs = await this.store.hasRunnableInputs(threadId);
    const hadPendingWake = await this.store.consumePendingWake(threadId);
    return {
      hasRunnableInputs,
      hadPendingWake,
    };
  }

  private ensureRunning(threadId: string): Promise<ThreadRunAttemptResult> | null {
    if (this.activeRuns.has(threadId)) {
      return null;
    }

    const promise = this.runUntilIdle(threadId)
      .then(async ({restartRequested, acquiredLease}) => {
        this.activeRuns.delete(threadId);
        if (acquiredLease && (restartRequested || this.shouldContinueFromBoundary(await this.takeBoundaryState(threadId)))) {
          this.ensureRunning(threadId);
        }
        return {restartRequested, acquiredLease};
      })
      .catch((error) => {
        this.activeRuns.delete(threadId);
        throw error;
      });

    this.activeRuns.set(threadId, promise);
    void promise.catch(() => {
      // The run already persisted failure state and emitted run_finished; avoid unhandled rejections.
    });
    return promise;
  }

  private startAbortWatcher(run: ThreadRunRecord, controller: AbortController): () => void {
    let closed = false;
    let pollInFlight = false;
    const timer = setInterval(async () => {
      if (closed || pollInFlight || controller.signal.aborted) {
        return;
      }

      pollInFlight = true;

      try {
        const latest = await this.store.getRun(run.id);
        if (latest.status !== "running") {
          clearInterval(timer);
          return;
        }

        if (latest.abortRequestedAt) {
          controller.abort(new Error(latest.abortReason ?? "Aborted by runtime request."));
        }
      } catch {
        // Ignore transient polling failures; the active run will still settle through normal execution paths.
      } finally {
        pollInFlight = false;
      }
    }, ABORT_POLL_MS);

    return () => {
      closed = true;
      clearInterval(timer);
    };
  }

  private buildThreadOptions(
    run: ThreadRunRecord,
    thread: ThreadRecord,
    definition: ResolvedThreadDefinition,
    messages: readonly ThreadMessageRecord[],
    signal?: AbortSignal,
    resumeState?: ThreadResumeState,
  ): ConstructorParameters<typeof Thread>[0] {
    const modelConfig = this.resolveModelConfig(thread, definition);

    return {
      agent: definition.agent,
      messages: messages.map((entry) => entry.message),
      systemPrompt: definition.systemPrompt ?? thread.systemPrompt,
      maxTurns: definition.maxTurns ?? thread.maxTurns,
      context: buildRunContextValue(definition.context ?? thread.context, messages, run.id),
      llmContexts: definition.llmContexts,
      hooks: definition.hooks,
      promptCacheKey: definition.promptCacheKey ?? thread.promptCacheKey,
      runPipelines: definition.runPipelines,
      model: modelConfig.model,
      temperature: definition.temperature ?? thread.temperature,
      thinking: modelConfig.thinking,
      runtime: definition.runtime,
      countTokens: definition.countTokens,
      signal,
      resumeState,
      checkpoint: async (checkpoint) => {
        const pendingToolCalls = checkpoint.phase === "after_assistant"
          ? checkpoint.toolCalls
          : checkpoint.remainingToolCalls;

        const latestRun = await this.store.getRun(run.id);
        if (latestRun.abortRequestedAt) {
          return {
            action: "interrupt",
            reason: latestRun.abortReason ?? "Aborted by runtime request.",
            cancelPendingToolCalls: pendingToolCalls.length > 0,
          } as const;
        }
        return { action: "continue" } as const;
      },
    };
  }

  private resolveModelConfig(
    thread: ThreadRecord,
    definition: ResolvedThreadDefinition,
  ): {
    model: string;
    thinking: ThreadRecord["thinking"];
  } {
    const defaultModel = resolveRuntimeDefaultModelSelector();
    return {
      model: definition.model ?? thread.model ?? defaultModel,
      thinking: definition.thinking ?? thread.thinking,
    };
  }

  private async setAutoCompactionState(
    thread: ThreadRecord,
    next: AutoCompactionRuntimeState | null,
  ): Promise<ThreadRecord> {
    const runtimeState = updateAutoCompactionRuntimeState(thread, next);
    return this.store.updateThread(thread.id, { runtimeState: runtimeState ?? null });
  }

  private async clearAutoCompactionState(thread: ThreadRecord): Promise<ThreadRecord> {
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

    return this.setAutoCompactionState(thread, null);
  }

  private async recordAutoCompactionFailure(options: {
    thread: ThreadRecord;
    run: ThreadRunRecord;
    reason: string;
    now: number;
    diagnostics?: CompactThreadError["diagnostics"];
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

    const updatedThread = await this.setAutoCompactionState(options.thread, nextState);
    await appendCompactionFailureNotice({
      store: this.store,
      threadId: updatedThread.id,
      reason: options.reason,
      consecutiveFailures,
      cooldownUntil,
      runId: options.run.id,
      diagnostics: options.diagnostics,
    });

    return updatedThread;
  }

  private async handleAutoCompactionPreflight(options: {
    run: ThreadRunRecord;
    thread: ThreadRecord;
    definition: ResolvedThreadDefinition;
    transcript: readonly ThreadMessageRecord[];
    allowAttempt: boolean;
  }): Promise<AutoCompactionPreflightResult> {
    let thread = options.thread;
    const now = Date.now();
    const currentState = readAutoCompactionRuntimeState(thread);
    if (currentState.cooldownUntil !== undefined && currentState.cooldownUntil <= now) {
      thread = await this.clearAutoCompactionState(thread);
    }

    const transcriptTokens = estimateTranscriptTokens(options.transcript, {
      replayToolArtifacts: true,
    });
    const modelConfig = this.resolveModelConfig(thread, options.definition);
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
      });

      await this.clearAutoCompactionState(thread);
      return { action: "restart", attemptedAutoCompact: true };
    } catch (error) {
      const reason = stringifyUnknown(error, { preferErrorMessage: true });
      const updatedThread = await this.recordAutoCompactionFailure({
        thread,
        run: options.run,
        reason,
        now,
        diagnostics: error instanceof CompactThreadError ? error.diagnostics : undefined,
      });
      return { action: "continue", thread: updatedThread, attemptedAutoCompact: true };
    }
  }

  private async runUntilIdle(threadId: string): Promise<ThreadRunAttemptResult> {
    const lease = await this.leaseManager.tryAcquire(threadId);
    if (!lease) {
      return {
        restartRequested: false,
        acquiredLease: false,
      };
    }

    const controller = new AbortController();
    this.activeSignals.set(threadId, controller);
    const run = await this.store.createRun(threadId);
    const stopAbortWatcher = this.startAbortWatcher(run, controller);
    await this.emit({
      type: "run_started",
      threadId,
      run,
    });

    let finishedRun: ThreadRunRecord | null = null;
    let restartRequested = false;
    let resumeState: ThreadResumeState | undefined;
    let inputApplyScope: ThreadInputApplyScope = "all";
    let autoCompactionAttemptedThisRun = false;
    const runMessages: ThreadMessageRecord[] = [];
    // Stop once is a bit too eager for Panda's current autonomy model.
    // Eligible input waves get one blind extra step before we finally let the
    // run go idle. Keep the source denylist small and intentional.
    let idleRerollAvailable = false;

    try {
      while (true) {
        const appliedInputs = await this.store.applyPendingInputs(threadId, inputApplyScope);
        if (appliedInputs.length > 0) {
          runMessages.push(...appliedInputs);
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
        const transcript = projectTranscriptForRun(await this.store.loadTranscript(threadId));
        const preflight = await this.handleAutoCompactionPreflight({
          run,
          thread,
          definition,
          transcript,
          allowAttempt: !autoCompactionAttemptedThisRun,
        });
        autoCompactionAttemptedThisRun = autoCompactionAttemptedThisRun || preflight.attemptedAutoCompact === true;
        if (preflight.action === "restart") {
          continue;
        }

        const inferenceProjection = definition.inferenceProjection ?? preflight.thread.inferenceProjection;
        const projectedTranscript = projectTranscriptForInference(
          transcript,
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
        const executor = new Thread(
          this.buildThreadOptions(
            run,
            preflight.thread,
            definition,
            finalTranscript,
            controller.signal,
            resumeState,
          ),
        );

        const step = runThreadStep(executor);
        let stepResult: ThreadStepResult | undefined;

        while (true) {
          const next = await step.next();
          if (next.done) {
            stepResult = next.value;
            break;
          }

          const event = next.value;
          if (isPersistedThreadMessage(event)) {
            const persisted = await this.store.appendRuntimeMessage(threadId, {
              message: sanitizePersistedMessage(event, definition.agent.tools),
              source: runtimeSourceForMessage(event),
              runId: run.id,
            });
            runMessages.push(persisted);
          }

          await this.emit({
            type: "thread_event",
            threadId,
            runId: run.id,
            event,
          });
        }

        resumeState = stepResult?.resumeState;
        const boundary = await this.takeBoundaryState(threadId);
        const continueForWakeCycle = this.shouldContinueFromBoundary(boundary);
        const continueForThread = stepResult?.needsAnotherTurn ?? false;
        if (continueForThread || continueForWakeCycle) {
          inputApplyScope = continueForWakeCycle ? "all" : "runnable";
          continue;
        }

        if (idleRerollAvailable) {
          // Continuation turns need a real transcript-visible delta. Anthropic
          // happily accepts the step without one, but in practice often returns
          // an empty stop. A machine-generated runtime user message gives the
          // model an explicit continuation event while keeping the source honest.
          idleRerollAvailable = false;
          const runtimeMessage = await this.store.appendRuntimeMessage(threadId, {
            message: stringToUserMessage(renderRuntimeAutonomyContext()),
            source: "runtime",
            runId: run.id,
            metadata: {
              autonomy: {
                kind: "idle_reroll",
              },
            },
          });
          runMessages.push(runtimeMessage);
          inputApplyScope = "runnable";
          continue;
        }

        if (!continueForThread && !continueForWakeCycle) {
          break;
        }
      }

      finishedRun = await this.store.completeRun(run.id);
    } catch (error) {
      finishedRun = await this.store.failRunIfRunning(run.id, stringifyUnknown(error, { preferErrorMessage: true }))
        ?? await this.store.getRun(run.id);
      throw error;
    } finally {
      stopAbortWatcher();

      if (finishedRun) {
        await this.emit({
          type: "run_finished",
          threadId,
          run: finishedRun,
        });

      }

      this.activeSignals.delete(threadId);
      await lease.release();
      restartRequested = this.shouldContinueFromBoundary(await this.takeBoundaryState(threadId));
    }

    return {
      restartRequested,
      acquiredLease: true,
    };
  }
}
