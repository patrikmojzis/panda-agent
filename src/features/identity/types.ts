import type { JsonValue } from "../agent-core/types.js";

export const DEFAULT_IDENTITY_ID = "local";
export const DEFAULT_IDENTITY_HANDLE = "local";
export const DEFAULT_IDENTITY_DISPLAY_NAME = "Local";

export type IdentityStatus = "active" | "deleted";

export interface CreateIdentityInput {
  id: string;
  handle: string;
  displayName: string;
  status?: IdentityStatus;
  metadata?: JsonValue;
}

export interface IdentityRecord extends CreateIdentityInput {
  status: IdentityStatus;
  createdAt: number;
  updatedAt: number;
}

export interface IdentityBindingLookup {
  source: string;
  connectorKey: string;
  externalActorId: string;
}

export interface IdentityBindingInput extends IdentityBindingLookup {
  identityId: string;
  metadata?: JsonValue;
}

export interface CreateIdentityBindingInput extends IdentityBindingInput {
  id: string;
}

export interface EnsureIdentityBindingInput extends IdentityBindingInput {
  id?: string;
}

export interface IdentityBindingRecord extends CreateIdentityBindingInput {
  createdAt: number;
  updatedAt: number;
}

export function createDefaultIdentityInput(): CreateIdentityInput {
  return {
    id: DEFAULT_IDENTITY_ID,
    handle: DEFAULT_IDENTITY_HANDLE,
    displayName: DEFAULT_IDENTITY_DISPLAY_NAME,
    status: "active",
  };
}
