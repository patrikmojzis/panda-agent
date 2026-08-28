import {buildRuntimeRelationNames} from "../../../lib/postgres-relations.js";

export interface ScheduledCommandTableNames {
  prefix: string;
  scheduledCommands: string;
  scheduledCommandVersions: string;
  scheduledCommandRuns: string;
}

export function buildScheduledCommandTableNames(): ScheduledCommandTableNames {
  return buildRuntimeRelationNames({
    scheduledCommands: "scheduled_commands",
    scheduledCommandVersions: "scheduled_command_versions",
    scheduledCommandRuns: "scheduled_command_runs",
  });
}
