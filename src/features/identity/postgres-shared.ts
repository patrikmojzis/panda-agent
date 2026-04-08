import { quoteIdentifier, validateIdentifier } from "../thread-runtime/postgres-shared.js";

export interface IdentityRelationNames {
  identities: string;
  identityBindings: string;
}

export interface IdentityTableNames extends IdentityRelationNames {
  prefix: string;
}

function buildQuotedIdentityRelationNames(prefix: string): IdentityRelationNames {
  return {
    identities: quoteIdentifier(`${prefix}_identities`),
    identityBindings: quoteIdentifier(`${prefix}_identity_bindings`),
  };
}

export function buildIdentityRelationNames(prefix: string): IdentityRelationNames {
  return buildQuotedIdentityRelationNames(validateIdentifier(prefix));
}

export function buildIdentityTableNames(prefix: string): IdentityTableNames {
  const safePrefix = validateIdentifier(prefix);
  return {
    prefix: safePrefix,
    ...buildQuotedIdentityRelationNames(safePrefix),
  };
}
