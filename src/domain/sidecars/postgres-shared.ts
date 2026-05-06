import {buildRuntimeRelationNames} from "../threads/runtime/postgres-shared.js";

export interface SidecarTableNames {
  prefix: string;
  sidecars: string;
}

export function buildSidecarTableNames(): SidecarTableNames {
  return buildRuntimeRelationNames({
    sidecars: "sidecars",
  });
}
