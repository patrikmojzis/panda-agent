import {spawn} from "node:child_process";
import {chmod, mkdtemp, realpath, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {afterEach, describe, expect, it} from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repoRoot, "scripts/run-docker-runner.sh");

interface ScriptResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runScript(env: Record<string, string | undefined>): Promise<ScriptResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [scriptPath, "panda", "--dry-run"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({exitCode: code ?? 1, stdout, stderr});
    });
  });
}

describe("run-docker-runner.sh", () => {
  const directories: string[] = [];

  async function createDockerStub(directory: string): Promise<string> {
    const dockerPath = path.join(directory, "docker");
    await writeFile(dockerPath, "#!/bin/sh\nexit 0\n", {mode: 0o755});
    return `${directory}:/usr/bin:/bin`;
  }

  afterEach(async () => {
    while (directories.length > 0) {
      await rm(directories.pop() ?? "", {recursive: true, force: true});
    }
  });

  it.each([
    ["RUNNER_IMAGE", "BASH_SERVER_IMAGE"],
    ["RUNNER_ENV_FILE", "BASH_SERVER_ENV_FILE"],
  ])("fails fast on deprecated script-only %s env", async (oldName, newName) => {
    const result = await runScript({
      [oldName]: "old",
      [newName]: "new",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`${oldName} was renamed to ${newName}`);
    expect(result.stderr).toContain("no RUNNER_* aliases");
  });

  it("refuses an unsafe runner env file before invoking Docker", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "panda-runner-env-"));
    directories.push(directory);
    const envFile = path.join(directory, ".env");
    await writeFile(envFile, "BASH_SERVER_SHARED_SECRET=secret\n", {mode: 0o600});
    await chmod(envFile, 0o644);

    const result = await runScript({
      BASH_SERVER_ENV_FILE: envFile,
      PATH: "/usr/bin:/bin",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("refusing to load secret-bearing env file");
    expect(result.stderr).toContain("current mode: 0644");
    expect(result.stderr).toContain(`chmod 600 ${await realpath(envFile)}`);
  });

  it("mounts a private scoped token file without exposing its value in Docker metadata", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "panda-runner-token-"));
    directories.push(directory);
    const tokenFile = path.join(directory, "panda.token");
    await writeFile(tokenFile, "scoped-runner-token\n", {mode: 0o600});
    const result = await runScript({
      BASH_SERVER_ENV_FILE: path.join(directory, "missing.env"),
      BASH_SERVER_AUTH_TOKEN_FILE: tokenFile,
      BASH_SERVER_SHARED_SECRET: "legacy-global-token",
      HOME: directory,
      PATH: await createDockerStub(directory),
    });

    expect(result.exitCode, JSON.stringify(result)).toBe(0);
    expect(result.stdout).toContain("runner auth: scoped token file");
    expect(result.stdout).toContain("BASH_SERVER_AUTH_TOKEN_FILE=/run/secrets/panda-runner/token");
    expect(result.stdout).toContain(`${tokenFile}:/run/secrets/panda-runner/token:ro`);
    expect(result.stdout).toContain("--network panda-runner-panda-net");
    expect(result.stdout).toContain("-p 127.0.0.1:8080:8080");
    expect(result.stdout).not.toContain("scoped-runner-token");
    expect(result.stdout).not.toContain("BASH_SERVER_SHARED_SECRET");
    expect(result.stdout).not.toContain("legacy-global-token");
  });

  it("rejects inline scoped tokens rather than exposing them through Docker inspect", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "panda-runner-token-"));
    directories.push(directory);
    const result = await runScript({
      BASH_SERVER_ENV_FILE: path.join(directory, "missing.env"),
      BASH_SERVER_AUTH_TOKEN: "scoped-runner-token",
      HOME: directory,
      PATH: await createDockerStub(directory),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("does not pass inline runner tokens through Docker metadata");
    expect(result.stdout).not.toContain("scoped-runner-token");
    expect(result.stderr).not.toContain("scoped-runner-token");
  });
});
