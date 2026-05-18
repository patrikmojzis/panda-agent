import {buildRuntimeRelationNames} from "../../../lib/postgres-relations.js";

export interface SessionRouteTableNames {
  prefix: string;
  sessionRoutes: string;
}

export function buildSessionRouteTableNames(): SessionRouteTableNames {
  return buildRuntimeRelationNames({
    sessionRoutes: "session_routes",
  });
}
