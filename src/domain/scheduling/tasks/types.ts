import type {JsonObject} from "../../../kernel/agent/types.js";

export type ScheduledTaskScheduleKind = "once" | "recurring";
export type ScheduledTaskRunStatus = "claimed" | "running" | "succeeded" | "failed" | "cancelled";

export interface ScheduledTaskOnceSchedule {
  kind: "once";
  runAt: string;
}

export interface ScheduledTaskRecurringSchedule {
  kind: "recurring";
  cron: string;
  timezone: string;
}

export type ScheduledTaskSchedule =
  | ScheduledTaskOnceSchedule
  | ScheduledTaskRecurringSchedule;

export interface ScheduledTaskRecord {
  id: string;
  sessionId: string;
  createdByIdentityId?: string;
  title: string;
  instruction: string;
  schedule: ScheduledTaskSchedule;
  enabled: boolean;
  nextFireAt?: number;
  claimedAt?: number;
  claimedBy?: string;
  claimExpiresAt?: number;
  completedAt?: number;
  cancelledAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ScheduledTaskRunRecord {
  id: string;
  taskId: string;
  sessionId: string;
  createdByIdentityId?: string;
  resolvedThreadId?: string;
  scheduledFor: number;
  status: ScheduledTaskRunStatus;
  threadRunId?: string;
  error?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface CreateScheduledTaskInput {
  sessionId: string;
  createdByIdentityId?: string;
  title: string;
  instruction: string;
  schedule: ScheduledTaskSchedule;
  enabled?: boolean;
}

export interface UpdateScheduledTaskInput {
  taskId: string;
  sessionId: string;
  title?: string;
  instruction?: string;
  schedule?: ScheduledTaskSchedule;
  enabled?: boolean;
}

export interface CancelScheduledTaskInput {
  taskId: string;
  sessionId: string;
  reason?: string;
}

export interface ListDueScheduledTasksInput {
  asOf?: number;
  limit?: number;
}

export interface ListActiveScheduledTasksInput {
  sessionId: string;
  limit?: number;
}

export interface ClaimScheduledTaskInput {
  taskId: string;
  claimedBy: string;
  claimExpiresAt: number;
  nextFireAt?: number;
}

export interface ClaimScheduledTaskResult {
  task: ScheduledTaskRecord;
  run: ScheduledTaskRunRecord;
}

export interface StartScheduledTaskRunInput {
  runId: string;
  resolvedThreadId?: string;
}

export interface CompleteScheduledTaskRunInput {
  runId: string;
  resolvedThreadId?: string;
  threadRunId?: string;
}

export interface FailScheduledTaskRunInput {
  runId: string;
  resolvedThreadId?: string;
  threadRunId?: string;
  error: string;
}

export interface ScheduledTaskThreadInputMetadataValue extends JsonObject {
  taskId: string;
  title: string;
  runAt: string;
}

export interface ScheduledTaskThreadInputMetadata extends JsonObject {
  scheduledTask: ScheduledTaskThreadInputMetadataValue;
}
