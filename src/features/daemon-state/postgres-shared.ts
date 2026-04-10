import {buildPrefixedRelationNames} from "../thread-runtime/postgres-shared.js";

export interface PandaDaemonStateTableNames {
  prefix: string;
  daemonState: string;
}

export function buildPandaDaemonStateTableNames(prefix: string): PandaDaemonStateTableNames {
  return buildPrefixedRelationNames(prefix, {
    daemonState: "daemon_state",
  });
}
