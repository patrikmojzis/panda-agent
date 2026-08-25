import {randomUUID} from "node:crypto";

import type {IdentityStore} from "../../src/domain/identity/store.js";
import {
    type CreateIdentityBindingInput,
    type CreateIdentityInput,
    type EnsureIdentityBindingInput,
    type IdentityBindingLookup,
    type IdentityBindingRecord,
    type IdentityRecord,
    normalizeIdentityHandle,
} from "../../src/domain/identity/types.js";
import type {
    ThreadEnqueueResult,
    ThreadRuntimeStore,
} from "../../src/domain/threads/runtime/store.js";
import {
    type CreateThreadInput,
    type CreateThreadToolJobInput,
    type ThreadCompactionCommit,
    type ThreadChannelMediaFilter,
    type ThreadChannelMediaRecord,
    type ThreadChannelMessageFilter,
    missingThreadError,
    type ThreadInputDeliveryMode,
    type ThreadEnqueueOptions,
    type ThreadInputPayload,
    type ThreadInputRecord,
    type ThreadPendingInputRecord,
    type ThreadMessageRecord,
    type ThreadRecord,
    type ThreadRunOwner,
    type ThreadRunRecord,
    type ThreadRuntimeMessagePayload,
    type ThreadSummaryRecord,
    type ThreadTranscriptPage,
    type ThreadTranscriptPageOptions,
    type ThreadTranscriptSnapshot,
    type ThreadToolJobRecord,
    type ThreadToolJobUpdate,
    type ThreadRuntimeStateUpdate,
} from "../../src/domain/threads/runtime/types.js";
import type {MediaDescriptor} from "../../src/domain/channels/types.js";
import {resolveChannelRouteTarget} from "../../src/domain/channels/route-target.js";
import {
  hasCompactBoundaryKind,
  isCompactBoundaryRecord,
  projectTranscriptForRun,
} from "../../src/kernel/transcript/checkpoint.js";
import {
  StaleThreadCompactionError,
  ThreadRunClaimLostError,
  ThreadToolJobOwnershipLostError,
} from "../../src/domain/threads/runtime/store.js";

function matchesThreadInputIdentity(
  left: Pick<ThreadInputPayload, "source" | "channelId" | "externalMessageId"> & {connectorKey: string},
  right: Pick<ThreadInputPayload, "source" | "channelId" | "externalMessageId" | "metadata">,
): boolean {
  return left.source === right.source
    && (left.externalMessageId ?? null) === (right.externalMessageId ?? null)
    && (left.channelId ?? null) === (right.channelId ?? null)
    && left.connectorKey === (resolveChannelRouteTarget(right)?.target.connectorKey ?? "");
}

function cloneRecord<T extends object>(record: T): T {
  return {
    ...record,
  };
}

function sameRunOwner(left: ThreadRunOwner | undefined, right: ThreadRunOwner): boolean {
  return left?.source === right.source
    && left.connectorKey === right.connectorKey
    && left.holderId === right.holderId;
}

function readMediaDescriptor(value: unknown): MediaDescriptor | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string"
    || typeof record.source !== "string"
    || typeof record.connectorKey !== "string"
    || typeof record.mimeType !== "string"
    || typeof record.sizeBytes !== "number"
    || typeof record.localPath !== "string"
    || typeof record.createdAt !== "number"
  ) {
    return null;
  }

  return {
    id: record.id,
    source: record.source,
    connectorKey: record.connectorKey,
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
    localPath: record.localPath,
    ...(typeof record.originalFilename === "string" ? {originalFilename: record.originalFilename} : {}),
    ...(typeof record.metadata === "object" && record.metadata !== null && !Array.isArray(record.metadata)
      ? {metadata: record.metadata as MediaDescriptor["metadata"]}
      : {}),
    createdAt: record.createdAt,
  };
}

function readMessageMedia(record: ThreadMessageRecord, source: string): readonly MediaDescriptor[] {
  const metadata = record.metadata;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    return [];
  }

  const sourceMetadata = (metadata as Record<string, unknown>)[source];
  if (typeof sourceMetadata !== "object" || sourceMetadata === null || Array.isArray(sourceMetadata)) {
    return [];
  }

  const media = (sourceMetadata as {media?: unknown}).media;
  if (!Array.isArray(media)) {
    return [];
  }

  return media.flatMap((entry) => {
    const descriptor = readMediaDescriptor(entry);
    return descriptor ? [descriptor] : [];
  });
}

function missingRunError(runId: string): Error {
  return new Error(`Unknown run ${runId}`);
}

function requiresPostgresError(message: string): Error {
  return new Error(message);
}

export const TEST_IDENTITY_ID = "test-user";
export const TEST_IDENTITY_HANDLE = "test-user";

interface TestThreadState {
  thread: ThreadRecord;
  nextMessageSequence: number;
  nextInputOrder: number;
  transcript: ThreadMessageRecord[];
  pendingInputs: TestStoredInput[];
  pendingWakeAt?: number;
  pendingWakeGeneration: number;
}

function armPendingWake(state: TestThreadState): void {
  state.pendingWakeAt = Date.now();
  state.pendingWakeGeneration += 1;
}

interface TestStoredInput extends ThreadInputRecord {
  message?: ThreadInputPayload["message"];
  metadata?: ThreadInputPayload["metadata"];
}

function inputState(input: TestStoredInput): ThreadInputRecord {
  const {message: _message, metadata: _metadata, ...record} = input;
  return cloneRecord(record);
}

export class TestIdentityStore implements IdentityStore {
  private readonly testIdentity: IdentityRecord;

  constructor() {
    const now = Date.now();
    this.testIdentity = {
      id: TEST_IDENTITY_ID,
      handle: TEST_IDENTITY_HANDLE,
      displayName: "Test User",
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
  }

  async createIdentity(input: CreateIdentityInput): Promise<IdentityRecord> {
    if (input.id === TEST_IDENTITY_ID || normalizeIdentityHandle(input.handle) === TEST_IDENTITY_HANDLE) {
      throw new Error(`Identity ${TEST_IDENTITY_ID} already exists.`);
    }

    throw requiresPostgresError("Persisted identities require Postgres. Pass --db-url or set DATABASE_URL.");
  }

  async ensureIdentity(input: CreateIdentityInput): Promise<IdentityRecord> {
    if (input.id === TEST_IDENTITY_ID || normalizeIdentityHandle(input.handle) === TEST_IDENTITY_HANDLE) {
      return cloneRecord(this.testIdentity);
    }

    throw requiresPostgresError("Persisted identities require Postgres. Pass --db-url or set DATABASE_URL.");
  }

  async getIdentity(identityId: string): Promise<IdentityRecord> {
    if (identityId !== TEST_IDENTITY_ID) {
      throw new Error(`Unknown identity ${identityId}`);
    }

    return cloneRecord(this.testIdentity);
  }

  async getIdentityByHandle(handle: string): Promise<IdentityRecord> {
    const normalizedHandle = normalizeIdentityHandle(handle);
    if (normalizedHandle !== TEST_IDENTITY_HANDLE) {
      throw requiresPostgresError("Persisted identities require Postgres. Pass --db-url or set DATABASE_URL.");
    }

    return cloneRecord(this.testIdentity);
  }

  async listIdentities(): Promise<readonly IdentityRecord[]> {
    return [cloneRecord(this.testIdentity)];
  }

  async createIdentityBinding(_input: CreateIdentityBindingInput): Promise<IdentityBindingRecord> {
    throw requiresPostgresError("Persisted identities require Postgres. Pass --db-url or set DATABASE_URL.");
  }

  async ensureIdentityBinding(_input: EnsureIdentityBindingInput): Promise<IdentityBindingRecord> {
    throw requiresPostgresError("Persisted identities require Postgres. Pass --db-url or set DATABASE_URL.");
  }

  async resolveIdentityBinding(_lookup: IdentityBindingLookup): Promise<IdentityBindingRecord | null> {
    return null;
  }

  async listIdentityBindings(identityId: string): Promise<readonly IdentityBindingRecord[]> {
    await this.getIdentity(identityId);
    return [];
  }

  async deleteIdentityBinding(_lookup: IdentityBindingLookup): Promise<boolean> {
    throw requiresPostgresError("Persisted identities require Postgres. Pass --db-url or set DATABASE_URL.");
  }
}

export interface TestThreadRuntimeStoreOptions {
  identityStore?: IdentityStore;
}

export class TestThreadRuntimeStore implements ThreadRuntimeStore {
  readonly identityStore: IdentityStore;
  private readonly threads = new Map<string, TestThreadState>();
  private readonly currentThreadBySession = new Map<string, string>();
  private readonly inputs = new Map<string, TestStoredInput>();
  private readonly runs = new Map<string, ThreadRunRecord>();
  private readonly abortOperations = new Map<string, {threadId: string; runId?: string; reason: string}>();
  private readonly toolJobs = new Map<string, ThreadToolJobRecord>();
  private currentOwner: ThreadRunOwner | null = null;

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
      replacesThreadId: input.replacesThreadId,
      runtimeState: input.runtimeState,
      createdAt: now,
      updatedAt: now,
    };

    this.threads.set(input.id, {
      thread,
      nextMessageSequence: 1,
      nextInputOrder: 1,
      transcript: [],
      pendingInputs: [],
      pendingWakeGeneration: 0,
    });
    this.currentThreadBySession.set(input.sessionId, input.id);

    return cloneRecord(thread);
  }

  async getThread(threadId: string): Promise<ThreadRecord> {
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw missingThreadError(threadId);
    }

    return cloneRecord(thread.thread);
  }

  async getMessage(messageId: string): Promise<ThreadMessageRecord | null> {
    const record = [...this.threads.values()]
      .flatMap((state) => state.transcript)
      .find((candidate) => candidate.id === messageId);
    return record ? cloneRecord(record) : null;
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

  async loadActiveTranscript(threadId: string): Promise<ThreadTranscriptSnapshot> {
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw missingThreadError(threadId);
    }

    const records = projectTranscriptForRun(thread.transcript).map((record) => cloneRecord(record));
    const checkpoint = records.find(isCompactBoundaryRecord);
    return {
      checkpointId: checkpoint?.id ?? null,
      records,
    };
  }

  async listTranscriptPage(
    threadId: string,
    options: ThreadTranscriptPageOptions = {},
  ): Promise<ThreadTranscriptPage> {
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw missingThreadError(threadId);
    }

    const limit = Math.max(1, Math.min(options.limit ?? 200, 500));
    const beforeSequence = options.beforeSequence;
    const afterSequence = options.afterSequence;
    if (beforeSequence !== undefined && afterSequence !== undefined) {
      throw new Error("Transcript pages cannot seek before and after a sequence at the same time.");
    }
    if (beforeSequence !== undefined && (!Number.isSafeInteger(beforeSequence) || beforeSequence <= 0)) {
      throw new Error("Transcript before cursor must be a positive safe integer.");
    }
    if (afterSequence !== undefined && (!Number.isSafeInteger(afterSequence) || afterSequence < 0)) {
      throw new Error("Transcript after cursor must be a non-negative safe integer.");
    }

    if (afterSequence !== undefined) {
      const candidates = thread.transcript.filter((record) => record.sequence > afterSequence);
      const hasMore = candidates.length > limit;
      const records = candidates.slice(0, limit).map((record) => cloneRecord(record));
      return {
        records,
        ...(hasMore && records.at(-1) ? {nextAfterSequence: records.at(-1)!.sequence} : {}),
      };
    }

    const candidates = beforeSequence === undefined
      ? thread.transcript
      : thread.transcript.filter((record) => record.sequence < beforeSequence);
    const hasMore = candidates.length > limit;
    const records = candidates.slice(-limit).map((record) => cloneRecord(record));
    return {
      records,
      ...(hasMore && records[0] ? {nextBeforeSequence: records[0].sequence} : {}),
    };
  }

  async commitCompaction(
    threadId: string,
    commit: ThreadCompactionCommit,
  ): Promise<ThreadMessageRecord> {
    if (!commit.runId) {
      throw new Error("Manual compaction must use commitCompactionExclusively().");
    }
    await this.assertRunActive(commit.runId);
    if (this.runs.get(commit.runId)?.threadId !== threadId) {
      throw new ThreadRunClaimLostError(commit.runId);
    }
    return this.commitCompactionRecord(threadId, commit);
  }

  private async commitCompactionRecord(
    threadId: string,
    commit: ThreadCompactionCommit,
  ): Promise<ThreadMessageRecord> {
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw missingThreadError(threadId);
    }

    if (commit.id) {
      const replay = [...this.threads.values()]
        .flatMap((state) => state.transcript)
        .find((record) => record.id === commit.id);
      if (replay) {
        if (replay.threadId !== threadId || replay.source !== "compact") {
          throw new Error(`Compaction operation ${commit.id} conflicts with another message.`);
        }
        return cloneRecord(replay);
      }
    }

    const checkpoint = thread.transcript.findLast(isCompactBoundaryRecord);
    if ((checkpoint?.id ?? null) !== commit.expectedCheckpointId) {
      throw new StaleThreadCompactionError(threadId);
    }
    const record: ThreadMessageRecord = {
      id: commit.id ?? randomUUID(),
      threadId,
      sequence: thread.nextMessageSequence,
      origin: "runtime",
      source: "compact",
      message: commit.message,
      metadata: commit.metadata,
      runId: commit.runId,
      createdAt: commit.createdAt ?? Date.now(),
    };
    thread.nextMessageSequence += 1;
    thread.thread.updatedAt = Date.now();
    thread.transcript.push(record);
    return cloneRecord(record);
  }

  async commitCompactionExclusively(
    threadId: string,
    commit: ThreadCompactionCommit,
    _owner: ThreadRunOwner,
  ): Promise<ThreadMessageRecord> {
    if (commit.runId) {
      throw new Error("Run-owned compaction must use commitCompaction().");
    }
    return this.commitCompactionRecord(threadId, commit);
  }

  /** Test-only full history read; production callers must use bounded pages. */
  async loadTranscriptHistory(threadId: string): Promise<readonly ThreadMessageRecord[]> {
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw missingThreadError(threadId);
    }

    return thread.transcript.map((record) => cloneRecord(record));
  }

  async listChannelMessages(filter: ThreadChannelMessageFilter): Promise<readonly ThreadMessageRecord[]> {
    return [...this.threads.values()]
      .filter((state) => state.thread.sessionId === filter.sessionId)
      .flatMap((state) => state.transcript)
      .filter((record) => {
        const metadata = record.metadata;
        const route = metadata && typeof metadata === "object" && !Array.isArray(metadata)
          ? (metadata as {route?: unknown}).route
          : undefined;
        const connectorKey = route && typeof route === "object" && !Array.isArray(route)
          ? (route as {connectorKey?: unknown}).connectorKey
          : undefined;
        return record.source === filter.source
          && record.channelId === filter.channelId
          && connectorKey === filter.connectorKey;
      })
      .sort((left, right) => right.createdAt - left.createdAt || right.sequence - left.sequence)
      .slice(0, Math.max(0, Math.min(filter.limit ?? 50, 200)))
      .map((record) => cloneRecord(record));
  }

  async findChannelMedia(filter: ThreadChannelMediaFilter): Promise<ThreadChannelMediaRecord | null> {
    const messages = await this.listChannelMessages({
      sessionId: filter.sessionId,
      source: filter.source,
      connectorKey: filter.connectorKey,
      channelId: filter.channelId,
      limit: 200,
    });

    for (const message of messages) {
      const media = readMessageMedia(message, filter.source).find((descriptor) => {
        return descriptor.id === filter.mediaId
          && descriptor.source === filter.source
          && descriptor.connectorKey === filter.connectorKey;
      });
      if (media) {
        return {
          message,
          media,
        };
      }
    }

    return null;
  }

  async enqueueInput(
    threadId: string,
    payload: ThreadInputPayload,
    deliveryMode: ThreadInputDeliveryMode = "wake",
    options: ThreadEnqueueOptions = {},
  ): Promise<ThreadEnqueueResult> {
    const thread = this.threads.get(threadId);
    if (!thread || this.currentThreadBySession.get(thread.thread.sessionId) !== threadId) {
      throw missingThreadError(threadId);
    }

    const connectorKey = resolveChannelRouteTarget(payload)?.target.connectorKey ?? "";
    const existingById = options.inputId ? this.inputs.get(options.inputId) : undefined;
    if (existingById) {
      const existingThread = this.threads.get(existingById.threadId);
      if (
        !existingThread
        || existingThread.thread.sessionId !== thread.thread.sessionId
        || !matchesThreadInputIdentity(existingById, payload)
      ) {
        throw new Error(`Thread input conflict for ${existingById.id} did not resolve to a durable input.`);
      }
    }
    const existing = existingById
      ?? (payload.externalMessageId
        ? [...this.inputs.values()].find((input) => {
          return input.threadId === threadId && matchesThreadInputIdentity(input, payload);
        })
        : undefined);
    if (existing) {
      if (existing.status === "pending" && existing.deliveryMode === "queue" && deliveryMode === "wake") {
        existing.deliveryMode = "wake";
      }
      if (existing.status === "pending" && deliveryMode === "wake") {
        armPendingWake(thread);
      }
      return {
        input: inputState(existing),
        disposition: existing.status === "pending"
          ? "duplicate_pending"
          : existing.status === "applied"
            ? "duplicate_applied"
            : "duplicate_discarded",
      };
    }

    const input: TestStoredInput = {
      id: options.inputId ?? randomUUID(),
      threadId,
      order: thread.nextInputOrder,
      deliveryMode,
      status: "pending",
      connectorKey,
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
    if (deliveryMode === "wake") {
      armPendingWake(thread);
    }
    this.inputs.set(input.id, input);
    return {
      input: inputState(input),
      disposition: "inserted",
    };
  }

  async enqueueSessionInput(
    sessionId: string,
    payload: ThreadInputPayload,
    deliveryMode: ThreadInputDeliveryMode = "wake",
    options: ThreadEnqueueOptions = {},
  ): Promise<ThreadEnqueueResult> {
    const threadId = this.currentThreadBySession.get(sessionId);
    if (!threadId) {
      throw new Error(`Unknown session ${sessionId}.`);
    }
    return this.enqueueInput(threadId, payload, deliveryMode, options);
  }

  private async applyMatchingPendingInputs(
    threadId: string,
    runId: string,
    shouldApply: (input: TestStoredInput) => boolean,
  ): Promise<readonly ThreadMessageRecord[]> {
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw missingThreadError(threadId);
    }

    await this.assertRunActive(runId);
    const run = this.runs.get(runId);
    if (run?.threadId !== threadId) {
      throw new ThreadRunClaimLostError(runId);
    }

    const appliedAt = Date.now();
    const matchingInputs = thread.pendingInputs
      .filter((input) => shouldApply(input))
      .sort((left, right) => left.order - right.order)
      .slice(0, 500)
      .map((input) => {
        if (!input.message) {
          throw new Error(`Pending thread input ${input.id} is missing its message payload.`);
        }
        const message = input.message;
        const metadata = input.metadata;
        input.status = "applied";
        input.appliedAt = appliedAt;
        input.appliedRunId = runId;
        input.admittedRunId = undefined;
        input.message = undefined;
        input.metadata = undefined;

        const messageRecord: ThreadMessageRecord = {
          id: input.id,
          inputId: input.id,
          threadId,
          sequence: thread.nextMessageSequence,
          origin: "input",
          message,
          metadata,
          source: input.source,
          channelId: input.channelId,
          externalMessageId: input.externalMessageId,
          actorId: input.actorId,
          identityId: input.identityId,
          runId,
          createdAt: input.createdAt,
        };

        thread.nextMessageSequence += 1;
        thread.transcript.push(messageRecord);
        return cloneRecord(messageRecord);
      });

    if (matchingInputs.length === 0) {
      return [];
    }

    thread.pendingInputs = thread.pendingInputs.filter((input) => input.status === "pending");
    if (thread.pendingInputs.length === 0) {
      thread.pendingWakeAt = undefined;
    }
    thread.thread.updatedAt = Date.now();
    return matchingInputs;
  }

  async applyPendingInputs(
    threadId: string,
    runId: string,
  ): Promise<readonly ThreadMessageRecord[]> {
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw missingThreadError(threadId);
    }
    await this.assertRunActive(runId);
    if (this.runs.get(runId)?.threadId !== threadId) {
      throw new ThreadRunClaimLostError(runId);
    }
    if (
      thread.pendingWakeAt !== undefined
      || thread.pendingInputs.some((input) => input.deliveryMode === "wake")
    ) {
      thread.pendingWakeAt = undefined;
      for (const input of thread.pendingInputs) {
        input.deliveryMode = "queue";
        input.admittedRunId = runId;
      }
    }
    return this.applyMatchingPendingInputs(
      threadId,
      runId,
      (input) => input.admittedRunId === runId,
    );
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

    const discardedAt = Date.now();
    for (const input of thread.pendingInputs) {
      input.status = "discarded";
      input.discardedAt = discardedAt;
      input.admittedRunId = undefined;
      input.message = undefined;
      input.metadata = undefined;
    }
    thread.pendingInputs = [];
    thread.thread.updatedAt = Date.now();
    return discarded;
  }

  async getInput(inputId: string): Promise<ThreadInputRecord> {
    const input = this.inputs.get(inputId);
    if (!input) {
      throw new Error(`Unknown thread input ${inputId}`);
    }
    return inputState(input);
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

  async isThreadRunnable(threadId: string): Promise<boolean> {
    const current = this.currentThreadBySession.get((await this.getThread(threadId)).sessionId);
    if (current !== threadId) {
      return false;
    }
    const running = [...this.runs.values()].some((run) => {
      return run.threadId === threadId && run.status === "running";
    });
    return !running && (await this.hasRunnableInputs(threadId) || await this.hasPendingWake(threadId));
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
      if (this.currentThreadBySession.get(state.thread.sessionId) !== state.thread.id) {
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
        armPendingWake(state);
        promoted.add(state.thread.id);
      }
    }

    return [...promoted];
  }

  async requestWake(threadId: string): Promise<void> {
    const thread = this.threads.get(threadId);
    if (!thread || this.currentThreadBySession.get(thread.thread.sessionId) !== threadId) {
      throw missingThreadError(threadId);
    }

    armPendingWake(thread);
  }

  async appendRuntimeMessage(
    threadId: string,
    payload: ThreadRuntimeMessagePayload,
  ): Promise<ThreadMessageRecord> {
    if (hasCompactBoundaryKind(payload.metadata)) {
      throw new Error("Compact boundaries must be persisted with commitCompaction().");
    }
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw missingThreadError(threadId);
    }
    if (payload.runId) {
      await this.assertRunActive(payload.runId);
      const run = this.runs.get(payload.runId);
      if (run?.threadId !== threadId) {
        throw new ThreadRunClaimLostError(payload.runId);
      }
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
      owner: {source: "test", connectorKey: "fixture", holderId: "fixture"},
      status: "running",
      startedAt: Date.now(),
    };

    this.runs.set(run.id, run);
    return cloneRecord(run);
  }

  async tryStartRun(threadId: string, owner: ThreadRunOwner): Promise<ThreadRunRecord | null> {
    const thread = await this.getThread(threadId);
    if (this.currentThreadBySession.get(thread.sessionId) !== threadId) {
      return null;
    }
    if (this.currentOwner && !sameRunOwner(this.currentOwner, owner)) {
      return null;
    }
    if ([...this.runs.values()].some((run) => run.threadId === threadId && run.status === "running")) {
      return null;
    }
    if (!await this.hasRunnableInputs(threadId) && !await this.hasPendingWake(threadId)) {
      return null;
    }
    // Mirrors the PostgreSQL claim boundary. Admission identity survives an
    // abort, so a later wake can re-admit only that dormant set without
    // sweeping unrelated queue-only input into the run.
    const state = this.threads.get(threadId)!;
    state.pendingWakeAt = undefined;
    const run = await this.createRun(threadId);
    const stored = this.runs.get(run.id)!;
    stored.owner = {...owner};
    for (const input of state.pendingInputs) {
      input.deliveryMode = "queue";
      input.admittedRunId = run.id;
    }
    return cloneRecord(stored);
  }

  async assertRunActive(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (
      !run
      || run.status !== "running"
      || !run.owner
      || (this.currentOwner !== null && !sameRunOwner(run.owner, this.currentOwner))
    ) {
      throw new ThreadRunClaimLostError(runId);
    }
  }

  async updateThreadForRun(
    threadId: string,
    runId: string,
    update: ThreadRuntimeStateUpdate,
  ): Promise<ThreadRecord> {
    await this.assertRunActive(runId);
    if (this.runs.get(runId)?.threadId !== threadId) {
      throw new ThreadRunClaimLostError(runId);
    }
    const state = this.threads.get(threadId);
    if (!state) {
      throw missingThreadError(threadId);
    }
    state.thread = {
      ...state.thread,
      runtimeState: update.runtimeState === undefined
        ? state.thread.runtimeState
        : update.runtimeState ?? undefined,
      updatedAt: Date.now(),
    };
    return cloneRecord(state.thread);
  }

  async getRun(runId: string): Promise<ThreadRunRecord> {
    const run = this.runs.get(runId);
    if (!run) {
      throw missingRunError(runId);
    }

    return cloneRecord(run);
  }

  async listAbortRequestedRuns(runIds: readonly string[]): Promise<readonly ThreadRunRecord[]> {
    const requestedIds = new Set(runIds);
    return [...this.runs.values()]
      .filter((run) => (
        requestedIds.has(run.id)
        && run.abortRequestedAt !== undefined
      ))
      .sort((left, right) => left.startedAt - right.startedAt)
      .map((run) => cloneRecord(run));
  }

  async completeRun(runId: string): Promise<ThreadRunRecord> {
    await this.assertRunActive(runId);
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

  async failRun(runId: string, error?: string): Promise<ThreadRunRecord> {
    await this.assertRunActive(runId);
    const run = this.runs.get(runId);
    if (!run) {
      throw missingRunError(runId);
    }
    if (run.abortRequestedAt === undefined) {
      const thread = this.threads.get(run.threadId);
      const admitted = thread?.pendingInputs.filter((input) => input.admittedRunId === run.id) ?? [];
      if (thread && admitted.length > 0) {
        for (const input of admitted) {
          input.deliveryMode = "wake";
          input.admittedRunId = undefined;
        }
        armPendingWake(thread);
      }
    }

    run.status = "failed";
    run.finishedAt = Date.now();
    run.error = error;
    return cloneRecord(run);
  }

  /** Test-fixture helper for constructing historical terminal runs. */
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

  async failOrphanedRuns(
    owner: ThreadRunOwner,
    error: string,
    limit: number,
  ): Promise<readonly ThreadRunRecord[]> {
    this.currentOwner = {...owner};
    const orphaned = [...this.runs.values()]
      .filter((run) => run.status === "running" && !sameRunOwner(run.owner, owner))
      .sort((left, right) => left.startedAt - right.startedAt)
      .slice(0, limit);
    for (const run of orphaned) {
      const thread = this.threads.get(run.threadId);
      const admitted = thread?.pendingInputs.filter((input) => input.admittedRunId === run.id) ?? [];
      if (thread && admitted.length > 0) {
        for (const input of admitted) {
          input.deliveryMode = "wake";
          input.admittedRunId = undefined;
        }
        armPendingWake(thread);
      }
      run.status = "failed";
      run.finishedAt = Date.now();
      run.error = error;
    }
    return orphaned.map(cloneRecord);
  }

  async listRunnableThreadIds(limit: number): Promise<readonly string[]> {
    const runnable: string[] = [];
    for (const threadId of this.threads.keys()) {
      if (await this.isThreadRunnable(threadId)) {
        runnable.push(threadId);
      }
      if (runnable.length >= limit) {
        break;
      }
    }
    return runnable;
  }

  async takeRunBoundary(
    threadId: string,
    runId: string,
  ): Promise<{hasRunnableInputs: boolean; hasAdmittedInputs: boolean; hadPendingWake: boolean}> {
    await this.assertRunActive(runId);
    if (this.runs.get(runId)?.threadId !== threadId) {
      throw new ThreadRunClaimLostError(runId);
    }
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw missingThreadError(threadId);
    }
    const hadPendingWake = thread.pendingWakeAt !== undefined;
    const hasVisibleWakeInput = thread.pendingInputs.some((input) => input.deliveryMode === "wake");
    thread.pendingWakeAt = undefined;
    if (hadPendingWake || hasVisibleWakeInput) {
      for (const input of thread.pendingInputs) {
        input.deliveryMode = "queue";
        input.admittedRunId = runId;
      }
    }
    return {
      hasRunnableInputs: await this.hasRunnableInputs(threadId),
      hasAdmittedInputs: thread.pendingInputs.some((input) => input.admittedRunId === runId),
      hadPendingWake,
    };
  }

  async listRuns(threadId: string): Promise<readonly ThreadRunRecord[]> {
    return [...this.runs.values()]
      .filter((run) => run.threadId === threadId)
      .sort((left, right) => left.startedAt - right.startedAt)
      .map((run) => cloneRecord(run));
  }

  async getLatestRun(threadId: string): Promise<ThreadRunRecord | null> {
    const runs = await this.listRuns(threadId);
    return runs.length > 0 ? runs[runs.length - 1]! : null;
  }

  async listRunningRuns(): Promise<readonly ThreadRunRecord[]> {
    return [...this.runs.values()]
      .filter((run) => run.status === "running")
      .sort((left, right) => left.startedAt - right.startedAt)
      .map((run) => cloneRecord(run));
  }

  async createToolJob(input: CreateThreadToolJobInput): Promise<ThreadToolJobRecord> {
    const thread = this.threads.get(input.threadId);
    if (!thread) {
      throw missingThreadError(input.threadId);
    }

    if (this.toolJobs.has(input.id)) {
      throw new Error(`Tool job ${input.id} already exists.`);
    }

    if (input.parentToolCallId && (!input.runId || input.kind !== "command")) {
      throw new Error("Parent Panda tool calls require a command job and originating run id.");
    }
    if (input.runId) {
      await this.assertRunActive(input.runId);
    }
    const parentRun = input.runId ? this.runs.get(input.runId) : undefined;
    if (input.parentToolCallId && parentRun?.threadId !== input.threadId) {
      throw new Error(`Run ${input.runId} does not belong to thread ${input.threadId}.`);
    }
    const commandOrdinal = input.parentToolCallId
      ? Math.max(0, ...[...this.toolJobs.values()]
        .filter((job) => (
          job.threadId === input.threadId
          && job.runId === input.runId
          && job.parentToolCallId === input.parentToolCallId
        ))
        .map((job) => job.commandOrdinal ?? 0)) + 1
      : undefined;
    const owner = parentRun?.owner ?? input.owner;
    if ((input.status ?? "running") === "running" && !owner) {
      throw new Error("A standalone background tool job requires the current daemon owner.");
    }
    if (owner) {
      if (this.currentOwner && !sameRunOwner(this.currentOwner, owner)) {
        throw new ThreadToolJobOwnershipLostError(input.id);
      }
      this.currentOwner ??= {...owner};
    }

    const record: ThreadToolJobRecord = {
      id: input.id,
      threadId: input.threadId,
      runId: input.runId,
      owner: owner ? {...owner} : undefined,
      parentToolCallId: input.parentToolCallId,
      commandOrdinal,
      kind: input.kind,
      status: input.status ?? "running",
      summary: input.summary ?? "",
      startedAt: input.startedAt ?? Date.now(),
      result: input.result,
      error: input.error,
      statusReason: input.statusReason,
      progress: input.progress,
    };

    thread.thread.updatedAt = Date.now();
    this.toolJobs.set(record.id, record);
    return cloneRecord(record);
  }

  async getToolJob(jobId: string): Promise<ThreadToolJobRecord> {
    const record = this.toolJobs.get(jobId);
    if (!record) {
      throw new Error(`Unknown tool job ${jobId}`);
    }

    return cloneRecord(record);
  }

  async listToolJobs(threadId: string): Promise<readonly ThreadToolJobRecord[]> {
    if (!this.threads.has(threadId)) {
      throw missingThreadError(threadId);
    }

    return [...this.toolJobs.values()]
      .filter((job) => job.threadId === threadId)
      .sort((left, right) => left.startedAt - right.startedAt)
      .map((job) => cloneRecord(job));
  }

  async listCommandToolJobsByParent(
    threadId: string,
    runId: string,
    parentToolCallId: string,
  ): Promise<readonly ThreadToolJobRecord[]> {
    if (!this.threads.has(threadId)) {
      throw missingThreadError(threadId);
    }

    return [...this.toolJobs.values()]
      .filter((job) => (
        job.threadId === threadId
        && job.runId === runId
        && job.kind === "command"
        && job.parentToolCallId === parentToolCallId
      ))
      .sort((left, right) => (left.commandOrdinal ?? 0) - (right.commandOrdinal ?? 0))
      .map((job) => cloneRecord(job));
  }

  async updateToolJob(jobId: string, update: ThreadToolJobUpdate): Promise<ThreadToolJobRecord> {
    const record = this.toolJobs.get(jobId);
    if (!record) {
      throw new Error(`Unknown tool job ${jobId}`);
    }
    if (record.status !== "running") {
      return cloneRecord(record);
    }
    if (record.owner && this.currentOwner && !sameRunOwner(record.owner, this.currentOwner)) {
      throw new ThreadToolJobOwnershipLostError(record.id);
    }

    const next: ThreadToolJobRecord = {
      ...record,
      ...update,
      finishedAt: update.finishedAt === undefined ? record.finishedAt : update.finishedAt ?? undefined,
      durationMs: update.durationMs === undefined ? record.durationMs : update.durationMs ?? undefined,
      result: update.result === undefined ? record.result : update.result ?? undefined,
      error: update.error === undefined ? record.error : update.error ?? undefined,
      statusReason: update.statusReason === undefined ? record.statusReason : update.statusReason ?? undefined,
      progress: update.progress === undefined ? record.progress : update.progress ?? undefined,
    };

    this.toolJobs.set(jobId, next);
    const thread = this.threads.get(record.threadId);
    if (thread) {
      thread.thread.updatedAt = Date.now();
    }
    return cloneRecord(next);
  }

  async markOrphanedToolJobsLost(
    owner: ThreadRunOwner,
    reason: string,
    limit: number,
  ): Promise<number> {
    this.currentOwner = {...owner};
    let count = 0;
    const finishedAt = Date.now();
    for (const record of this.toolJobs.values()) {
      if (count >= limit || record.status !== "running") {
        continue;
      }
      if (sameRunOwner(record.owner, owner)) {
        continue;
      }
      record.status = "lost";
      record.finishedAt = finishedAt;
      record.durationMs = Math.max(0, finishedAt - record.startedAt);
      record.statusReason ??= reason;
      count += 1;
    }
    return count;
  }

  async listPendingInputs(threadId: string): Promise<readonly ThreadPendingInputRecord[]> {
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw missingThreadError(threadId);
    }

    return [...thread.pendingInputs]
      .sort((left, right) => left.order - right.order)
      .map((input) => {
        if (input.status !== "pending" || !input.message) {
          throw new Error(`Pending thread input ${input.id} is missing its message payload.`);
        }
        return cloneRecord({
          ...input,
          status: "pending" as const,
          message: input.message,
        });
      });
  }

  async requestRunAbort(
    threadId: string,
    reason = "Aborted by runtime request.",
    operationId = randomUUID(),
  ): Promise<ThreadRunRecord | null> {
    const replay = this.abortOperations.get(operationId);
    if (replay) {
      if (replay.threadId !== threadId || replay.reason !== reason) {
        throw new Error(`Abort operation ${operationId} conflicts with another request.`);
      }
      return replay.runId ? cloneRecord(this.runs.get(replay.runId)!) : null;
    }
    if (!this.threads.has(threadId)) {
      throw missingThreadError(threadId);
    }
    const run = [...this.runs.values()]
      .filter((entry) => entry.threadId === threadId && entry.status === "running")
      .sort((left, right) => right.startedAt - left.startedAt)
      .at(0);

    this.abortOperations.set(operationId, {
      threadId,
      reason,
      ...(run ? {runId: run.id} : {}),
    });

    if (!run) {
      return null;
    }

    run.abortRequestedAt ??= Date.now();
    run.abortReason ??= reason;
    return cloneRecord(run);
  }
}
