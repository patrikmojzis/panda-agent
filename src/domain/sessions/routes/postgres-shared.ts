import {buildPrefixedRelationNames} from "../../threads/runtime/postgres-shared.js";

export interface SessionRouteTableNames {
  prefix: string;
  sessionRoutes: string;
}

export function buildSessionRouteTableNames(prefix: string): SessionRouteTableNames {
  return buildPrefixedRelationNames(prefix, {
    sessionRoutes: "session_routes",
  });
}
