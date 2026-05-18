import {buildRuntimeRelationNames} from "../../lib/postgres-relations.js";

export interface TelepathyTableNames {
  prefix: string;
  devices: string;
}

export function buildTelepathyTableNames(): TelepathyTableNames {
  return buildRuntimeRelationNames({
    devices: "telepathy_devices",
  });
}
