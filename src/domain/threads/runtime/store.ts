import type {
    CreateThreadInput,
    CreateThreadToolJobInput,
    ThreadCompactionCommit,
    ThreadCompactionNoopOperationRecord,
    ThreadAbortOperationRecord,
    ThreadChannelMediaFilter,
    ThreadChannelMediaRecord,
    ThreadChannelMessageFilter,
    ThreadInputDeliveryMode,
    ThreadEnqueueOptions,
    ThreadInputPayload,
    ThreadPendingInputRecord,
    ThreadInputRecord,
    ThreadMessageRecord,
    ThreadRecord,
    ThreadRunRecord,
    ThreadRunOwner,
    ThreadRuntimeMessagePayload,
    ThreadSummaryRecord,
    ThreadTranscriptPage,
    ThreadTranscriptPageOptions,
    ThreadTranscriptSnapshot,
    ThreadToolJobRecord,
    ThreadToolJobUpdate,
    ThreadRuntimeStateUpdate,
} from "./types.js";

export interface ThreadEnqueueResult {
  input: ThreadInputRecord;
  disposition: "inserted" | "duplicate_pending" | "duplicate_applied" | "duplicate_discarded";
}

export class StaleThreadCompactionError extends Error {
  constructor(threadId: string) {
    super(`Thread ${threadId} changed while compaction was running. Retry from the latest checkpoint.`);
    this.name = "StaleThreadCompactionError";
  }
}

export class ThreadRunClaimLostError extends Error {
  constructor(runId: string) {
    super(`Thread run ${runId} is no longer owned by this daemon.`);
    this.name = "ThreadRunClaimLostError";
  }
}

/** The current thread is durably retiring; session-targeted work must retry after reset swaps it. */
export class ThreadInputAdmissionBlockedError extends Error {
  override readonly name = "ThreadInputAdmissionBlockedError";

  constructor(readonly sessionId: string, readonly threadId: string) {
    super(`Session ${sessionId} current thread ${threadId} is retiring.`);
  }
}

/** Archived sessions reject new durable work until an explicit restore. */
export class SessionArchivedError extends Error {
  override readonly name = "SessionArchivedError";

  constructor(readonly sessionId: string) {
    super(`Session ${sessionId} is archived.`);
  }
}

export class ThreadToolJobOwnershipLostError extends Error {
  constructor(jobId: string) {
    super(`Background tool job ${jobId} is no longer owned by this daemon.`);
    this.name = "ThreadToolJobOwnershipLostError";
  }
}

export interface ThreadRuntimeStore {
  createThread(input: CreateThreadInput): Promise<ThreadRecord>;
  getThread(threadId: string): Promise<ThreadRecord>;
  getMessage(messageId: string): Promise<ThreadMessageRecord | null>;
  listThreadSummaries(limit?: number, sessionId?: string): Promise<readonly ThreadSummaryRecord[]>;
  loadActiveTranscript(threadId: string): Promise<ThreadTranscriptSnapshot>;
  listTranscriptPage(
    threadId: string,
    options?: ThreadTranscriptPageOptions,
  ): Promise<ThreadTranscriptPage>;
  commitCompaction(
    threadId: string,
    commit: ThreadCompactionCommit,
  ): Promise<ThreadMessageRecord>;
  commitCompactionExclusively(
    threadId: string,
    commit: ThreadCompactionCommit,
    owner: ThreadRunOwner,
  ): Promise<ThreadMessageRecord>;
  getCompactionNoopOperation(operationId: string): Promise<ThreadCompactionNoopOperationRecord | null>;
  recordCompactionNoopOperation(
    operationId: string,
    sessionId: string,
    threadId: string,
    owner: ThreadRunOwner,
  ): Promise<ThreadCompactionNoopOperationRecord>;
  listChannelMessages(filter: ThreadChannelMessageFilter): Promise<readonly ThreadMessageRecord[]>;
  findChannelMedia(filter: ThreadChannelMediaFilter): Promise<ThreadChannelMediaRecord | null>;
  enqueueInput(
    threadId: string,
    payload: ThreadInputPayload,
    deliveryMode?: ThreadInputDeliveryMode,
    options?: ThreadEnqueueOptions,
  ): Promise<ThreadEnqueueResult>;
  enqueueSessionInput(
    sessionId: string,
    payload: ThreadInputPayload,
    deliveryMode?: ThreadInputDeliveryMode,
    options?: ThreadEnqueueOptions,
  ): Promise<ThreadEnqueueResult>;
  applyPendingInputs(
    threadId: string,
    runId: string,
  ): Promise<readonly ThreadMessageRecord[]>;
  findInput(inputId: string): Promise<ThreadInputRecord | null>;
  getInput(inputId: string): Promise<ThreadInputRecord>;
  discardPendingInputs(threadId: string): Promise<number>;
  hasPendingInputs(threadId: string): Promise<boolean>;
  hasPendingWake(threadId: string): Promise<boolean>;
  isThreadRunnable(threadId: string): Promise<boolean>;
  wakePendingInputs(threadId: string): Promise<readonly string[]>;
  requestWake(threadId: string): Promise<void>;
  appendRuntimeMessage(
    threadId: string,
    payload: ThreadRuntimeMessagePayload,
  ): Promise<ThreadMessageRecord>;
  tryStartRun(
    threadId: string,
    owner: ThreadRunOwner,
    runId: string,
  ): Promise<ThreadRunRecord | null>;
  assertRunActive(runId: string): Promise<void>;
  updateThreadForRun(threadId: string, runId: string, update: ThreadRuntimeStateUpdate): Promise<ThreadRecord>;
  getRun(runId: string): Promise<ThreadRunRecord>;
  listAbortRequestedRuns(runIds: readonly string[]): Promise<readonly ThreadRunRecord[]>;
  completeRun(runId: string): Promise<ThreadRunRecord>;
  failRun(runId: string, error?: string): Promise<ThreadRunRecord>;
  /** Terminalize an unexecuted owned run and atomically restore its consumed wake. */
  failRunBeforeExecution(runId: string, error?: string): Promise<ThreadRunRecord>;
  failOrphanedRuns(
    owner: ThreadRunOwner,
    error: string,
    limit: number,
  ): Promise<readonly ThreadRunRecord[]>;
  listRunnableThreadIds(limit: number): Promise<readonly string[]>;
  takeRunBoundary(
    threadId: string,
    runId: string,
  ): Promise<{hasAdmittedInputs: boolean; hadPendingWake: boolean}>;
  getLatestRun(threadId: string): Promise<ThreadRunRecord | null>;
  listRuns(threadId: string): Promise<readonly ThreadRunRecord[]>;
  createToolJob(input: CreateThreadToolJobInput): Promise<ThreadToolJobRecord>;
  getToolJob(jobId: string): Promise<ThreadToolJobRecord>;
  listToolJobs(threadId: string): Promise<readonly ThreadToolJobRecord[]>;
  listCommandToolJobsByParent(
    threadId: string,
    runId: string,
    parentToolCallId: string,
  ): Promise<readonly ThreadToolJobRecord[]>;
  updateToolJob(jobId: string, update: ThreadToolJobUpdate): Promise<ThreadToolJobRecord>;
  markOrphanedToolJobsLost(
    owner: ThreadRunOwner,
    reason: string,
    limit: number,
  ): Promise<number>;
  listPendingInputs(threadId: string): Promise<readonly ThreadPendingInputRecord[]>;
  getThreadAbortOperation(operationId: string): Promise<ThreadAbortOperationRecord | null>;
  requestRunAbort(
    threadId: string,
    reason?: string,
    operationId?: string,
    options?: {blocksNewRuns?: boolean},
  ): Promise<ThreadRunRecord | null>;
}
