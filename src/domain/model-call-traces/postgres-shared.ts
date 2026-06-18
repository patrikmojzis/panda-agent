import {buildRuntimeRelationNames} from "../../lib/postgres-relations.js";

export interface ModelCallTraceTableNames {
  prefix: string;
  traces: string;
}

export function buildModelCallTraceTableNames(): ModelCallTraceTableNames {
  return buildRuntimeRelationNames({
    traces: "model_call_traces",
  });
}
