import type {
    CreateThreadBashJobInput,
    CreateThreadInput,
    ThreadBashJobRecord,
    ThreadBashJobUpdate,
    ThreadInputDeliveryMode,
    ThreadInputPayload,
    ThreadInputRecord,
    ThreadMessageRecord,
    ThreadRecord,
    ThreadRunRecord,
    ThreadRuntimeMessagePayload,
    ThreadSummaryRecord,
    ThreadUpdate,
} from "./types.js";

export interface ThreadEnqueueResult {
  input: ThreadInputRecord;
  inserted: boolean;
}

export type ThreadInputApplyScope = "all" | "runnable";

export interface ThreadRuntimeStore {
  createThread(input: CreateThreadInput): Promise<ThreadRecord>;
  getThread(threadId: string): Promise<ThreadRecord>;
  listThreadSummaries(limit?: number, sessionId?: string): Promise<readonly ThreadSummaryRecord[]>;
  updateThread(threadId: string, update: ThreadUpdate): Promise<ThreadRecord>;
  loadTranscript(threadId: string): Promise<readonly ThreadMessageRecord[]>;
  enqueueInput(
    threadId: string,
    payload: ThreadInputPayload,
    deliveryMode?: ThreadInputDeliveryMode,
  ): Promise<ThreadEnqueueResult>;
  applyPendingInputs(
    threadId: string,
    scope?: ThreadInputApplyScope,
  ): Promise<readonly ThreadMessageRecord[]>;
  discardPendingInputs(threadId: string): Promise<number>;
  hasPendingInputs(threadId: string): Promise<boolean>;
  hasRunnableInputs(threadId: string): Promise<boolean>;
  hasPendingWake(threadId: string): Promise<boolean>;
  promoteQueuedInputs(threadId?: string): Promise<readonly string[]>;
  requestWake(threadId: string): Promise<void>;
  consumePendingWake(threadId: string): Promise<boolean>;
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
  createBashJob(input: CreateThreadBashJobInput): Promise<ThreadBashJobRecord>;
  getBashJob(jobId: string): Promise<ThreadBashJobRecord>;
  listBashJobs(threadId: string): Promise<readonly ThreadBashJobRecord[]>;
  updateBashJob(jobId: string, update: ThreadBashJobUpdate): Promise<ThreadBashJobRecord>;
  markRunningBashJobsLost(reason?: string): Promise<number>;
  listPendingInputs(threadId: string): Promise<readonly ThreadInputRecord[]>;
  requestRunAbort(threadId: string, reason?: string): Promise<ThreadRunRecord | null>;
}
