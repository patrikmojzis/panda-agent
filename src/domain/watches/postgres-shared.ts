import {buildRuntimeRelationNames} from "../threads/runtime/postgres-shared.js";

export interface WatchTableNames {
  prefix: string;
  watches: string;
  watchRuns: string;
  watchEvents: string;
}

export function buildWatchTableNames(): WatchTableNames {
  return buildRuntimeRelationNames({
    watches: "watches",
    watchRuns: "watch_runs",
    watchEvents: "watch_events",
  });
}
