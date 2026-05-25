import {spawn} from "node:child_process";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {describe, expect, it} from "vitest";

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
});
