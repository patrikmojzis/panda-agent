import {SecretCrypto} from "../secrets/crypto.js";
import type {DecryptedWikiBindingRecord, SetWikiBindingInput, WikiBindingRecord} from "./types.js";
import {wikiTokenSecretContext} from "./types.js";

export interface WikiBindingServiceStore {
  deleteBinding(agentKey: string): Promise<boolean>;
  getBinding(agentKey: string): Promise<WikiBindingRecord | null>;
  setBinding(input: SetWikiBindingInput): Promise<WikiBindingRecord>;
}

function decryptBindingRecord(
  record: WikiBindingRecord,
  crypto: SecretCrypto,
): DecryptedWikiBindingRecord {
  return {
    agentKey: record.agentKey,
    wikiGroupId: record.wikiGroupId,
    namespacePath: record.namespacePath,
    apiToken: crypto.open({
      ciphertext: record.apiTokenCiphertext,
      iv: record.apiTokenIv,
      tag: record.apiTokenTag,
      envelopeVersion: record.envelopeVersion,
    }, wikiTokenSecretContext(record.agentKey)),
    envelopeVersion: record.envelopeVersion,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export class WikiBindingService {
  private readonly store: WikiBindingServiceStore;
  private readonly crypto: SecretCrypto;

  constructor(options: {store: WikiBindingServiceStore; crypto: SecretCrypto}) {
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
      encryptedApiToken: this.crypto.seal(input.apiToken, wikiTokenSecretContext(input.agentKey)),
    });

    return decryptBindingRecord(record, this.crypto);
  }

  async clearBinding(agentKey: string): Promise<boolean> {
    return this.store.deleteBinding(agentKey);
  }
}
