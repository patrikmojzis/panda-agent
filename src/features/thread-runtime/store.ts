import { randomUUID } from "node:crypto";

import {
  matchesThreadInputIdentity,
  type CreateThreadInput,
  type ThreadInputDeliveryMode,
  type ThreadInputPayload,
  type ThreadInputRecord,
  type ThreadMessageRecord,
  type ThreadRunRecord,
  type ThreadRuntimeMessagePayload,
  type ThreadRecord,
  type ThreadSummaryRecord,
  type ThreadUpdate,
} from "./types.js";
import { InMemoryIdentityStore } from "../identity/in-memory.js";
import { DEFAULT_IDENTITY_ID } from "../identity/types.js";
import type { IdentityStore } from "../identity/store.js";

export interface ThreadEnqueueResult {
  input: ThreadInputRecord;
  inserted: boolean;
}

export interface ThreadRuntimeStore {
  createThread(input: CreateThreadInput): Promise<ThreadRecord>;
  getThread(threadId: string): Promise<ThreadRecord>;
  listThreadSummaries(limit?: number, identityId?: string): Promise<readonly ThreadSummaryRecord[]>;
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

function cloneRecord<T extends object>(record: T): T {
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

export interface InMemoryThreadRuntimeStoreOptions {
  identityStore?: IdentityStore;
}

export class InMemoryThreadRuntimeStore implements ThreadRuntimeStore {
  readonly identityStore: IdentityStore;
  private readonly threads = new Map<string, InMemoryThreadState>();
  private readonly runs = new Map<string, ThreadRunRecord>();

  constructor(options: InMemoryThreadRuntimeStoreOptions = {}) {
    this.identityStore = options.identityStore ?? new InMemoryIdentityStore();
  }

  async createThread(input: CreateThreadInput): Promise<ThreadRecord> {
    if (this.threads.has(input.id)) {
      throw new Error(`Thread ${input.id} already exists.`);
    }

    const identityId = input.identityId ?? DEFAULT_IDENTITY_ID;
    await this.identityStore.getIdentity(identityId);

    const now = Date.now();
    const thread: ThreadRecord = {
      ...input,
      identityId,
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

  async listThreadSummaries(limit?: number, identityId?: string): Promise<readonly ThreadSummaryRecord[]> {
    const states = [...this.threads.values()]
      .filter((state) => identityId === undefined || state.thread.identityId === identityId)
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
    thread.thread = {
      ...thread.thread,
      ...update,
      thinking: nextThinking,
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
          source: input.source,
          channelId: input.channelId,
          externalMessageId: input.externalMessageId,
          actorId: input.actorId,
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
      metadata: payload.metadata,
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
