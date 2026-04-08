import { buildPrefixedRelationNames } from "../thread-runtime/postgres-shared.js";

export interface IdentityRelationNames {
  identities: string;
  identityBindings: string;
}

export interface IdentityTableNames extends IdentityRelationNames {
  prefix: string;
}

export function buildIdentityTableNames(prefix: string): IdentityTableNames {
  return buildPrefixedRelationNames(prefix, {
    identities: "identities",
    identityBindings: "identity_bindings",
  });
}
