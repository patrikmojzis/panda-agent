import {buildRuntimeRelationNames} from "../../threads/runtime/postgres-shared.js";

export interface ScheduledTaskTableNames {
  prefix: string;
  scheduledTasks: string;
  scheduledTaskRuns: string;
}

export function buildScheduledTaskTableNames(): ScheduledTaskTableNames {
  return buildRuntimeRelationNames({
    scheduledTasks: "scheduled_tasks",
    scheduledTaskRuns: "scheduled_task_runs",
  });
}
