import {buildRuntimeRelationNames} from "../threads/runtime/postgres-shared.js";

export interface ExecutionEnvironmentTableNames {
  prefix: string;
  executionEnvironments: string;
  sessionEnvironmentBindings: string;
}

export function buildExecutionEnvironmentTableNames(): ExecutionEnvironmentTableNames {
  return buildRuntimeRelationNames({
    executionEnvironments: "execution_environments",
    sessionEnvironmentBindings: "session_environment_bindings",
  });
}

