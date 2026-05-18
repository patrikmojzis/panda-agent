import {buildRuntimeRelationNames} from "../../lib/postgres-relations.js";

export interface CredentialTableNames {
  prefix: string;
  credentials: string;
}

export function buildCredentialTableNames(): CredentialTableNames {
  return buildRuntimeRelationNames({
    credentials: "credentials",
  });
}
