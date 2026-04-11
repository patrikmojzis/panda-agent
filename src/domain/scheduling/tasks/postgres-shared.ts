import {buildPrefixedRelationNames} from "../../threads/runtime/postgres-shared.js";

export interface ScheduledTaskTableNames {
  prefix: string;
  scheduledTasks: string;
  scheduledTaskRuns: string;
}

export function buildScheduledTaskTableNames(prefix: string): ScheduledTaskTableNames {
  return buildPrefixedRelationNames(prefix, {
    scheduledTasks: "scheduled_tasks",
    scheduledTaskRuns: "scheduled_task_runs",
  });
}
