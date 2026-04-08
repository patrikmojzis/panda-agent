import {
  createDefaultIdentityInput,
  DEFAULT_IDENTITY_HANDLE,
  DEFAULT_IDENTITY_ID,
  type CreateIdentityInput,
  type IdentityRecord,
} from "./types.js";
import type { IdentityStore } from "./store.js";

function cloneRecord<T extends object>(record: T): T {
  return {
    ...record,
  };
}

function normalizeHandle(value: string): string {
  return value.trim().toLowerCase();
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
      handle: normalizeHandle(localIdentity.handle),
      createdAt: now,
      updatedAt: now,
    };
  }

  async createIdentity(input: CreateIdentityInput): Promise<IdentityRecord> {
    if (input.id === DEFAULT_IDENTITY_ID || normalizeHandle(input.handle) === DEFAULT_IDENTITY_HANDLE) {
      throw new Error(`Identity ${DEFAULT_IDENTITY_ID} already exists.`);
    }

    throw requiresPostgresError();
  }

  async ensureIdentity(input: CreateIdentityInput): Promise<IdentityRecord> {
    if (input.id === DEFAULT_IDENTITY_ID || normalizeHandle(input.handle) === DEFAULT_IDENTITY_HANDLE) {
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
    const normalizedHandle = normalizeHandle(handle);
    if (normalizedHandle !== DEFAULT_IDENTITY_HANDLE) {
      throw requiresPostgresError();
    }

    return cloneRecord(this.localIdentity);
  }

  async listIdentities(): Promise<readonly IdentityRecord[]> {
    return [cloneRecord(this.localIdentity)];
  }
}
