import {buildRuntimeRelationNames} from "../../lib/postgres-relations.js";

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
