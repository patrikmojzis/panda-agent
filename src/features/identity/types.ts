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

export interface CreateIdentityBindingInput extends IdentityBindingLookup {
  id: string;
  identityId: string;
  metadata?: JsonValue;
}

export interface EnsureIdentityBindingInput extends IdentityBindingLookup {
  id?: string;
  identityId: string;
  metadata?: JsonValue;
}

export interface IdentityBindingRecord extends CreateIdentityBindingInput {
  createdAt: number;
  updatedAt: number;
}

export function normalizeIdentityHandle(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    throw new Error("Identity handle must not be empty.");
  }

  if (!/^[a-z0-9][a-z0-9_-]*$/.test(normalized)) {
    throw new Error("Identity handle must use lowercase letters, numbers, hyphens, or underscores.");
  }

  return normalized;
}

export function createDefaultIdentityInput(): CreateIdentityInput {
  return {
    id: DEFAULT_IDENTITY_ID,
    handle: DEFAULT_IDENTITY_HANDLE,
    displayName: DEFAULT_IDENTITY_DISPLAY_NAME,
    status: "active",
  };
}
