export {CredentialCrypto, CURRENT_CREDENTIAL_KEY_VERSION, resolveCredentialCrypto} from "./crypto.js";
export {
  PostgresCredentialStore,
  type PostgresCredentialStoreOptions,
} from "./postgres.js";
export {buildCredentialTableNames, type CredentialTableNames} from "./postgres-shared.js";
export {CredentialResolver, CredentialService} from "./resolver.js";
export type {
  CredentialListEntry,
  CredentialListFilter,
  CredentialRecord,
  CredentialResolutionContext,
  CredentialScope,
  CredentialScopeInput,
  DecryptedCredentialRecord,
  EncryptedCredentialValue,
  SetCredentialInput,
} from "./types.js";
export {
  CREDENTIAL_SCOPES,
  maskCredentialValue,
  normalizeCredentialEnvKey,
  normalizeCredentialScopeInput,
} from "./types.js";
