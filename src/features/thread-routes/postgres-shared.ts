import {buildPrefixedRelationNames} from "../thread-runtime/postgres-shared.js";

export interface ThreadRouteTableNames {
  prefix: string;
  threadRoutes: string;
}

export function buildThreadRouteTableNames(prefix: string): ThreadRouteTableNames {
  return buildPrefixedRelationNames(prefix, {
    threadRoutes: "thread_routes",
  });
}
