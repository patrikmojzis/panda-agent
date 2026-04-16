import {createCipheriv, createDecipheriv, createHash, randomBytes} from "node:crypto";

import type {CredentialRecord, EncryptedCredentialValue} from "./types.js";

export const CURRENT_CREDENTIAL_KEY_VERSION = 1;
const AES_256_GCM_ALGORITHM = "aes-256-gcm";
const AES_256_GCM_IV_BYTES = 12;

function firstNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

export class CredentialCrypto {
  private readonly key: Buffer;

  constructor(masterKey: string) {
    const normalized = firstNonEmpty(masterKey);
    if (!normalized) {
      throw new Error("CREDENTIALS_MASTER_KEY must not be empty.");
    }

    // v1 keeps the operator UX simple: any long random string works, and we
    // derive the fixed-size AES key in-process instead of forcing a special format.
    this.key = createHash("sha256").update(normalized, "utf8").digest();
  }

  encrypt(value: string): EncryptedCredentialValue {
    const iv = randomBytes(AES_256_GCM_IV_BYTES);
    const cipher = createCipheriv(AES_256_GCM_ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);

    return {
      ciphertext: Buffer.from(ciphertext.toString("base64"), "utf8"),
      iv: Buffer.from(iv.toString("base64"), "utf8"),
      tag: Buffer.from(cipher.getAuthTag().toString("base64"), "utf8"),
      keyVersion: CURRENT_CREDENTIAL_KEY_VERSION,
    };
  }

  decrypt(record: Pick<CredentialRecord, "valueCiphertext" | "valueIv" | "valueTag" | "keyVersion">): string {
    if (record.keyVersion !== CURRENT_CREDENTIAL_KEY_VERSION) {
      throw new Error(`Unsupported credential key version ${String(record.keyVersion)}.`);
    }

    const iv = Buffer.from(record.valueIv.toString("utf8"), "base64");
    const ciphertext = Buffer.from(record.valueCiphertext.toString("utf8"), "base64");
    const tag = Buffer.from(record.valueTag.toString("utf8"), "base64");

    const decipher = createDecipheriv(AES_256_GCM_ALGORITHM, this.key, iv);
    decipher.setAuthTag(tag);

    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  }
}

export function resolveCredentialCrypto(env: NodeJS.ProcessEnv = process.env): CredentialCrypto | null {
  const masterKey = firstNonEmpty(env.CREDENTIALS_MASTER_KEY);
  if (!masterKey) {
    return null;
  }

  return new CredentialCrypto(masterKey);
}
