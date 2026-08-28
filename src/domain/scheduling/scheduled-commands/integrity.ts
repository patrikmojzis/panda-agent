import {createHash, createHmac, timingSafeEqual} from "node:crypto";
import {lstat, readFile} from "node:fs/promises";
import {isAbsolute} from "node:path";

import {isRecord} from "../../../lib/records.js";
import type {ScheduledCommandDefinition} from "./types.js";

const MINIMUM_KEY_BYTES = 32;
const INTEGRITY_SCHEMA_VERSION = 1;

type SignableScheduledCommandDefinition = Omit<ScheduledCommandDefinition, "keyId" | "integrityTag" | "createdAt">;

export interface ScheduledCommandIntegrity {
  readonly currentKeyId: string;
  sign(definition: SignableScheduledCommandDefinition): {keyId: string; integrityTag: string};
  verify(definition: ScheduledCommandDefinition): boolean;
}

function canonicalDefinition(definition: SignableScheduledCommandDefinition): string {
  return JSON.stringify({
    schemaVersion: INTEGRITY_SCHEMA_VERSION,
    commandId: definition.commandId,
    sessionId: definition.sessionId,
    version: definition.version,
    title: definition.title,
    command: definition.command,
    cwd: definition.cwd ?? null,
    cron: definition.cron,
    timezone: definition.timezone,
    credentialNames: [...definition.credentialNames].sort(),
    timeoutMs: definition.timeoutMs,
    enabled: definition.enabled,
  });
}

function decodeKey(value: string): Buffer {
  const normalized = value.trim();
  const key = normalized.startsWith("base64:")
    ? Buffer.from(normalized.slice("base64:".length), "base64")
    : Buffer.from(normalized, "utf8");
  if (key.byteLength < MINIMUM_KEY_BYTES) {
    throw new Error(`Scheduled command integrity keys must contain at least ${MINIMUM_KEY_BYTES} bytes.`);
  }
  return key;
}

function parseKeyFile(contents: string): {currentKeyId: string; keys: ReadonlyMap<string, Buffer>} {
  const trimmed = contents.trim();
  if (!trimmed) {
    throw new Error("Scheduled command integrity key file must not be empty.");
  }

  if (!trimmed.startsWith("{")) {
    const key = decodeKey(trimmed);
    const keyId = `sha256:${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
    return {currentKeyId: keyId, keys: new Map([[keyId, key]])};
  }

  const parsed: unknown = JSON.parse(trimmed);
  if (!isRecord(parsed) || typeof parsed.currentKeyId !== "string" || !isRecord(parsed.keys)) {
    throw new Error("Scheduled command integrity keyring must contain currentKeyId and keys.");
  }
  const currentKeyId = parsed.currentKeyId.trim();
  if (!currentKeyId) {
    throw new Error("Scheduled command integrity currentKeyId must not be empty.");
  }
  const keys = new Map<string, Buffer>();
  for (const [keyId, value] of Object.entries(parsed.keys)) {
    if (!keyId.trim() || typeof value !== "string") {
      throw new Error("Scheduled command integrity keyring entries must be non-empty strings.");
    }
    keys.set(keyId, decodeKey(value));
  }
  if (!keys.has(currentKeyId)) {
    throw new Error(`Scheduled command integrity keyring is missing current key ${currentKeyId}.`);
  }
  return {currentKeyId, keys};
}

export class HmacScheduledCommandIntegrity implements ScheduledCommandIntegrity {
  readonly currentKeyId: string;
  private readonly keys: ReadonlyMap<string, Buffer>;

  constructor(input: {currentKeyId: string; keys: ReadonlyMap<string, Buffer>}) {
    this.currentKeyId = input.currentKeyId;
    this.keys = input.keys;
  }

  sign(definition: SignableScheduledCommandDefinition): {keyId: string; integrityTag: string} {
    const key = this.keys.get(this.currentKeyId);
    if (!key) {
      throw new Error(`Scheduled command integrity key ${this.currentKeyId} is unavailable.`);
    }
    return {
      keyId: this.currentKeyId,
      integrityTag: createHmac("sha256", key).update(canonicalDefinition(definition)).digest("hex"),
    };
  }

  verify(definition: ScheduledCommandDefinition): boolean {
    const key = this.keys.get(definition.keyId);
    if (!key || !/^[a-f0-9]{64}$/.test(definition.integrityTag)) {
      return false;
    }
    const expected = createHmac("sha256", key)
      .update(canonicalDefinition(definition))
      .digest();
    return timingSafeEqual(expected, Buffer.from(definition.integrityTag, "hex"));
  }
}

export async function loadScheduledCommandIntegrity(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ScheduledCommandIntegrity | null> {
  const inlineKey = env.PANDA_SCHEDULED_COMMAND_INTEGRITY_KEY?.trim();
  const keyFile = env.PANDA_SCHEDULED_COMMAND_INTEGRITY_KEY_FILE?.trim();
  if (inlineKey && keyFile) {
    throw new Error(
      "Set PANDA_SCHEDULED_COMMAND_INTEGRITY_KEY or PANDA_SCHEDULED_COMMAND_INTEGRITY_KEY_FILE, not both.",
    );
  }
  if (inlineKey) {
    return new HmacScheduledCommandIntegrity(parseKeyFile(inlineKey));
  }
  if (!keyFile) {
    return null;
  }
  if (!isAbsolute(keyFile)) {
    throw new Error("PANDA_SCHEDULED_COMMAND_INTEGRITY_KEY_FILE must be an absolute path.");
  }
  const keyFileStat = await lstat(keyFile);
  if (!keyFileStat.isFile() || keyFileStat.isSymbolicLink()) {
    throw new Error("Scheduled command integrity key path must be a regular file, not a symlink.");
  }
  if (process.platform !== "win32" && (keyFileStat.mode & 0o077) !== 0) {
    throw new Error("Scheduled command integrity key file must not be accessible by group or other users (use chmod 600).");
  }
  return new HmacScheduledCommandIntegrity(parseKeyFile(await readFile(keyFile, "utf8")));
}
