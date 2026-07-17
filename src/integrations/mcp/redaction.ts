import {StringDecoder} from "node:string_decoder";

import {normalizeToJsonValue, type JsonValue} from "../../lib/json.js";

export class McpRedactionCollisionError extends Error {
  constructor() {
    super("MCP redaction produced duplicate object keys.");
    this.name = "McpRedactionCollisionError";
  }
}

export function exactSecretInventory(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))]
    .sort((left, right) => right.length - left.length);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactExactString(value: string, secrets: readonly string[]): string {
  const inventory = exactSecretInventory(secrets);
  if (inventory.length === 0) return value;
  return value.replace(new RegExp(inventory.map(escapeRegExp).join("|"), "gu"), "[redacted]");
}

export function redactExactJson(value: unknown, secrets: readonly string[]): JsonValue {
  const inventory = exactSecretInventory(secrets);
  function visit(entry: JsonValue): JsonValue {
    if (typeof entry === "string") return redactExactString(entry, inventory);
    if (Array.isArray(entry)) return entry.map(visit);
    if (entry && typeof entry === "object") {
      const result: Record<string, JsonValue> = {};
      for (const [key, child] of Object.entries(entry)) {
        const redactedKey = redactExactString(key, inventory);
        if (Object.prototype.hasOwnProperty.call(result, redactedKey)) {
          throw new McpRedactionCollisionError();
        }
        Object.defineProperty(result, redactedKey, {
          value: visit(child),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return result;
    }
    return entry;
  }
  return visit(normalizeToJsonValue(value));
}

/** Holds raw suffix bytes until split secrets can be matched, then stores only redacted text. */
export class StreamingSecretRedactor {
  private readonly decoder = new StringDecoder("utf8");
  private readonly secrets: readonly string[];
  private readonly maxSecretLength: number;
  private pending = "";
  private finished = false;

  constructor(values: readonly string[], private readonly emit: (redacted: string) => void) {
    this.secrets = exactSecretInventory(values);
    this.maxSecretLength = Math.max(0, ...this.secrets.map((secret) => secret.length));
  }

  append(chunk: Buffer | string): void {
    if (this.finished) return;
    const decoded = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    this.process(decoded, false);
  }

  finish(): void {
    if (this.finished) return;
    this.process(this.decoder.end(), true);
    this.finished = true;
  }

  private process(decoded: string, final: boolean): void {
    const combined = this.pending + decoded;
    if (final || this.maxSecretLength <= 1) {
      this.pending = "";
      if (combined) this.emit(redactExactString(combined, this.secrets));
      return;
    }

    let cutoff = Math.max(0, combined.length - (this.maxSecretLength - 1));
    for (const secret of this.secrets) {
      let start = combined.lastIndexOf(secret, cutoff);
      while (start >= 0) {
        if (start < cutoff && start + secret.length > cutoff) cutoff = start;
        start = combined.lastIndexOf(secret, start - 1);
      }
    }
    const safe = combined.slice(0, cutoff);
    this.pending = combined.slice(cutoff);
    if (safe) this.emit(redactExactString(safe, this.secrets));
  }
}
