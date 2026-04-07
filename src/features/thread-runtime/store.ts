import { randomUUID } from "node:crypto";

import type {
  CreateThreadInput,
  ThreadInputDeliveryMode,
  ThreadInputPayload,
  ThreadInputRecord,
  ThreadMessageRecord,
  ThreadRunRecord,
  ThreadRunStatus,
  ThreadRuntimeMessagePayload,
  ThreadRecord,
  ThreadSummaryRecord,
  ThreadUpdate,
} from "./types.js";

export interface ThreadEnqueueResult {
  input: ThreadInputRecord;
  inserted: boolean;
}

export interface ThreadRuntimeStore {
  createThread(input: CreateThreadInput): Promise<ThreadRecord>;
  getThread(threadId: string): Promise<ThreadRecord>;
  listThreads(limit?: number): Promise<readonly ThreadRecord[]>;
  listThreadSummaries(limit?: number): Promise<readonly ThreadSummaryRecord[]>;
  updateThread(threadId: string, update: ThreadUpdate): Promise<ThreadRecord>;
  loadTranscript(threadId: string): Promise<readonly ThreadMessageRecord[]>;
  enqueueInput(
    threadId: string,
    payload: ThreadInputPayload,
    deliveryMode?: ThreadInputDeliveryMode,
  ): Promise<ThreadEnqueueResult>;
  applyPendingInputs(threadId: string): Promise<readonly ThreadMessageRecord[]>;
  hasPendingInputs(threadId: string): Promise<boolean>;
  hasRunnableInputs(threadId: string): Promise<boolean>;
  promoteQueuedInputs(threadId?: string): Promise<readonly string[]>;
  appendRuntimeMessage(
    threadId: string,
    payload: ThreadRuntimeMessagePayload,
  ): Promise<ThreadMessageRecord>;
  createRun(threadId: string): Promise<ThreadRunRecord>;
  getRun(runId: string): Promise<ThreadRunRecord>;
  completeRun(runId: string): Promise<ThreadRunRecord>;
  finishRun(
    runId: string,
    status: Exclude<ThreadRunStatus, "running">,
    error?: string,
  ): Promise<ThreadRunRecord>;
  failRunIfRunning(runId: string, error?: string): Promise<ThreadRunRecord | null>;
  listRuns(threadId: string): Promise<readonly ThreadRunRecord[]>;
  listRunningRuns(): Promise<readonly ThreadRunRecord[]>;
  listPendingInputs(threadId: string): Promise<readonly ThreadInputRecord[]>;
  requestRunAbort(threadId: string, reason?: string): Promise<ThreadRunRecord | null>;
}

interface InMemoryThreadState {
  thread: ThreadRecord;
  nextMessageSequence: number;
  nextInputOrder: number;
  transcript: ThreadMessageRecord[];
  pendingInputs: ThreadInputRecord[];
}

function cloneThreadRecord(record: ThreadRecord): ThreadRecord {
  return {
    ...record,
  };
}

function cloneThreadMessageRecord(record: ThreadMessageRecord): ThreadMessageRecord {
  return {
    ...record,
  };
}

function cloneThreadInputRecord(record: ThreadInputRecord): ThreadInputRecord {
  return {
    ...record,
  };
}

function cloneRunRecord(record: ThreadRunRecord): ThreadRunRecord {
  return {
    ...record,
  };
}

function missingThreadError(threadId: string): Error {
  return new Error(`Unknown thread ${threadId}`);
}

function missingRunError(runId: string): Error {
  return new Error(`Unknown run ${runId}`);
}

export class InMemoryThreadRuntimeStore implements ThreadRuntimeStore {
  private readonly threads = new Map<string, InMemoryThreadState>();
  private readonly runs = new Map<string, ThreadRunRecord>();

  async createThread(input: CreateThreadInput): Promise<ThreadRecord> {
    if (this.threads.has(input.id)) {
      throw new Error(`Thread ${input.id} already exists.`);
    }

    const now = Date.now();
    const thread: ThreadRecord = {
      ...input,
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

    return cloneThreadRecord(thread);
  }

  async getThread(threadId: string): Promise<ThreadRecord> {
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw missingThreadError(threadId);
    }

    return cloneThreadRecord(thread.thread);
  }

  async listThreads(limit?: number): Promise<readonly ThreadRecord[]> {
    const records = [...this.threads.values()]
      .map((state) => cloneThreadRecord(state.thread))
      .sort((left, right) => right.updatedAt - left.updatedAt);

    if (limit === undefined) {
      return records;
    }

    return records.slice(0, Math.max(0, limit));
  }

  async listThreadSummaries(limit?: number): Promise<readonly ThreadSummaryRecord[]> {
    const states = [...this.threads.values()]
      .sort((left, right) => right.thread.updatedAt - left.thread.updatedAt);
    const visibleStates = limit === undefined
      ? states
      : states.slice(0, Math.max(0, limit));

    return visibleStates.map((state) => {
      const transcript = state.transcript;
      return {
        thread: cloneThreadRecord(state.thread),
        messageCount: transcript.length,
        pendingInputCount: state.pendingInputs.length,
        lastMessage: transcript.length > 0
          ? cloneThreadMessageRecord(transcript[transcript.length - 1]!)
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
    thread.thread = {
      ...thread.thread,
      ...update,
      thinking: nextThinking,
      id: thread.thread.id,
      updatedAt: Date.now(),
    };

    return cloneThreadRecord(thread.thread);
  }

  async loadTranscript(threadId: string): Promise<readonly ThreadMessageRecord[]> {
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw missingThreadError(threadId);
    }

    return thread.transcript.map((record) => cloneThreadMessageRecord(record));
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
        return input.source === payload.source
          && input.externalMessageId === payload.externalMessageId;
      }) ?? thread.transcript.find((message) => {
        return message.origin === "input"
          && message.source === payload.source
          && message.externalMessageId === payload.externalMessageId;
      });

      if (existing) {
        const record = "order" in existing
          ? cloneThreadInputRecord(existing)
          : {
            id: existing.id,
            threadId: existing.threadId,
            order: existing.sequence,
            deliveryMode,
            message: existing.message,
            source: existing.source,
            channelId: existing.channelId,
            externalMessageId: existing.externalMessageId,
            actorId: existing.actorId,
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
      source: payload.source,
      channelId: payload.channelId,
      externalMessageId: payload.externalMessageId,
      actorId: payload.actorId,
      createdAt: Date.now(),
    };

    thread.nextInputOrder += 1;
    thread.thread.updatedAt = Date.now();
    thread.pendingInputs.push(input);
    return {
      input: cloneThreadInputRecord(input),
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
          source: input.source,
          channelId: input.channelId,
          externalMessageId: input.externalMessageId,
          actorId: input.actorId,
          createdAt: input.createdAt,
        };

        thread.nextMessageSequence += 1;
        thread.transcript.push(messageRecord);
        return cloneThreadMessageRecord(messageRecord);
      });

    thread.pendingInputs = [];
    thread.thread.updatedAt = Date.now();
    return applied;
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
      origin: "runtime",
      message: payload.message,
      source: payload.source,
      channelId: payload.channelId,
      externalMessageId: payload.externalMessageId,
      actorId: payload.actorId,
      runId: payload.runId,
      createdAt: Date.now(),
    };

    thread.nextMessageSequence += 1;
    thread.thread.updatedAt = Date.now();
    thread.transcript.push(record);
    return cloneThreadMessageRecord(record);
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
    return cloneRunRecord(run);
  }

  async getRun(runId: string): Promise<ThreadRunRecord> {
    const run = this.runs.get(runId);
    if (!run) {
      throw missingRunError(runId);
    }

    return cloneRunRecord(run);
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

    return cloneRunRecord(run);
  }

  async finishRun(
    runId: string,
    status: Exclude<ThreadRunStatus, "running">,
    error?: string,
  ): Promise<ThreadRunRecord> {
    const run = this.runs.get(runId);
    if (!run) {
      throw missingRunError(runId);
    }

    run.status = status;
    run.finishedAt = Date.now();
    run.error = error;
    return cloneRunRecord(run);
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
    return cloneRunRecord(run);
  }

  async listRuns(threadId: string): Promise<readonly ThreadRunRecord[]> {
    return [...this.runs.values()]
      .filter((run) => run.threadId === threadId)
      .sort((left, right) => left.startedAt - right.startedAt)
      .map((run) => cloneRunRecord(run));
  }

  async listRunningRuns(): Promise<readonly ThreadRunRecord[]> {
    return [...this.runs.values()]
      .filter((run) => run.status === "running")
      .sort((left, right) => left.startedAt - right.startedAt)
      .map((run) => cloneRunRecord(run));
  }

  async listPendingInputs(threadId: string): Promise<readonly ThreadInputRecord[]> {
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw missingThreadError(threadId);
    }

    return [...thread.pendingInputs]
      .sort((left, right) => left.order - right.order)
      .map((input) => cloneThreadInputRecord(input));
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
    return cloneRunRecord(run);
  }
}
