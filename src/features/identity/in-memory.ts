import {
  type CreateIdentityBindingInput,
  createDefaultIdentityInput,
  DEFAULT_IDENTITY_HANDLE,
  DEFAULT_IDENTITY_ID,
  type CreateIdentityInput,
  type EnsureIdentityBindingInput,
  type IdentityBindingLookup,
  type IdentityBindingRecord,
  type IdentityRecord,
  normalizeIdentityHandle,
} from "./types.js";
import type { IdentityStore } from "./store.js";

function cloneRecord<T extends object>(record: T): T {
  return {
    ...record,
  };
}

function missingIdentityError(identityId: string): Error {
  return new Error(`Unknown identity ${identityId}`);
}

function requiresPostgresError(): Error {
  return new Error("Persisted identities require Postgres. Pass --db-url or set PANDA_DATABASE_URL.");
}

export class InMemoryIdentityStore implements IdentityStore {
  private readonly localIdentity: IdentityRecord;

  constructor() {
    const now = Date.now();
    const localIdentity = createDefaultIdentityInput();
    this.localIdentity = {
      ...localIdentity,
      status: localIdentity.status ?? "active",
      handle: normalizeIdentityHandle(localIdentity.handle),
      createdAt: now,
      updatedAt: now,
    };
  }

  async createIdentity(input: CreateIdentityInput): Promise<IdentityRecord> {
    if (input.id === DEFAULT_IDENTITY_ID || normalizeIdentityHandle(input.handle) === DEFAULT_IDENTITY_HANDLE) {
      throw new Error(`Identity ${DEFAULT_IDENTITY_ID} already exists.`);
    }

    throw requiresPostgresError();
  }

  async ensureIdentity(input: CreateIdentityInput): Promise<IdentityRecord> {
    if (input.id === DEFAULT_IDENTITY_ID || normalizeIdentityHandle(input.handle) === DEFAULT_IDENTITY_HANDLE) {
      return cloneRecord(this.localIdentity);
    }

    throw requiresPostgresError();
  }

  async getIdentity(identityId: string): Promise<IdentityRecord> {
    if (identityId !== DEFAULT_IDENTITY_ID) {
      throw missingIdentityError(identityId);
    }

    return cloneRecord(this.localIdentity);
  }

  async getIdentityByHandle(handle: string): Promise<IdentityRecord> {
    const normalizedHandle = normalizeIdentityHandle(handle);
    if (normalizedHandle !== DEFAULT_IDENTITY_HANDLE) {
      throw requiresPostgresError();
    }

    return cloneRecord(this.localIdentity);
  }

  async listIdentities(): Promise<readonly IdentityRecord[]> {
    return [cloneRecord(this.localIdentity)];
  }

  async createIdentityBinding(_input: CreateIdentityBindingInput): Promise<IdentityBindingRecord> {
    throw requiresPostgresError();
  }

  async ensureIdentityBinding(_input: EnsureIdentityBindingInput): Promise<IdentityBindingRecord> {
    throw requiresPostgresError();
  }

  async resolveIdentityBinding(_lookup: IdentityBindingLookup): Promise<IdentityBindingRecord | null> {
    return null;
  }

  async listIdentityBindings(identityId: string): Promise<readonly IdentityBindingRecord[]> {
    await this.getIdentity(identityId);
    return [];
  }

  async deleteIdentityBinding(_lookup: IdentityBindingLookup): Promise<boolean> {
    throw requiresPostgresError();
  }
}
