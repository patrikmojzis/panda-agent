import {buildRuntimeRelationNames} from "../../lib/postgres-relations.js";

export interface ModelCallTraceTableNames {
  prefix: string;
  attempts: string;
  snapshots: string;
  legacyTraces: string;
}

export function buildModelCallTraceTableNames(): ModelCallTraceTableNames {
  return buildRuntimeRelationNames({
    attempts: "model_call_attempts",
    snapshots: "model_call_snapshots",
    legacyTraces: "model_call_traces",
  });
}
