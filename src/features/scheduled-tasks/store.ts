import type {
    CancelScheduledTaskInput,
    ClaimScheduledTaskInput,
    ClaimScheduledTaskResult,
    CompleteScheduledTaskRunInput,
    CreateScheduledTaskInput,
    FailScheduledTaskRunInput,
    ListDueScheduledTasksInput,
    ScheduledTaskRecord,
    ScheduledTaskRunRecord,
    StartScheduledTaskRunInput,
    UpdateScheduledTaskInput,
} from "./types.js";

export interface ScheduledTaskStore {
  ensureSchema(): Promise<void>;
  createTask(input: CreateScheduledTaskInput): Promise<ScheduledTaskRecord>;
  updateTask(input: UpdateScheduledTaskInput): Promise<ScheduledTaskRecord>;
  cancelTask(input: CancelScheduledTaskInput): Promise<ScheduledTaskRecord>;
  getTask(taskId: string): Promise<ScheduledTaskRecord>;
  listDueTasks(input?: ListDueScheduledTasksInput): Promise<readonly ScheduledTaskRecord[]>;
  claimTask(input: ClaimScheduledTaskInput): Promise<ClaimScheduledTaskResult | null>;
  startTaskRun(input: StartScheduledTaskRunInput): Promise<ScheduledTaskRunRecord>;
  completeTaskRun(input: CompleteScheduledTaskRunInput): Promise<ScheduledTaskRunRecord>;
  failTaskRun(input: FailScheduledTaskRunInput): Promise<ScheduledTaskRunRecord>;
  clearTaskClaim(taskId: string): Promise<ScheduledTaskRecord>;
  markTaskWaitingDelivery(taskId: string): Promise<ScheduledTaskRecord>;
  markTaskCompleted(taskId: string): Promise<ScheduledTaskRecord>;
  markTaskFailed(taskId: string): Promise<ScheduledTaskRecord>;
  getLatestTaskRun(taskId: string, fireKind?: ScheduledTaskRunRecord["fireKind"]): Promise<ScheduledTaskRunRecord | null>;
}
