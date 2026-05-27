import {buildRuntimeRelationNames} from "../../lib/postgres-relations.js";

export interface SubagentTableNames {
  prefix: string;
  subagentProfiles: string;
}

export function buildSubagentTableNames(): SubagentTableNames {
  return buildRuntimeRelationNames({
    subagentProfiles: "subagent_profiles",
  });
}
