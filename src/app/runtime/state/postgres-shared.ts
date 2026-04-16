import {buildRuntimeRelationNames} from "../../../domain/threads/runtime/postgres-shared.js";

export interface DaemonStateTableNames {
  prefix: string;
  daemonState: string;
}

export function buildDaemonStateTableNames(): DaemonStateTableNames {
  return buildRuntimeRelationNames({
    daemonState: "daemon_state",
  });
}
