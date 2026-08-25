import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from "node:crypto";

import {trimToNull} from "../../lib/strings.js";

export const CURRENT_SECRET_ENVELOPE_VERSION = 2;

const AES_256_GCM_ALGORITHM = "aes-256-gcm";
const AES_256_GCM_IV_BYTES = 12;
const DERIVATION_SALT = Buffer.from("panda-secret-envelope-v2", "utf8");

export interface EncryptedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  envelopeVersion: number;
}

export interface SecretContext {
  purpose: string;
  identity: readonly string[];
}

function encodeContext(context: SecretContext): Buffer {
  const purpose = context.purpose.trim();
  if (!purpose) {
    throw new Error("Secret context purpose must not be empty.");
  }
  if (context.identity.some((part) => part.length === 0)) {
    throw new Error("Secret context identity parts must not be empty.");
  }

  return Buffer.from(JSON.stringify(["panda-secret", CURRENT_SECRET_ENVELOPE_VERSION, purpose, ...context.identity]), "utf8");
}

function decodeBase64(value: Buffer): Buffer {
  return Buffer.from(value.toString("utf8"), "base64");
}

export class SecretCrypto {
  private readonly rootKey: Buffer;

  constructor(masterKey: string) {
    const normalized = trimToNull(masterKey);
    if (!normalized) {
      throw new Error("CREDENTIALS_MASTER_KEY must not be empty.");
    }

    this.rootKey = createHash("sha256").update(normalized, "utf8").digest();
  }

  seal(value: string, context: SecretContext): EncryptedSecret {
    const aad = encodeContext(context);
    const key = this.deriveKey(context.purpose.trim());
    const iv = randomBytes(AES_256_GCM_IV_BYTES);
    const cipher = createCipheriv(AES_256_GCM_ALGORITHM, key, iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);

    return {
      ciphertext: Buffer.from(ciphertext.toString("base64"), "utf8"),
      iv: Buffer.from(iv.toString("base64"), "utf8"),
      tag: Buffer.from(cipher.getAuthTag().toString("base64"), "utf8"),
      envelopeVersion: CURRENT_SECRET_ENVELOPE_VERSION,
    };
  }

  open(encrypted: EncryptedSecret, context: SecretContext): string {
    if (encrypted.envelopeVersion !== CURRENT_SECRET_ENVELOPE_VERSION) {
      throw new Error(`Unsupported secret envelope version ${String(encrypted.envelopeVersion)}.`);
    }

    const decipher = createDecipheriv(
      AES_256_GCM_ALGORITHM,
      this.deriveKey(context.purpose.trim()),
      decodeBase64(encrypted.iv),
    );
    decipher.setAAD(encodeContext(context));
    decipher.setAuthTag(decodeBase64(encrypted.tag));

    return Buffer.concat([
      decipher.update(decodeBase64(encrypted.ciphertext)),
      decipher.final(),
    ]).toString("utf8");
  }

  private deriveKey(purpose: string): Buffer {
    return Buffer.from(hkdfSync("sha256", this.rootKey, DERIVATION_SALT, Buffer.from(purpose, "utf8"), 32));
  }
}

export function resolveSecretCrypto(env: NodeJS.ProcessEnv = process.env): SecretCrypto | null {
  const masterKey = trimToNull(env.CREDENTIALS_MASTER_KEY);
  return masterKey ? new SecretCrypto(masterKey) : null;
}
