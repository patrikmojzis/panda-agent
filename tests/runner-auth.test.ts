import {execFile} from "node:child_process";
import {chmod, mkdtemp, readFile, rm, symlink, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {promisify} from "node:util";

import {afterEach, describe, expect, it} from "vitest";

import {
  executionEnvironmentRunnerAuthScope,
  HmacRunnerTokenAuthority,
  loadRunnerTokenAuthority,
  runnerAuthScopeForEnvironment,
} from "../src/integrations/shell/runner-auth.js";

const execFileAsync = promisify(execFile);

describe("runner token authority", () => {
  const directories: string[] = [];

  afterEach(async () => {
    while (directories.length > 0) {
      await rm(directories.pop() ?? "", {recursive: true, force: true});
    }
  });

  it("derives stable, distinct tokens for agent and environment boundaries", () => {
    const authority = new HmacRunnerTokenAuthority(Buffer.alloc(32, 7));
    const panda = authority.derive({kind: "persistent-agent", agentKey: "panda", scopeId: "panda"});
    expect(panda).toBe(authority.derive({kind: "persistent-agent", agentKey: "panda", scopeId: "panda"}));
    expect(authority.derive({kind: "persistent-agent", agentKey: "luna", scopeId: "luna"})).not.toBe(panda);
    expect(authority.derive(executionEnvironmentRunnerAuthScope("panda", "env-a"))).not.toBe(panda);
    expect(authority.derive(executionEnvironmentRunnerAuthScope("panda", "env-b")))
      .not.toBe(authority.derive(executionEnvironmentRunnerAuthScope("panda", "env-a")));
  });

  it("uses the persistent agent scope only for fallback execution", () => {
    expect(runnerAuthScopeForEnvironment("panda", {
      id: "persistent_agent_runner:panda",
      agentKey: "panda",
      kind: "persistent_agent_runner",
      source: "fallback",
    })).toEqual({kind: "persistent-agent", agentKey: "panda", scopeId: "panda"});
    expect(runnerAuthScopeForEnvironment("panda", {
      id: "env-vps",
      agentKey: "panda",
      kind: "persistent_agent_runner",
      source: "binding",
    })).toEqual({kind: "execution-environment", agentKey: "panda", scopeId: "env-vps"});
    expect(() => runnerAuthScopeForEnvironment("panda", {
      id: "env-luna",
      agentKey: "luna",
      kind: "persistent_agent_runner",
      source: "binding",
    })).toThrow("does not belong to agent panda");
  });

  it("loads only an owner-private regular master-key file", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "panda-runner-auth-"));
    directories.push(directory);
    const keyFile = path.join(directory, "master-key");
    await writeFile(keyFile, `base64:${Buffer.alloc(48, 3).toString("base64")}\n`, {mode: 0o600});
    const authority = loadRunnerTokenAuthority({PANDA_RUNNER_TOKEN_MASTER_KEY_FILE: keyFile});
    expect(authority?.derive({kind: "persistent-agent", agentKey: "panda", scopeId: "panda"}))
      .toMatch(/^[A-Za-z0-9_-]{43}$/);

    await chmod(keyFile, 0o644);
    expect(() => loadRunnerTokenAuthority({PANDA_RUNNER_TOKEN_MASTER_KEY_FILE: keyFile}))
      .toThrow("must not be accessible by group or other users");

    const link = path.join(directory, "master-link");
    await symlink(keyFile, link);
    expect(() => loadRunnerTokenAuthority({PANDA_RUNNER_TOKEN_MASTER_KEY_FILE: link}))
      .toThrow("regular file, not a symlink");
  });

  it("keeps stack token derivation byte-for-byte compatible with Core", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "panda-runner-auth-script-"));
    directories.push(directory);
    const key = Buffer.alloc(48, 5);
    const keyFile = path.join(directory, "master-key");
    await writeFile(keyFile, `base64:${key.toString("base64")}\n`, {mode: 0o600});

    const {stdout} = await execFileAsync(process.execPath, [
      path.resolve("scripts/derive-runner-token.mjs"),
      keyFile,
      "execution-environment",
      "panda",
      "env-a",
    ]);

    expect(stdout).toBe(new HmacRunnerTokenAuthority(key).derive(
      executionEnvironmentRunnerAuthScope("panda", "env-a"),
    ));
  });

  it("rejects missing entropy and ambiguous key sources", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "panda-runner-auth-short-"));
    directories.push(directory);
    const keyFile = path.join(directory, "master-key");
    await writeFile(keyFile, "short\n", {mode: 0o600});
    expect(() => loadRunnerTokenAuthority({PANDA_RUNNER_TOKEN_MASTER_KEY_FILE: keyFile}))
      .toThrow("at least 32 bytes");
    expect(() => loadRunnerTokenAuthority({
      PANDA_RUNNER_TOKEN_MASTER_KEY: `base64:${"a".repeat(44)}!`,
    })).toThrow("invalid base64 encoding");
    expect(() => loadRunnerTokenAuthority({
      PANDA_RUNNER_TOKEN_MASTER_KEY: "x".repeat(32),
      PANDA_RUNNER_TOKEN_MASTER_KEY_FILE: keyFile,
    })).toThrow("not both");
    await expect(readFile(keyFile, "utf8")).resolves.toBe("short\n");
  });
});
