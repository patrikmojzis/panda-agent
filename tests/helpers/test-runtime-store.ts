import {randomUUID} from "node:crypto";

import type {IdentityStore} from "../../src/domain/identity/store.js";
import {
  createDefaultIdentityInput,
  type CreateIdentityBindingInput,
  type CreateIdentityInput,
  DEFAULT_IDENTITY_HANDLE,
  DEFAULT_IDENTITY_ID,
  type EnsureIdentityBindingInput,
  type IdentityBindingLookup,
  type IdentityBindingRecord,
  type IdentityRecord,
  normalizeIdentityHandle,
} from "../../src/domain/identity/types.js";
import type {ThreadEnqueueResult, ThreadRuntimeStore} from "../../src/domain/threads/runtime/store.js";
import {
  type CreateThreadBashJobInput,
  type CreateThreadInput,
  matchesThreadInputIdentity,
  missingThreadError,
  type ThreadBashJobRecord,
  type ThreadBashJobUpdate,
  type ThreadInputDeliveryMode,
  type ThreadInputPayload,
  type ThreadInputRecord,
  type ThreadMessageRecord,
  type ThreadRecord,
  type ThreadRunRecord,
  type ThreadRuntimeMessagePayload,
  type ThreadSummaryRecord,
  type ThreadUpdate,
} from "../../src/domain/threads/runtime/types.js";

function cloneRecord<T extends object>(record: T): T {
  return {
    ...record,
  };
}

function missingRunError(runId: string): Error {
  return new Error(`Unknown run ${runId}`);
}

function requiresPostgresError(message: string): Error {
  return new Error(message);
}

interface TestThreadState {
  thread: ThreadRecord;
  nextMessageSequence: number;
  nextInputOrder: number;
  transcript: ThreadMessageRecord[];
  pendingInputs: ThreadInputRecord[];
  pendingWakeAt?: number;
}

export class TestIdentityStore implements IdentityStore {
  private readonly localIdentity: IdentityRecord;

  constructor() {
    const now = Date.now();
    const localIdentity = createDefaultIdentityInput();
    this.localIdentity = {
      ...localIdentity,
      status: localIdentity.status ?? "active",
      handle: normalizeIdentityHandle(localIdentity.handle),
      createdAt: now,
      updatedAt: now,
    };
  }

  async createIdentity(input: CreateIdentityInput): Promise<IdentityRecord> {
    if (input.id === DEFAULT_IDENTITY_ID || normalizeIdentityHandle(input.handle) === DEFAULT_IDENTITY_HANDLE) {
      throw new Error(`Identity ${DEFAULT_IDENTITY_ID} already exists.`);
    }

    throw requiresPostgresError("Persisted identities require Postgres. Pass --db-url or set PANDA_DATABASE_URL.");
  }

  async ensureIdentity(input: CreateIdentityInput): Promise<IdentityRecord> {
    if (input.id === DEFAULT_IDENTITY_ID || normalizeIdentityHandle(input.handle) === DEFAULT_IDENTITY_HANDLE) {
      return cloneRecord(this.localIdentity);
    }

    throw requiresPostgresError("Persisted identities require Postgres. Pass --db-url or set PANDA_DATABASE_URL.");
  }

  async getIdentity(identityId: string): Promise<IdentityRecord> {
    if (identityId !== DEFAULT_IDENTITY_ID) {
      throw new Error(`Unknown identity ${identityId}`);
    }

    return cloneRecord(this.localIdentity);
  }

  async getIdentityByHandle(handle: string): Promise<IdentityRecord> {
    const normalizedHandle = normalizeIdentityHandle(handle);
    if (normalizedHandle !== DEFAULT_IDENTITY_HANDLE) {
      throw requiresPostgresError("Persisted identities require Postgres. Pass --db-url or set PANDA_DATABASE_URL.");
    }

    return cloneRecord(this.localIdentity);
  }

  async listIdentities(): Promise<readonly IdentityRecord[]> {
    return [cloneRecord(this.localIdentity)];
  }

  async createIdentityBinding(_input: CreateIdentityBindingInput): Promise<IdentityBindingRecord> {
    throw requiresPostgresError("Persisted identities require Postgres. Pass --db-url or set PANDA_DATABASE_URL.");
  }

  async ensureIdentityBinding(_input: EnsureIdentityBindingInput): Promise<IdentityBindingRecord> {
    throw requiresPostgresError("Persisted identities require Postgres. Pass --db-url or set PANDA_DATABASE_URL.");
  }

  async resolveIdentityBinding(_lookup: IdentityBindingLookup): Promise<IdentityBindingRecord | null> {
    return null;
  }

  async listIdentityBindings(identityId: string): Promise<readonly IdentityBindingRecord[]> {
    await this.getIdentity(identityId);
    return [];
  }

  async deleteIdentityBinding(_lookup: IdentityBindingLookup): Promise<boolean> {
    throw requiresPostgresError("Persisted identities require Postgres. Pass --db-url or set PANDA_DATABASE_URL.");
  }
}

export interface TestThreadRuntimeStoreOptions {
  identityStore?: IdentityStore;
}

export class TestThreadRuntimeStore implements ThreadRuntimeStore {
  readonly identityStore: IdentityStore;
  private readonly threads = new Map<string, TestThreadState>();
  private readonly runs = new Map<string, ThreadRunRecord>();
  private readonly bashJobs = new Map<string, ThreadBashJobRecord>();

  constructor(options: TestThreadRuntimeStoreOptions = {}) {
    this.identityStore = options.identityStore ?? new TestIdentityStore();
  }

  async createThread(input: CreateThreadInput): Promise<ThreadRecord> {
    if (this.threads.has(input.id)) {
      throw new Error(`Thread ${input.id} already exists.`);
    }

    if (typeof input.sessionId !== "string" || !input.sessionId.trim()) {
      throw new Error("Thread sessionId is required.");
    }

    const now = Date.now();
    const thread: ThreadRecord = {
      id: input.id,
      sessionId: input.sessionId,
      systemPrompt: input.systemPrompt,
      maxTurns: input.maxTurns,
      context: input.context,
      runtimeState: input.runtimeState,
      maxInputTokens: input.maxInputTokens,
      promptCacheKey: input.promptCacheKey,
      model: input.model,
      temperature: input.temperature,
      thinking: input.thinking,
      inferenceProjection: input.inferenceProjection,
      createdAt: now,
      updatedAt: now,
    };

    this.threads.set(input.id, {
      thread,
      nextMessageSequence: 1,
      nextInputOrder: 1,
      transcript: [],
      pendingInputs: [],
    });

    return cloneRecord(thread);
  }

  async getThread(threadId: string): Promise<ThreadRecord> {
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw missingThreadError(threadId);
    }

    return cloneRecord(thread.thread);
  }

  async listThreadSummaries(limit?: number, sessionId?: string): Promise<readonly ThreadSummaryRecord[]> {
    const states = [...this.threads.values()]
      .filter((state) => sessionId === undefined || state.thread.sessionId === sessionId)
      .sort((left, right) => right.thread.updatedAt - left.thread.updatedAt);
    const visibleStates = limit === undefined
      ? states
      : states.slice(0, Math.max(0, limit));

    return visibleStates.map((state) => {
      const transcript = state.transcript;
      return {
        thread: cloneRecord(state.thread),
        messageCount: transcript.length,
        pendingInputCount: state.pendingInputs.length,
        lastMessage: transcript.length > 0
          ? cloneRecord(transcript[transcript.length - 1]!)
          : undefined,
      } satisfies ThreadSummaryRecord;
    });
  }

  async updateThread(threadId: string, update: ThreadUpdate): Promise<ThreadRecord> {
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw missingThreadError(threadId);
    }

    const nextThinking = update.thinking === undefined
      ? thread.thread.thinking
      : update.thinking ?? undefined;
    const nextRuntimeState = update.runtimeState === undefined
      ? thread.thread.runtimeState
      : update.runtimeState ?? undefined;
    const nextInferenceProjection = update.inferenceProjection === undefined
      ? thread.thread.inferenceProjection
      : update.inferenceProjection ?? undefined;
    thread.thread = {
      ...thread.thread,
      ...update,
      thinking: nextThinking,
      runtimeState: nextRuntimeState,
      inferenceProjection: nextInferenceProjection,
      id: thread.thread.id,
      updatedAt: Date.now(),
    };

    return cloneRecord(thread.thread);
  }

  async loadTranscript(threadId: string): Promise<readonly ThreadMessageRecord[]> {
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw missingThreadError(threadId);
    }

    return thread.transcript.map((record) => cloneRecord(record));
  }

  async enqueueInput(
    threadId: string,
    payload: ThreadInputPayload,
    deliveryMode: ThreadInputDeliveryMode = "wake",
  ): Promise<ThreadEnqueueResult> {
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw missingThreadError(threadId);
    }

    if (payload.externalMessageId) {
      const existing = thread.pendingInputs.find((input) => {
        return matchesThreadInputIdentity(input, payload);
      }) ?? thread.transcript.find((message) => {
        return message.origin === "input"
          && matchesThreadInputIdentity(message, payload);
      });

      if (existing) {
        const record = "order" in existing
          ? cloneRecord(existing)
          : {
            id: existing.id,
            threadId: existing.threadId,
            order: existing.sequence,
            deliveryMode,
            message: existing.message,
            metadata: existing.metadata,
            source: existing.source,
            channelId: existing.channelId,
            externalMessageId: existing.externalMessageId,
            actorId: existing.actorId,
            identityId: existing.identityId,
            createdAt: existing.createdAt,
            appliedAt: existing.createdAt,
          } satisfies ThreadInputRecord;
        return {
          input: record,
          inserted: false,
        };
      }
    }

    const input: ThreadInputRecord = {
      id: randomUUID(),
      threadId,
      order: thread.nextInputOrder,
      deliveryMode,
      message: payload.message,
      metadata: payload.metadata,
      source: payload.source,
      channelId: payload.channelId,
      externalMessageId: payload.externalMessageId,
      actorId: payload.actorId,
      identityId: payload.identityId,
      createdAt: Date.now(),
    };

    thread.nextInputOrder += 1;
    thread.thread.updatedAt = Date.now();
    thread.pendingInputs.push(input);
    return {
      input: cloneRecord(input),
      inserted: true,
    };
  }

  async applyPendingInputs(threadId: string): Promise<readonly ThreadMessageRecord[]> {
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw missingThreadError(threadId);
    }

    const appliedAt = Date.now();
    const applied = thread.pendingInputs
      .sort((left, right) => left.order - right.order)
      .map((input) => {
        input.appliedAt = appliedAt;

        const messageRecord: ThreadMessageRecord = {
          id: randomUUID(),
          threadId,
          sequence: thread.nextMessageSequence,
          origin: "input",
          message: input.message,
          metadata: input.metadata,
          source: input.source,
          channelId: input.channelId,
          externalMessageId: input.externalMessageId,
          actorId: input.actorId,
          identityId: input.identityId,
          createdAt: input.createdAt,
        };

        thread.nextMessageSequence += 1;
        thread.transcript.push(messageRecord);
        return cloneRecord(messageRecord);
      });

    thread.pendingInputs = [];
    thread.thread.updatedAt = Date.now();
    return applied;
  }

  async discardPendingInputs(threadId: string): Promise<number> {
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw missingThreadError(threadId);
    }

    const discarded = thread.pendingInputs.length;
    if (discarded === 0) {
      return 0;
    }

    thread.pendingInputs = [];
    thread.thread.updatedAt = Date.now();
    return discarded;
  }

  async hasPendingInputs(threadId: string): Promise<boolean> {
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw missingThreadError(threadId);
    }

    return thread.pendingInputs.length > 0;
  }

  async hasRunnableInputs(threadId: string): Promise<boolean> {
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw missingThreadError(threadId);
    }

    return thread.pendingInputs.some((input) => input.deliveryMode === "wake");
  }

  async hasPendingWake(threadId: string): Promise<boolean> {
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw missingThreadError(threadId);
    }

    return thread.pendingWakeAt !== undefined;
  }

  async promoteQueuedInputs(threadId?: string): Promise<readonly string[]> {
    const promoted = new Set<string>();
    const states = threadId
      ? [this.threads.get(threadId)]
      : [...this.threads.values()];

    for (const state of states) {
      if (!state) {
        if (threadId) {
          throw missingThreadError(threadId);
        }
        continue;
      }

      let changed = false;
      for (const input of state.pendingInputs) {
        if (input.deliveryMode !== "queue") {
          continue;
        }

        input.deliveryMode = "wake";
        changed = true;
      }

      if (changed) {
        state.thread.updatedAt = Date.now();
        promoted.add(state.thread.id);
      }
    }

    return [...promoted];
  }

  async requestWake(threadId: string): Promise<void> {
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw missingThreadError(threadId);
    }

    thread.pendingWakeAt ??= Date.now();
  }

  async consumePendingWake(threadId: string): Promise<boolean> {
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw missingThreadError(threadId);
    }

    const hadPendingWake = thread.pendingWakeAt !== undefined;
    thread.pendingWakeAt = undefined;
    return hadPendingWake;
  }

  async appendRuntimeMessage(
    threadId: string,
    payload: ThreadRuntimeMessagePayload,
  ): Promise<ThreadMessageRecord> {
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw missingThreadError(threadId);
    }

    const record: ThreadMessageRecord = {
      id: randomUUID(),
      threadId,
      sequence: thread.nextMessageSequence,
      origin: payload.origin ?? "runtime",
      message: payload.message,
      metadata: payload.metadata,
      source: payload.source,
      channelId: payload.channelId,
      externalMessageId: payload.externalMessageId,
      actorId: payload.actorId,
      identityId: payload.identityId,
      runId: payload.runId,
      createdAt: payload.createdAt ?? Date.now(),
    };

    thread.nextMessageSequence += 1;
    thread.thread.updatedAt = Date.now();
    thread.transcript.push(record);
    return cloneRecord(record);
  }

  async createRun(threadId: string): Promise<ThreadRunRecord> {
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw missingThreadError(threadId);
    }

    thread.thread.updatedAt = Date.now();

    const run: ThreadRunRecord = {
      id: randomUUID(),
      threadId,
      status: "running",
      startedAt: Date.now(),
    };

    this.runs.set(run.id, run);
    return cloneRecord(run);
  }

  async getRun(runId: string): Promise<ThreadRunRecord> {
    const run = this.runs.get(runId);
    if (!run) {
      throw missingRunError(runId);
    }

    return cloneRecord(run);
  }

  async completeRun(runId: string): Promise<ThreadRunRecord> {
    const run = this.runs.get(runId);
    if (!run) {
      throw missingRunError(runId);
    }

    run.finishedAt = Date.now();
    if (run.abortRequestedAt) {
      run.status = "failed";
      run.error = run.abortReason ?? "Run aborted before completion.";
    } else {
      run.status = "completed";
      run.error = undefined;
    }

    return cloneRecord(run);
  }

  async failRunIfRunning(runId: string, error?: string): Promise<ThreadRunRecord | null> {
    const run = this.runs.get(runId);
    if (!run) {
      throw missingRunError(runId);
    }

    if (run.status !== "running") {
      return null;
    }

    run.status = "failed";
    run.finishedAt = Date.now();
    run.error = error;
    return cloneRecord(run);
  }

  async listRuns(threadId: string): Promise<readonly ThreadRunRecord[]> {
    return [...this.runs.values()]
      .filter((run) => run.threadId === threadId)
      .sort((left, right) => left.startedAt - right.startedAt)
      .map((run) => cloneRecord(run));
  }

  async listRunningRuns(): Promise<readonly ThreadRunRecord[]> {
    return [...this.runs.values()]
      .filter((run) => run.status === "running")
      .sort((left, right) => left.startedAt - right.startedAt)
      .map((run) => cloneRecord(run));
  }

  async createBashJob(input: CreateThreadBashJobInput): Promise<ThreadBashJobRecord> {
    const thread = this.threads.get(input.threadId);
    if (!thread) {
      throw missingThreadError(input.threadId);
    }

    if (this.bashJobs.has(input.id)) {
      throw new Error(`Bash job ${input.id} already exists.`);
    }

    const record: ThreadBashJobRecord = {
      id: input.id,
      threadId: input.threadId,
      runId: input.runId,
      status: input.status ?? "running",
      command: input.command,
      mode: input.mode,
      initialCwd: input.initialCwd,
      startedAt: input.startedAt ?? Date.now(),
      timedOut: input.timedOut ?? false,
      stdout: input.stdout ?? "",
      stderr: input.stderr ?? "",
      stdoutChars: input.stdoutChars ?? 0,
      stderrChars: input.stderrChars ?? 0,
      stdoutTruncated: input.stdoutTruncated ?? false,
      stderrTruncated: input.stderrTruncated ?? false,
      stdoutPersisted: input.stdoutPersisted ?? false,
      stderrPersisted: input.stderrPersisted ?? false,
      stdoutPath: input.stdoutPath,
      stderrPath: input.stderrPath,
      trackedEnvKeys: [...(input.trackedEnvKeys ?? [])],
      statusReason: input.statusReason,
    };

    thread.thread.updatedAt = Date.now();
    this.bashJobs.set(record.id, record);
    return cloneRecord(record);
  }

  async getBashJob(jobId: string): Promise<ThreadBashJobRecord> {
    const record = this.bashJobs.get(jobId);
    if (!record) {
      throw new Error(`Unknown bash job ${jobId}`);
    }

    return cloneRecord(record);
  }

  async listBashJobs(threadId: string): Promise<readonly ThreadBashJobRecord[]> {
    if (!this.threads.has(threadId)) {
      throw missingThreadError(threadId);
    }

    return [...this.bashJobs.values()]
      .filter((job) => job.threadId === threadId)
      .sort((left, right) => left.startedAt - right.startedAt)
      .map((job) => cloneRecord(job));
  }

  async updateBashJob(jobId: string, update: ThreadBashJobUpdate): Promise<ThreadBashJobRecord> {
    const record = this.bashJobs.get(jobId);
    if (!record) {
      throw new Error(`Unknown bash job ${jobId}`);
    }

    const next: ThreadBashJobRecord = {
      ...record,
      ...update,
      finalCwd: update.finalCwd === undefined ? record.finalCwd : update.finalCwd ?? undefined,
      finishedAt: update.finishedAt === undefined ? record.finishedAt : update.finishedAt ?? undefined,
      durationMs: update.durationMs === undefined ? record.durationMs : update.durationMs ?? undefined,
      exitCode: update.exitCode === undefined ? record.exitCode : update.exitCode ?? undefined,
      signal: update.signal === undefined ? record.signal : update.signal ?? undefined,
      stdoutPath: update.stdoutPath === undefined ? record.stdoutPath : update.stdoutPath ?? undefined,
      stderrPath: update.stderrPath === undefined ? record.stderrPath : update.stderrPath ?? undefined,
      trackedEnvKeys: update.trackedEnvKeys === undefined
        ? record.trackedEnvKeys
        : [...(update.trackedEnvKeys ?? [])],
      statusReason: update.statusReason === undefined ? record.statusReason : update.statusReason ?? undefined,
    };

    this.bashJobs.set(jobId, next);
    const thread = this.threads.get(record.threadId);
    if (thread) {
      thread.thread.updatedAt = Date.now();
    }
    return cloneRecord(next);
  }

  async markRunningBashJobsLost(reason = "Panda runtime restarted before the background bash job finished."): Promise<number> {
    let count = 0;
    const finishedAt = Date.now();

    for (const record of this.bashJobs.values()) {
      if (record.status !== "running") {
        continue;
      }

      record.status = "lost";
      record.finishedAt = finishedAt;
      record.durationMs = Math.max(0, finishedAt - record.startedAt);
      record.statusReason = record.statusReason ?? reason;
      const thread = this.threads.get(record.threadId);
      if (thread) {
        thread.thread.updatedAt = finishedAt;
      }
      count += 1;
    }

    return count;
  }

  async listPendingInputs(threadId: string): Promise<readonly ThreadInputRecord[]> {
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw missingThreadError(threadId);
    }

    return [...thread.pendingInputs]
      .sort((left, right) => left.order - right.order)
      .map((input) => cloneRecord(input));
  }

  async requestRunAbort(threadId: string, reason = "Aborted by runtime request."): Promise<ThreadRunRecord | null> {
    const run = [...this.runs.values()]
      .filter((entry) => entry.threadId === threadId && entry.status === "running")
      .sort((left, right) => right.startedAt - left.startedAt)
      .at(0);

    if (!run) {
      return null;
    }

    run.abortRequestedAt = Date.now();
    run.abortReason = reason;
    return cloneRecord(run);
  }
}
