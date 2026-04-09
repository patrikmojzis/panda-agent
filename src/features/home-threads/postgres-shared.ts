import { buildPrefixedRelationNames } from "../thread-runtime/postgres-shared.js";

export interface HomeThreadTableNames {
  prefix: string;
  homeThreads: string;
}

export function buildHomeThreadTableNames(prefix: string): HomeThreadTableNames {
  return buildPrefixedRelationNames(prefix, {
    homeThreads: "home_threads",
  });
}
