import type {
  CreateIdentityBindingInput,
  CreateIdentityInput,
  EnsureIdentityBindingInput,
  IdentityBindingLookup,
  IdentityBindingRecord,
  IdentityRecord,
  UpdateIdentityInput,
} from "./types.js";

export interface IdentityStore {
  createIdentity(input: CreateIdentityInput): Promise<IdentityRecord>;
  ensureIdentity(input: CreateIdentityInput): Promise<IdentityRecord>;
  updateIdentity(input: UpdateIdentityInput): Promise<IdentityRecord>;
  getIdentity(identityId: string): Promise<IdentityRecord>;
  getIdentityByHandle(handle: string): Promise<IdentityRecord>;
  listIdentities(): Promise<readonly IdentityRecord[]>;
  createIdentityBinding(input: CreateIdentityBindingInput): Promise<IdentityBindingRecord>;
  ensureIdentityBinding(input: EnsureIdentityBindingInput): Promise<IdentityBindingRecord>;
  resolveIdentityBinding(lookup: IdentityBindingLookup): Promise<IdentityBindingRecord | null>;
  listIdentityBindings(identityId: string): Promise<readonly IdentityBindingRecord[]>;
  deleteIdentityBinding(lookup: IdentityBindingLookup): Promise<boolean>;
}
