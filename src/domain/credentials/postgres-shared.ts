import {buildRuntimeRelationNames} from "../threads/runtime/postgres-shared.js";

export interface CredentialTableNames {
  prefix: string;
  credentials: string;
}

export function buildCredentialTableNames(): CredentialTableNames {
  return buildRuntimeRelationNames({
    credentials: "credentials",
  });
}
