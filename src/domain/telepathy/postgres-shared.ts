import {buildRuntimeRelationNames} from "../threads/runtime/postgres-shared.js";

export interface TelepathyTableNames {
  prefix: string;
  devices: string;
}

export function buildTelepathyTableNames(): TelepathyTableNames {
  return buildRuntimeRelationNames({
    devices: "telepathy_devices",
  });
}
