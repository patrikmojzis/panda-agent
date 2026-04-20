import {spawn} from "node:child_process";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {afterEach, describe, expect, it} from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repoRoot, "scripts/docker-stack.sh");
const generatedComposePath = path.join(
  repoRoot,
  ".generated/docker-compose.remote-bash.external-db.runners.yml",
);
const generatedWikiComposePath = path.join(
  repoRoot,
  ".generated/docker-compose.wiki.ssl.yml",
);

interface ScriptResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

describe.sequential("docker-stack.sh", () => {
  const directories: string[] = [];

  afterEach(async () => {
    while (directories.length > 0) {
      await rm(directories.pop() ?? "", {recursive: true, force: true});
    }

    await rm(generatedComposePath, {force: true});
    await rm(generatedWikiComposePath, {force: true});
  });

  async function makeTempDir(prefix: string): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
    directories.push(directory);
    return directory;
  }

  async function createDockerStub(logPath: string): Promise<string> {
    const stubPath = path.join(await makeTempDir("panda-docker-stub-"), "docker");
    await writeFile(stubPath, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${logPath}"
cmd="$*"
case "$cmd" in
  compose*' ps -q panda-core')
    printf 'container-panda-core\\n'
    ;;
  inspect*' container-panda-core')
    printf 'healthy\\n'
    ;;
  *)
    ;;
esac
`, {mode: 0o755});
    return stubPath;
  }

  async function createWikiLocalStub(logPath: string): Promise<string> {
    const stubPath = path.join(await makeTempDir("panda-wiki-local-stub-"), "wiki-local.sh");
    await writeFile(stubPath, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${logPath}"
`, {mode: 0o755});
    return stubPath;
  }

  async function createEnvFile(contents: string): Promise<string> {
    const envPath = path.join(await makeTempDir("panda-stack-env-"), ".env");
    await writeFile(envPath, contents);
    return envPath;
  }

  async function runScript(args: string[], options: {
    envFile: string;
    dockerBin: string;
    homeDir?: string;
    wikiLocalScript?: string;
  }): Promise<ScriptResult> {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    return await new Promise((resolve, reject) => {
      const child = spawn("bash", [scriptPath, ...args], {
        cwd: repoRoot,
        env: {
          ...process.env,
          HOME: options.homeDir ?? process.env.HOME,
          PANDA_DOCKER_BIN: options.dockerBin,
          PANDA_STACK_ENV_FILE: options.envFile,
          PANDA_WIKI_LOCAL_SCRIPT: options.wikiLocalScript ?? process.env.PANDA_WIKI_LOCAL_SCRIPT,
        },
      });

      child.stdout.on("data", (chunk) => {
        stdoutChunks.push(Buffer.from(chunk));
      });
      child.stderr.on("data", (chunk) => {
        stderrChunks.push(Buffer.from(chunk));
      });
      child.on("error", reject);
      child.on("close", (exitCode) => {
        resolve({
          exitCode: exitCode ?? 1,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
        });
      });
    });
  }

  it("fails when PANDA_AGENTS contains duplicates after normalization", async () => {
    const logPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const dockerBin = await createDockerStub(logPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "PANDA_AGENTS=Claw,claw",
    ].join("\n"));

    const result = await runScript(["up"], {
      envFile,
      dockerBin,
      homeDir: await makeTempDir("panda-home-"),
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("duplicate agent key after normalization: claw");
  });

  it("renders an empty override and skips agent ensure when no agents are declared", async () => {
    const logPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const dockerBin = await createDockerStub(logPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "PANDA_AGENTS=",
    ].join("\n"));

    const result = await runScript(["up"], {
      envFile,
      dockerBin,
      homeDir: await makeTempDir("panda-home-"),
    });

    expect(result.exitCode).toBe(0);
    expect(await readFile(generatedComposePath, "utf8")).toBe("services: {}\n");
    expect(await readFile(logPath, "utf8")).not.toContain("panda agent ensure");
  });

  it("renders one runner per agent, enables telegram automatically, and maps agent logs to runner services", async () => {
    const logPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const dockerBin = await createDockerStub(logPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "TELEGRAM_BOT_TOKEN=telegram-token",
      "PANDA_AGENTS=claw,Luna",
    ].join("\n"));

    const homeDir = await makeTempDir("panda-home-");
    const upResult = await runScript(["up", "--build"], {
      envFile,
      dockerBin,
      homeDir,
    });

    expect(upResult.exitCode).toBe(0);
    const generatedCompose = await readFile(generatedComposePath, "utf8");
    expect(generatedCompose).toContain("panda-runner-claw");
    expect(generatedCompose).toContain("panda-runner-luna");
    expect(generatedCompose).not.toContain("panda-runner-Luna");

    const logContents = await readFile(logPath, "utf8");
    expect(logContents).toContain("--profile telegram");
    expect(logContents).toContain("compose --env-file");
    expect(logContents).toContain("up -d --build --remove-orphans");
    expect(logContents).toContain("exec -T panda-core panda agent ensure claw");
    expect(logContents).toContain("exec -T panda-core panda agent ensure luna");

    const logsResult = await runScript(["logs", "Luna"], {
      envFile,
      dockerBin,
      homeDir,
    });
    expect(logsResult.exitCode).toBe(0);
    expect(await readFile(logPath, "utf8")).toContain("logs -f panda-runner-luna");
  });

  it("always includes the wiki compose file and maps wiki logs", async () => {
    const logPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const dockerBin = await createDockerStub(logPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "PANDA_AGENTS=",
    ].join("\n"));

    const homeDir = await makeTempDir("panda-home-");
    const upResult = await runScript(["up"], {
      envFile,
      dockerBin,
      homeDir,
    });

    expect(upResult.exitCode).toBe(0);
    const logContents = await readFile(logPath, "utf8");
    expect(logContents).toContain("docker-compose.wiki.yml");

    const logsResult = await runScript(["logs", "wiki"], {
      envFile,
      dockerBin,
      homeDir,
    });
    expect(logsResult.exitCode).toBe(0);
    expect(await readFile(logPath, "utf8")).toContain("logs -f wiki");
  });

  it("bootstraps wiki for all declared agents when admin credentials are set", async () => {
    const dockerLogPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const wikiLogPath = path.join(await makeTempDir("panda-wiki-log-"), "wiki.log");
    const dockerBin = await createDockerStub(dockerLogPath);
    const wikiLocalScript = await createWikiLocalStub(wikiLogPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "PANDA_AGENTS=claw,Luna",
      "WIKI_ADMIN_EMAIL=admin@localhost",
      "WIKI_ADMIN_PASSWORD=secret",
    ].join("\n"));

    const homeDir = await makeTempDir("panda-home-");
    const upResult = await runScript(["up"], {
      envFile,
      dockerBin,
      homeDir,
      wikiLocalScript,
    });

    expect(upResult.exitCode).toBe(0);
    expect(await readFile(wikiLogPath, "utf8")).toContain("bootstrap claw luna");
  });
});
