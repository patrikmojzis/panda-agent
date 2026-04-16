import {buildRuntimeRelationNames} from "../../domain/threads/runtime/postgres-shared.js";

export interface IdentityTableNames {
  prefix: string;
  identities: string;
  identityBindings: string;
}

export function buildIdentityTableNames(): IdentityTableNames {
  return buildRuntimeRelationNames({
    identities: "identities",
    identityBindings: "identity_bindings",
  });
}
