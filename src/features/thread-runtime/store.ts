import type {
  CreateThreadInput,
  ThreadInputDeliveryMode,
  ThreadInputPayload,
  ThreadInputRecord,
  ThreadMessageRecord,
  ThreadRunRecord,
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
  listThreadSummaries(limit?: number, identityId?: string): Promise<readonly ThreadSummaryRecord[]>;
  updateThread(threadId: string, update: ThreadUpdate): Promise<ThreadRecord>;
  loadTranscript(threadId: string): Promise<readonly ThreadMessageRecord[]>;
  enqueueInput(
    threadId: string,
    payload: ThreadInputPayload,
    deliveryMode?: ThreadInputDeliveryMode,
  ): Promise<ThreadEnqueueResult>;
  applyPendingInputs(threadId: string): Promise<readonly ThreadMessageRecord[]>;
  discardPendingInputs(threadId: string): Promise<number>;
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
