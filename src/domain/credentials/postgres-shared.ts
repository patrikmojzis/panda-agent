import {buildPrefixedRelationNames} from "../threads/runtime/postgres-shared.js";

export interface CredentialTableNames {
  prefix: string;
  credentials: string;
}

export function buildCredentialTableNames(prefix: string): CredentialTableNames {
  return buildPrefixedRelationNames(prefix, {
    credentials: "credentials",
  });
}
