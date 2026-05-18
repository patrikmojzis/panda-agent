import {CredentialCrypto} from "../credentials/crypto.js";
import type {DecryptedWikiBindingRecord, SetWikiBindingInput, WikiBindingRecord} from "./types.js";

export interface WikiBindingServiceStore {
  deleteBinding(agentKey: string): Promise<boolean>;
  getBinding(agentKey: string): Promise<WikiBindingRecord | null>;
  setBinding(input: SetWikiBindingInput): Promise<WikiBindingRecord>;
}

function decryptBindingRecord(
  record: WikiBindingRecord,
  crypto: CredentialCrypto,
): DecryptedWikiBindingRecord {
  return {
    agentKey: record.agentKey,
    wikiGroupId: record.wikiGroupId,
    namespacePath: record.namespacePath,
    apiToken: crypto.decrypt({
      valueCiphertext: record.apiTokenCiphertext,
      valueIv: record.apiTokenIv,
      valueTag: record.apiTokenTag,
      keyVersion: record.keyVersion,
    }),
    keyVersion: record.keyVersion,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export class WikiBindingService {
  private readonly store: WikiBindingServiceStore;
  private readonly crypto: CredentialCrypto;

  constructor(options: {store: WikiBindingServiceStore; crypto: CredentialCrypto}) {
    this.store = options.store;
    this.crypto = options.crypto;
  }

  async getBinding(agentKey: string): Promise<DecryptedWikiBindingRecord | null> {
    const record = await this.store.getBinding(agentKey);
    if (!record) {
      return null;
    }

    return decryptBindingRecord(record, this.crypto);
  }

  async setBinding(input: {
    agentKey: string;
    wikiGroupId: number;
    namespacePath: string;
    apiToken: string;
  }): Promise<DecryptedWikiBindingRecord> {
    const record = await this.store.setBinding({
      agentKey: input.agentKey,
      wikiGroupId: input.wikiGroupId,
      namespacePath: input.namespacePath,
      encryptedApiToken: this.crypto.encrypt(input.apiToken),
    });

    return decryptBindingRecord(record, this.crypto);
  }

  async clearBinding(agentKey: string): Promise<boolean> {
    return this.store.deleteBinding(agentKey);
  }
}
