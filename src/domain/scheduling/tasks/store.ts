import type {
  CancelScheduledTaskInput,
  ClaimScheduledTaskResult,
  ClaimScheduledTaskRunInput,
  CompleteScheduledTaskRunInput,
  CreateScheduledTaskInput,
  FailScheduledTaskRunInput,
  ListActiveScheduledTasksInput,
  ListDueScheduledTasksInput,
  ListScheduledTaskRunsInput,
  ListScheduledTasksInput,
  MaterializeScheduledTaskRunsInput,
  RenewScheduledTaskRunClaimInput,
  ScheduledTaskRecord,
  ScheduledTaskRunRecord,
  StartScheduledTaskRunInput,
  UpdateScheduledTaskInput,
} from "./types.js";

export interface ScheduledTaskStore {
  createTask(input: CreateScheduledTaskInput): Promise<ScheduledTaskRecord>;
  updateTask(input: UpdateScheduledTaskInput): Promise<ScheduledTaskRecord>;
  cancelTask(input: CancelScheduledTaskInput): Promise<ScheduledTaskRecord>;
  getTask(taskId: string): Promise<ScheduledTaskRecord>;
  listTasks(input: ListScheduledTasksInput): Promise<readonly ScheduledTaskRecord[]>;
  listTaskRuns(input: ListScheduledTaskRunsInput): Promise<readonly ScheduledTaskRunRecord[]>;
  listActiveTasks(input: ListActiveScheduledTasksInput): Promise<readonly ScheduledTaskRecord[]>;
  listDueTasks(input?: ListDueScheduledTasksInput): Promise<readonly ScheduledTaskRecord[]>;
  materializeTaskRuns(input: MaterializeScheduledTaskRunsInput): Promise<readonly ScheduledTaskRunRecord[]>;
  claimTaskRun(input: ClaimScheduledTaskRunInput): Promise<ClaimScheduledTaskResult | null>;
  renewTaskRunClaim(input: RenewScheduledTaskRunClaimInput): Promise<ScheduledTaskRunRecord | null>;
  startTaskRun(input: StartScheduledTaskRunInput): Promise<ScheduledTaskRunRecord>;
  completeTaskRun(input: CompleteScheduledTaskRunInput): Promise<ScheduledTaskRunRecord>;
  failTaskRun(input: FailScheduledTaskRunInput): Promise<ScheduledTaskRunRecord>;
}
