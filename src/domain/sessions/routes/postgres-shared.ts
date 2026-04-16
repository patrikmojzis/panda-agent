import {buildRuntimeRelationNames} from "../../threads/runtime/postgres-shared.js";

export interface SessionRouteTableNames {
  prefix: string;
  sessionRoutes: string;
}

export function buildSessionRouteTableNames(): SessionRouteTableNames {
  return buildRuntimeRelationNames({
    sessionRoutes: "session_routes",
  });
}
