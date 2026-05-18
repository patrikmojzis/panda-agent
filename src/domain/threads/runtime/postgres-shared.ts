import {buildRuntimeRelationNames} from "../../../lib/postgres-relations.js";

export interface ThreadRuntimeTableNames {
  prefix: string;
  threads: string;
  messages: string;
  inputs: string;
  runs: string;
  toolJobs: string;
  bashJobs: string;
}

export function buildThreadRuntimeTableNames(): ThreadRuntimeTableNames {
  return buildRuntimeRelationNames({
    threads: "threads",
    messages: "messages",
    inputs: "inputs",
    runs: "runs",
    toolJobs: "tool_jobs",
    bashJobs: "bash_jobs",
  });
}
