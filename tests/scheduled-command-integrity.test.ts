import {chmod, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {describe, expect, it} from "vitest";

import {
  HmacScheduledCommandIntegrity,
  loadScheduledCommandIntegrity,
} from "../src/domain/scheduling/scheduled-commands/integrity.js";
import type {ScheduledCommandDefinition} from "../src/domain/scheduling/scheduled-commands/types.js";

function createIntegrity() {
  return new HmacScheduledCommandIntegrity({
    currentKeyId: "v1",
    keys: new Map([["v1", Buffer.alloc(32, 7)]]),
  });
}

function signedDefinition(): ScheduledCommandDefinition {
  const integrity = createIntegrity();
  const signable = {
    commandId: "00000000-0000-4000-8000-000000000001",
    sessionId: "session-main",
    version: 1,
    title: "Sync prices",
    command: "./scripts/sync-prices.sh",
    cwd: "app",
    cron: "0 * * * *",
    timezone: "Europe/Bratislava",
    credentialNames: ["GAS_API_TOKEN", "APP_DATABASE_URL"],
    timeoutMs: 60_000,
    enabled: true,
  };
  return {...signable, ...integrity.sign(signable), createdAt: Date.now()};
}

describe("scheduled command integrity", () => {
  it("verifies the exact executable definition independent of credential input order", () => {
    const integrity = createIntegrity();
    const definition = signedDefinition();
    expect(integrity.verify(definition)).toBe(true);
    expect(integrity.verify({...definition, credentialNames: [...definition.credentialNames].reverse()})).toBe(true);
  });

  it.each([
    ["command", "./scripts/other.sh"],
    ["cwd", "other"],
    ["cron", "5 * * * *"],
    ["timeoutMs", 90_000],
    ["enabled", false],
  ] as const)("rejects a modified %s", (field, value) => {
    const integrity = createIntegrity();
    expect(integrity.verify({...signedDefinition(), [field]: value})).toBe(false);
  });

  it("fails closed when the signing key has been removed", () => {
    const verifier = new HmacScheduledCommandIntegrity({
      currentKeyId: "v2",
      keys: new Map([["v2", Buffer.alloc(32, 8)]]),
    });
    expect(verifier.verify(signedDefinition())).toBe(false);
  });

  it("loads key material directly from the environment", async () => {
    const integrity = await loadScheduledCommandIntegrity({
      PANDA_SCHEDULED_COMMAND_INTEGRITY_KEY: "a".repeat(32),
    });

    expect(integrity).toBeInstanceOf(HmacScheduledCommandIntegrity);
    expect(integrity?.currentKeyId).toMatch(/^sha256:/);
  });

  it("rejects ambiguous inline and file configuration", async () => {
    await expect(loadScheduledCommandIntegrity({
      PANDA_SCHEDULED_COMMAND_INTEGRITY_KEY: "a".repeat(32),
      PANDA_SCHEDULED_COMMAND_INTEGRITY_KEY_FILE: "/tmp/integrity.key",
    })).rejects.toThrow("not both");
  });

  it("loads a private absolute key file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "panda-scheduled-command-key-"));
    const keyFile = join(directory, "integrity.key");
    try {
      await writeFile(keyFile, "a".repeat(32), "utf8");
      await chmod(keyFile, 0o600);
      await expect(loadScheduledCommandIntegrity({
        PANDA_SCHEDULED_COMMAND_INTEGRITY_KEY_FILE: keyFile,
      })).resolves.toBeInstanceOf(HmacScheduledCommandIntegrity);
    } finally {
      await rm(directory, {recursive: true, force: true});
    }
  });

  it("rejects relative or broadly readable key paths", async () => {
    await expect(loadScheduledCommandIntegrity({
      PANDA_SCHEDULED_COMMAND_INTEGRITY_KEY_FILE: "integrity.key",
    })).rejects.toThrow("absolute path");

    if (process.platform === "win32") return;
    const directory = await mkdtemp(join(tmpdir(), "panda-scheduled-command-key-"));
    const keyFile = join(directory, "integrity.key");
    try {
      await writeFile(keyFile, "a".repeat(32), "utf8");
      await chmod(keyFile, 0o644);
      await expect(loadScheduledCommandIntegrity({
        PANDA_SCHEDULED_COMMAND_INTEGRITY_KEY_FILE: keyFile,
      })).rejects.toThrow("chmod 600");
    } finally {
      await rm(directory, {recursive: true, force: true});
    }
  });
});
