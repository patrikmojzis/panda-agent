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
});
