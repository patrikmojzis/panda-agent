import {buildPrefixedRelationNames} from "../../domain/threads/runtime/postgres-shared.js";

export interface IdentityTableNames {
  prefix: string;
  identities: string;
  identityBindings: string;
}

export function buildIdentityTableNames(prefix: string): IdentityTableNames {
  return buildPrefixedRelationNames(prefix, {
    identities: "identities",
    identityBindings: "identity_bindings",
  });
}
