import type { CreateIdentityInput, IdentityRecord } from "./types.js";

export interface IdentityStore {
  createIdentity(input: CreateIdentityInput): Promise<IdentityRecord>;
  ensureIdentity(input: CreateIdentityInput): Promise<IdentityRecord>;
  getIdentity(identityId: string): Promise<IdentityRecord>;
  getIdentityByHandle(handle: string): Promise<IdentityRecord>;
  listIdentities(): Promise<readonly IdentityRecord[]>;
}
