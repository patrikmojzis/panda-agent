import type {EncryptedCredentialValue} from "../credentials/index.js";

function trimNonEmpty(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Wiki namespace path must not be empty.");
  }

  return trimmed;
}

export interface WikiBindingRecord {
  agentKey: string;
  wikiGroupId: number;
  namespacePath: string;
  apiTokenCiphertext: Buffer;
  apiTokenIv: Buffer;
  apiTokenTag: Buffer;
  keyVersion: number;
  createdAt: number;
  updatedAt: number;
}

export interface DecryptedWikiBindingRecord {
  agentKey: string;
  wikiGroupId: number;
  namespacePath: string;
  apiToken: string;
  keyVersion: number;
  createdAt: number;
  updatedAt: number;
}

export interface SetWikiBindingInput {
  agentKey: string;
  wikiGroupId: number;
  namespacePath: string;
  encryptedApiToken: EncryptedCredentialValue;
}

export function normalizeWikiNamespacePath(value: string): string {
  return trimNonEmpty(value).replace(/^\/+|\/+$/g, "");
}

export function normalizeWikiGroupId(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("Wiki group id must be a positive integer.");
  }

  return value;
}
