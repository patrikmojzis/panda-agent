import {SecretCrypto} from "../secrets/crypto.js";
import type {
  CredentialListFilter,
  CredentialMetadataEntry,
  CredentialPreviewEntry,
  CredentialRecord,
  CredentialResolutionContext,
  ResolvedCredentialRecord,
  SetCredentialInput,
} from "./types.js";
import {
  credentialSecretContext,
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
  crypto: SecretCrypto,
): ResolvedCredentialRecord {
  return {
    id: record.id,
    envKey: record.envKey,
    agentKey: record.agentKey,
    value: crypto.open({
      ciphertext: record.valueCiphertext,
      iv: record.valueIv,
      tag: record.valueTag,
      envelopeVersion: record.envelopeVersion,
    }, credentialSecretContext(record.agentKey, record.envKey)),
    envelopeVersion: record.envelopeVersion,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export class CredentialResolver {
  private readonly store: CredentialResolverStore;
  private readonly crypto: SecretCrypto | null;

  constructor(options: { store: CredentialResolverStore; crypto?: SecretCrypto | null }) {
    this.store = options.store;
    this.crypto = options.crypto ?? null;
  }

  private requireCrypto(): SecretCrypto {
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
      resolved[record.envKey] = decryptRecord(record, crypto).value;
    }

    return resolved;
  }

  async resolveCredential(
    envKey: string,
    context: CredentialResolutionContext,
  ): Promise<ResolvedCredentialRecord | null> {
    const record = await this.store.resolveCredential(envKey, context);
    if (!record) {
      return null;
    }

    return decryptRecord(record, this.requireCrypto());
  }
}

export class CredentialService {
  private readonly store: CredentialServiceStore;
  private readonly crypto: SecretCrypto;
  private readonly resolver: CredentialResolver;

  constructor(options: { store: CredentialServiceStore; crypto: SecretCrypto }) {
    this.store = options.store;
    this.crypto = options.crypto;
    this.resolver = new CredentialResolver(options);
  }

  async setCredential(input: {
    envKey: string;
    value: string;
    agentKey: string;
  }): Promise<CredentialMetadataEntry> {
    const normalizedAgentKey = normalizeCredentialAgentKey(input.agentKey);
    const normalizedEnvKey = normalizeCredentialEnvKey(input.envKey);
    const record = await this.store.setCredential({
      agentKey: normalizedAgentKey,
      envKey: normalizedEnvKey,
      encryptedValue: this.crypto.seal(
        input.value,
        credentialSecretContext(normalizedAgentKey, normalizedEnvKey),
      ),
    });

    return toMetadata(record);
  }

  async clearCredential(input: {
    envKey: string;
    agentKey: string;
  }): Promise<boolean> {
    const normalizedAgentKey = normalizeCredentialAgentKey(input.agentKey);
    const normalizedEnvKey = normalizeCredentialEnvKey(input.envKey);
    return this.store.deleteCredential(normalizedEnvKey, {agentKey: normalizedAgentKey});
  }

  async listCredentialMetadata(filter: CredentialListFilter = {}): Promise<readonly CredentialMetadataEntry[]> {
    const records = await this.store.listCredentials(filter);
    return records.map(toMetadata);
  }

  async resolveCredential(
    envKey: string,
    context: CredentialResolutionContext,
  ): Promise<CredentialPreviewEntry | null> {
    const resolved = await this.resolver.resolveCredential(envKey, context);
    if (!resolved) {
      return null;
    }

    return {
      id: resolved.id,
      agentKey: resolved.agentKey,
      envKey: resolved.envKey,
      valuePreview: maskCredentialValue(resolved.value),
      envelopeVersion: resolved.envelopeVersion,
      createdAt: resolved.createdAt,
      updatedAt: resolved.updatedAt,
    };
  }
}

function toMetadata(record: CredentialRecord): CredentialMetadataEntry {
  return {
    id: record.id,
    agentKey: record.agentKey,
    envKey: record.envKey,
    envelopeVersion: record.envelopeVersion,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
