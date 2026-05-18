import {CredentialCrypto} from "./crypto.js";
import type {
  CredentialListEntry,
  CredentialListFilter,
  CredentialRecord,
  CredentialResolutionContext,
  DecryptedCredentialRecord,
  SetCredentialInput,
} from "./types.js";
import {
  maskCredentialValue,
  normalizeCredentialAgentKey,
  normalizeCredentialEnvKey,
} from "./types.js";

export interface CredentialResolverStore {
  listResolvableCredentials(context: CredentialResolutionContext): Promise<readonly CredentialRecord[]>;
  resolveCredential(envKey: string, context: CredentialResolutionContext): Promise<CredentialRecord | null>;
}

export interface CredentialServiceStore extends CredentialResolverStore {
  deleteCredential(envKey: string, input: {agentKey: string}): Promise<boolean>;
  listCredentials(filter?: CredentialListFilter): Promise<readonly CredentialRecord[]>;
  setCredential(input: SetCredentialInput): Promise<CredentialRecord>;
}

function decryptRecord(
  record: CredentialRecord,
  crypto: CredentialCrypto,
): DecryptedCredentialRecord {
  return {
    id: record.id,
    envKey: record.envKey,
    agentKey: record.agentKey,
    value: crypto.decrypt(record),
    keyVersion: record.keyVersion,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export class CredentialResolver {
  private readonly store: CredentialResolverStore;
  private readonly crypto: CredentialCrypto | null;

  constructor(options: { store: CredentialResolverStore; crypto?: CredentialCrypto | null }) {
    this.store = options.store;
    this.crypto = options.crypto ?? null;
  }

  private requireCrypto(): CredentialCrypto {
    if (!this.crypto) {
      throw new Error("CREDENTIALS_MASTER_KEY is required to decrypt stored credentials.");
    }

    return this.crypto;
  }

  async resolveEnvironment(context: CredentialResolutionContext): Promise<Record<string, string>> {
    const records = await this.store.listResolvableCredentials(context);
    if (records.length === 0) {
      return {};
    }

    const crypto = this.requireCrypto();
    const resolved: Record<string, string> = {};

    for (const record of records) {
      resolved[record.envKey] = crypto.decrypt(record);
    }

    return resolved;
  }

  async resolveCredential(
    envKey: string,
    context: CredentialResolutionContext,
  ): Promise<DecryptedCredentialRecord | null> {
    const record = await this.store.resolveCredential(envKey, context);
    if (!record) {
      return null;
    }

    return decryptRecord(record, this.requireCrypto());
  }
}

export class CredentialService {
  private readonly store: CredentialServiceStore;
  private readonly crypto: CredentialCrypto;
  private readonly resolver: CredentialResolver;

  constructor(options: { store: CredentialServiceStore; crypto: CredentialCrypto }) {
    this.store = options.store;
    this.crypto = options.crypto;
    this.resolver = new CredentialResolver(options);
  }

  async setCredential(input: {
    envKey: string;
    value: string;
    agentKey: string;
  }): Promise<DecryptedCredentialRecord> {
    const normalizedAgentKey = normalizeCredentialAgentKey(input.agentKey);
    const normalizedEnvKey = normalizeCredentialEnvKey(input.envKey);
    const record = await this.store.setCredential({
      agentKey: normalizedAgentKey,
      envKey: normalizedEnvKey,
      encryptedValue: this.crypto.encrypt(input.value),
    });

    return decryptRecord(record, this.crypto);
  }

  async clearCredential(input: {
    envKey: string;
    agentKey: string;
  }): Promise<boolean> {
    const normalizedAgentKey = normalizeCredentialAgentKey(input.agentKey);
    const normalizedEnvKey = normalizeCredentialEnvKey(input.envKey);
    return this.store.deleteCredential(normalizedEnvKey, {agentKey: normalizedAgentKey});
  }

  async listCredentials(filter: CredentialListFilter = {}): Promise<readonly CredentialListEntry[]> {
    const records = await this.store.listCredentials(filter);

    return records.map((record) => {
      const decrypted = decryptRecord(record, this.crypto);
      return {
        ...decrypted,
        valuePreview: maskCredentialValue(decrypted.value),
      } satisfies CredentialListEntry;
    });
  }

  async resolveCredential(
    envKey: string,
    context: CredentialResolutionContext,
  ): Promise<CredentialListEntry | null> {
    const resolved = await this.resolver.resolveCredential(envKey, context);
    if (!resolved) {
      return null;
    }

    return {
      ...resolved,
      valuePreview: maskCredentialValue(resolved.value),
    };
  }
}
