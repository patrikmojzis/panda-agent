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
const generatedPublicCaddyfilePath = path.join(repoRoot, ".generated/Caddyfile.public-edge");
const baseComposePath = path.join(repoRoot, "examples/docker-compose.remote-bash.external-db.yml");
const appsEdgeComposePath = path.join(repoRoot, "examples/docker-compose.apps-edge.yml");

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
    await rm(generatedPublicCaddyfilePath, {force: true});
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
  image' 'inspect*)
    exit 1
    ;;
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

  async function createExistingWorkspaceImageDockerStub(logPath: string): Promise<string> {
    const stubPath = path.join(await makeTempDir("panda-docker-stub-"), "docker");
    await writeFile(stubPath, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${logPath}"
cmd="$*"
case "$cmd" in
  image' 'inspect' 'panda-workspace:*)
    exit 0
    ;;
  image' 'inspect*)
    exit 1
    ;;
  compose*' ps -q panda-core')
    printf 'container-panda-core\n'
    ;;
  inspect*' container-panda-core')
    printf 'healthy\n'
    ;;
  *)
    ;;
esac
`, {mode: 0o755});
    return stubPath;
  }

  async function createSynchronizedBuildDockerStub(logPath: string): Promise<string> {
    const syncDir = await makeTempDir("panda-docker-sync-");
    const stubPath = path.join(await makeTempDir("panda-docker-stub-"), "docker");
    await writeFile(stubPath, `#!/usr/bin/env bash
set -euo pipefail

log() {
  printf '%s\\n' "$1" >> "${logPath}"
}

cmd="$*"
log "START $cmd"

case "$cmd" in
  image' 'inspect*)
    exit 1
    ;;
  build*'--target browser-runner '*)
    touch "${syncDir}/browser-runner.started"
    attempts=0
    while [[ ! -f "${syncDir}/runner.started" && "$attempts" -lt 200 ]]; do
      attempts=$((attempts + 1))
      sleep 0.01
    done
    ;;
  build*'--target bash-runner '*)
    touch "${syncDir}/runner.started"
    attempts=0
    while [[ ! -f "${syncDir}/browser-runner.started" && "$attempts" -lt 200 ]]; do
      attempts=$((attempts + 1))
      sleep 0.01
    done
    ;;
  compose*' ps -q panda-core')
    printf 'container-panda-core\\n'
    ;;
  inspect*' container-panda-core')
    printf 'healthy\\n'
    ;;
  *)
    ;;
esac

log "END $cmd"
`, {mode: 0o755});
    return stubPath;
  }

  async function createWikiLocalStub(logPath: string): Promise<string> {
    const stubPath = path.join(await makeTempDir("panda-wiki-local-stub-"), "wiki-local.sh");
    await writeFile(stubPath, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${logPath}"
printf 'DATABASE_URL=%s\\n' "\${DATABASE_URL-}" >> "${logPath}"
printf 'WIKI_DB_URL=%s\\n' "\${WIKI_DB_URL-}" >> "${logPath}"
`, {mode: 0o755});
    return stubPath;
  }

  async function createFailingWikiLocalStub(): Promise<string> {
    const stubPath = path.join(await makeTempDir("panda-wiki-local-stub-"), "wiki-local.sh");
    await writeFile(stubPath, `#!/usr/bin/env bash
set -euo pipefail
printf 'wiki-local should not be called\n' >&2
exit 42
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
    env?: Record<string, string>;
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
          ...options.env,
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

  function extractWorkspaceImage(compose: string): string {
    const match = compose.match(/PANDA_DISPOSABLE_WORKSPACE_IMAGE: \${PANDA_DISPOSABLE_WORKSPACE_IMAGE:-(panda-workspace:[a-f0-9]{16})}/);
    expect(match).not.toBeNull();
    return match?.[1] ?? "";
  }

  it("fails when PANDA_AGENTS contains duplicates after normalization", async () => {
    const logPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const dockerBin = await createDockerStub(logPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
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
      "WIKI_DB_URL=postgresql://example/wiki",
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
    expect(await readFile(generatedWikiComposePath, "utf8")).not.toContain("ports:");
    expect(await readFile(logPath, "utf8")).not.toContain("panda agent ensure");
  });

  it("enables Control through panda-core with a loopback-only publish by default", async () => {
    const logPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const dockerBin = await createDockerStub(logPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "PANDA_AGENTS=",
      "PANDA_CONTROL_ENABLED=true",
    ].join("\n"));

    const result = await runScript(["up"], {
      envFile,
      dockerBin,
      homeDir: await makeTempDir("panda-home-"),
    });

    expect(result.exitCode).toBe(0);
    const compose = await readFile(generatedComposePath, "utf8");
    expect(compose).toContain("panda-core:");
    expect(compose).toContain('PANDA_CONTROL_ENABLED: "true"');
    expect(compose).toContain("PANDA_CONTROL_HOST: 0.0.0.0");
    expect(compose).toContain("PANDA_CONTROL_PORT: ${PANDA_CONTROL_PORT:-4767}");
    expect(compose).toContain("PANDA_CONTROL_UI_DIR: ${PANDA_CONTROL_UI_DIR:-/app/control-ui}");
    expect(compose).toContain('"${PANDA_CONTROL_PUBLISH_HOST:-127.0.0.1}:${PANDA_CONTROL_PUBLISH_PORT:-${PANDA_CONTROL_PORT:-4767}}:${PANDA_CONTROL_PORT:-4767}"');
  });

  it("keeps Control publish disabled unless PANDA_CONTROL_ENABLED is truthy", async () => {
    const logPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const dockerBin = await createDockerStub(logPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "PANDA_AGENTS=",
    ].join("\n"));

    const result = await runScript(["up"], {
      envFile,
      dockerBin,
      homeDir: await makeTempDir("panda-home-"),
    });

    expect(result.exitCode).toBe(0);
    const compose = await readFile(generatedComposePath, "utf8");
    expect(compose).toBe("services: {}\n");
    expect(compose).not.toContain("PANDA_CONTROL_PUBLISH_HOST");
  });

  it("preserves explicit Control publish host and port overrides in generated compose", async () => {
    const logPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const dockerBin = await createDockerStub(logPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "PANDA_AGENTS=",
      "PANDA_CONTROL_ENABLED=true",
      "PANDA_CONTROL_PUBLISH_HOST=100.64.0.10",
      "PANDA_CONTROL_PUBLISH_PORT=14767",
      "PANDA_CONTROL_PORT=4768",
    ].join("\n"));

    const result = await runScript(["up"], {
      envFile,
      dockerBin,
      homeDir: await makeTempDir("panda-home-"),
    });

    expect(result.exitCode).toBe(0);
    const log = await readFile(logPath, "utf8");
    expect(log).toContain("--env-file");
    const compose = await readFile(generatedComposePath, "utf8");
    expect(compose).toContain('"${PANDA_CONTROL_PUBLISH_HOST:-127.0.0.1}:${PANDA_CONTROL_PUBLISH_PORT:-${PANDA_CONTROL_PORT:-4767}}:${PANDA_CONTROL_PORT:-4767}"');
    expect(result.stdout).toContain("Control: http://100.64.0.10:14767");
  });

  it("builds only app and browser images when no agents are declared", async () => {
    const logPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const dockerBin = await createDockerStub(logPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "PANDA_AGENTS=",
    ].join("\n"));

    const result = await runScript(["up", "--build"], {
      envFile,
      dockerBin,
      homeDir: await makeTempDir("panda-home-"),
    });

    expect(result.exitCode).toBe(0);
    const logContents = await readFile(logPath, "utf8");
    expect(logContents.match(/build --target app -t panda-app:latest/g)).toHaveLength(1);
    expect(logContents.match(/build --target browser-runner -t panda-browser-runner:latest/g)).toHaveLength(1);
    expect(logContents).not.toContain("build --target bash-runner --build-arg NODE_MAJOR=22 -t panda-runner:latest");
    expect(logContents).toContain("up -d --no-build --remove-orphans");
    expect(logContents).not.toContain("up -d --build --remove-orphans");
  });

  it("renders managed disposable environment infrastructure on private networks", async () => {
    const logPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const dockerBin = await createDockerStub(logPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "PANDA_AGENTS=",
      "PANDA_DISPOSABLE_ENVIRONMENTS_ENABLED=true",
      "PANDA_EXECUTION_ENVIRONMENT_MANAGER_TOKEN=environment-manager-token",
    ].join("\n"));
    const homeDir = await makeTempDir("panda-home-");

    const upResult = await runScript(["up", "--build"], {
      envFile,
      dockerBin,
      homeDir,
    });

    expect(upResult.exitCode).toBe(0);
    expect(upResult.stdout).toContain("./scripts/docker-stack.sh logs environment-manager");
    const generatedCompose = await readFile(generatedComposePath, "utf8");
    const environmentsRoot = path.join(homeDir, ".panda", "environments");
    expect(generatedCompose).toContain("panda-environment-manager:");
    expect(generatedCompose).toContain('command: ["environment-manager"]');
    expect(generatedCompose).toContain("PANDA_DOCKER_HOST: ${PANDA_DOCKER_HOST:-unix:///var/run/docker.sock}");
    expect(generatedCompose).toContain('- "/var/run/docker.sock:/var/run/docker.sock"');
    expect(generatedCompose).toContain(`PANDA_ENVIRONMENTS_HOST_ROOT: ${environmentsRoot}`);
    expect(generatedCompose).toContain("PANDA_ENVIRONMENTS_ROOT: ${PANDA_ENVIRONMENTS_ROOT:-/root/.panda/environments}");
    expect(generatedCompose).toContain("PANDA_CORE_ENVIRONMENTS_ROOT: ${PANDA_CORE_ENVIRONMENTS_ROOT:-${PANDA_ENVIRONMENTS_ROOT:-/root/.panda/environments}}");
    expect(generatedCompose).toContain("PANDA_RUNNER_ENVIRONMENTS_ROOT: ${PANDA_RUNNER_ENVIRONMENTS_ROOT:-/environments}");
    expect(generatedCompose).toContain(`- "${environmentsRoot}:${"${PANDA_ENVIRONMENTS_ROOT:-/root/.panda/environments}"}"`);
    expect(generatedCompose).toContain("PANDA_EXECUTION_ENVIRONMENT_MANAGER_URL: ${PANDA_EXECUTION_ENVIRONMENT_MANAGER_URL}");
    expect(generatedCompose).toContain("PANDA_EXECUTION_ENVIRONMENT_MANAGER_TOKEN: ${PANDA_EXECUTION_ENVIRONMENT_MANAGER_TOKEN}");
    expect(generatedCompose).toContain("BASH_SERVER_SHARED_SECRET: ${BASH_SERVER_SHARED_SECRET:-}");
    expect(generatedCompose).toContain("PANDA_DISPOSABLE_CONTROL_RUNNER_IMAGE: ${PANDA_DISPOSABLE_CONTROL_RUNNER_IMAGE:-${PANDA_DISPOSABLE_RUNNER_IMAGE:-panda-runner:latest}}");
    const workspaceDefaultMatch = generatedCompose.match(/PANDA_DISPOSABLE_WORKSPACE_IMAGE: \${PANDA_DISPOSABLE_WORKSPACE_IMAGE:-panda-workspace:([a-f0-9]{16})}/);
    expect(workspaceDefaultMatch).not.toBeNull();
    const workspaceImage = `panda-workspace:${workspaceDefaultMatch?.[1]}`;
    const managerStart = generatedCompose.indexOf("  panda-environment-manager:");
    const gatewayStart = generatedCompose.indexOf("  panda-gateway:");
    const managerSection = generatedCompose.slice(managerStart, gatewayStart >= 0 ? gatewayStart : generatedCompose.indexOf("\nnetworks:"));
    expect(managerSection).toContain("PANDA_EXECUTION_ENVIRONMENT_MANAGER_URL: ${PANDA_EXECUTION_ENVIRONMENT_MANAGER_URL}");
    expect(managerSection).toMatch(/^\s+- execution_manager_net$/m);
    expect(managerSection).toMatch(/^\s+- disposable_runner_net$/m);
    expect(generatedCompose).toContain("      - execution_manager_net");
    expect(generatedCompose).toContain("      - disposable_runner_net");
    const browserStart = generatedCompose.indexOf("  panda-browser-runner:");
    const runnerStart = generatedCompose.indexOf("  panda-runner-");
    const networksStart = generatedCompose.indexOf("\nnetworks:");
    expect(browserStart).toBeGreaterThanOrEqual(0);
    const browserEnd = runnerStart >= 0 ? runnerStart : networksStart;
    const browserSection = generatedCompose.slice(browserStart, browserEnd);
    expect(browserSection).toMatch(/^\s+- runner_net$/m);
    expect(browserSection).toMatch(/^\s+- disposable_runner_net$/m);
    expect(generatedCompose).toContain("execution_manager_net:\n    name: ${PANDA_EXECUTION_ENVIRONMENT_MANAGER_NETWORK}\n    internal: true");
    expect(generatedCompose).toContain("disposable_runner_net:\n    name: ${PANDA_DISPOSABLE_RUNNER_NETWORK}");
    expect(generatedCompose).not.toContain("gateway_edge_net");
    const logContents = await readFile(logPath, "utf8");
    expect(logContents.match(/build --target bash-runner --build-arg NODE_MAJOR=22 -t panda-runner:latest/g)).toHaveLength(1);
    expect(logContents).toContain(`image inspect ${workspaceImage}`);
    expect(logContents).toContain(`build --target workspace-runner -t ${workspaceImage}`);

    const logsResult = await runScript(["logs", "environment-manager"], {
      envFile,
      dockerBin,
      homeDir,
    });
    expect(logsResult.exitCode).toBe(0);
    expect(await readFile(logPath, "utf8")).toContain("logs -f panda-environment-manager");
  });

  it("hashes only the workspace-runner Dockerfile stage for default workspace image tags", async () => {
    const dockerfilePath = path.join(repoRoot, "Dockerfile");
    const originalDockerfile = await readFile(dockerfilePath, "utf8");
    const logPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const dockerBin = await createDockerStub(logPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "PANDA_AGENTS=",
      "PANDA_DISPOSABLE_ENVIRONMENTS_ENABLED=true",
      "PANDA_EXECUTION_ENVIRONMENT_MANAGER_TOKEN=environment-manager-token",
    ].join("\n"));
    const homeDir = await makeTempDir("panda-home-");
    const runAndReadWorkspaceImage = async (): Promise<string> => {
      const result = await runScript(["up"], {envFile, dockerBin, homeDir});
      expect(result.exitCode).toBe(0);
      return extractWorkspaceImage(await readFile(generatedComposePath, "utf8"));
    };

    try {
      const baseImage = await runAndReadWorkspaceImage();

      await writeFile(
        dockerfilePath,
        originalDockerfile.replace(
          "FROM ubuntu:24.04 AS node-base",
          "# non-workspace hash test\nFROM ubuntu:24.04 AS node-base",
        ),
      );
      await expect(runAndReadWorkspaceImage()).resolves.toBe(baseImage);

      await writeFile(
        dockerfilePath,
        originalDockerfile.replace("ENV SHELL=/bin/bash\nENV TZ=UTC\nENV PATH=", "ENV SHELL=/bin/bash\nENV TZ=Etc/UTC\nENV PATH="),
      );
      await expect(runAndReadWorkspaceImage()).resolves.not.toBe(baseImage);
    } finally {
      await writeFile(dockerfilePath, originalDockerfile);
    }
  });

  it("fails loudly when the workspace-runner Dockerfile stage cannot be extracted", async () => {
    const dockerfilePath = path.join(repoRoot, "Dockerfile");
    const originalDockerfile = await readFile(dockerfilePath, "utf8");
    const logPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const dockerBin = await createDockerStub(logPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "PANDA_AGENTS=",
      "PANDA_DISPOSABLE_ENVIRONMENTS_ENABLED=true",
      "PANDA_EXECUTION_ENVIRONMENT_MANAGER_TOKEN=environment-manager-token",
    ].join("\n"));

    try {
      await writeFile(
        dockerfilePath,
        originalDockerfile.replace("FROM ubuntu:24.04 AS workspace-runner", "FROM ubuntu:24.04 AS renamed-workspace-runner"),
      );
      const result = await runScript(["up"], {
        envFile,
        dockerBin,
        homeDir: await makeTempDir("panda-home-"),
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Could not extract workspace-runner stage from Dockerfile.");
    } finally {
      await writeFile(dockerfilePath, originalDockerfile);
    }
  });

  it("skips the workspace build when the content-addressed default workspace image already exists", async () => {
    const logPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const dockerBin = await createExistingWorkspaceImageDockerStub(logPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "PANDA_AGENTS=",
      "PANDA_DISPOSABLE_ENVIRONMENTS_ENABLED=true",
      "PANDA_EXECUTION_ENVIRONMENT_MANAGER_TOKEN=environment-manager-token",
    ].join("\n"));

    const result = await runScript(["up", "--build"], {
      envFile,
      dockerBin,
      homeDir: await makeTempDir("panda-home-"),
    });

    expect(result.exitCode).toBe(0);
    const generatedCompose = await readFile(generatedComposePath, "utf8");
    const workspaceDefaultMatch = generatedCompose.match(/panda-workspace:([a-f0-9]{16})/);
    expect(workspaceDefaultMatch).not.toBeNull();
    const workspaceImage = `panda-workspace:${workspaceDefaultMatch?.[1]}`;
    const logContents = await readFile(logPath, "utf8");
    expect(logContents).toContain(`image inspect ${workspaceImage}`);
    expect(logContents).not.toContain(`build --target workspace-runner -t ${workspaceImage}`);
  });

  it("forces workspace rebuild when PANDA_REFRESH_WORKSPACE is true", async () => {
    const logPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const dockerBin = await createExistingWorkspaceImageDockerStub(logPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "PANDA_AGENTS=",
      "PANDA_DISPOSABLE_ENVIRONMENTS_ENABLED=true",
      "PANDA_EXECUTION_ENVIRONMENT_MANAGER_TOKEN=environment-manager-token",
    ].join("\n"));

    const result = await runScript(["up", "--build"], {
      envFile,
      dockerBin,
      homeDir: await makeTempDir("panda-home-"),
      env: {PANDA_REFRESH_WORKSPACE: "true"},
    });

    expect(result.exitCode).toBe(0);
    const generatedCompose = await readFile(generatedComposePath, "utf8");
    const workspaceDefaultMatch = generatedCompose.match(/panda-workspace:([a-f0-9]{16})/);
    expect(workspaceDefaultMatch).not.toBeNull();
    const workspaceImage = `panda-workspace:${workspaceDefaultMatch?.[1]}`;
    const logContents = await readFile(logPath, "utf8");
    expect(logContents).not.toContain(`image inspect ${workspaceImage}`);
    expect(logContents).toContain(`build --target workspace-runner -t ${workspaceImage}`);
  });

  it("honors an explicit PANDA_DISPOSABLE_WORKSPACE_IMAGE override", async () => {
    const logPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const dockerBin = await createDockerStub(logPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "PANDA_AGENTS=",
      "PANDA_DISPOSABLE_ENVIRONMENTS_ENABLED=true",
      "PANDA_EXECUTION_ENVIRONMENT_MANAGER_TOKEN=environment-manager-token",
      "PANDA_DISPOSABLE_WORKSPACE_IMAGE=registry.example/panda-workspace:custom",
    ].join("\n"));

    const result = await runScript(["up", "--build"], {
      envFile,
      dockerBin,
      homeDir: await makeTempDir("panda-home-"),
    });

    expect(result.exitCode).toBe(0);
    expect(await readFile(generatedComposePath, "utf8")).toMatch(/PANDA_DISPOSABLE_WORKSPACE_IMAGE: \${PANDA_DISPOSABLE_WORKSPACE_IMAGE:-panda-workspace:[a-f0-9]{16}}/);
    const logContents = await readFile(logPath, "utf8");
    expect(logContents).not.toContain("build --target workspace-runner");
    expect(result.stderr).toContain("Using explicit PANDA_DISPOSABLE_WORKSPACE_IMAGE=registry.example/panda-workspace:custom");
  });

  it("rebuilds an explicit workspace image override when PANDA_BUILD_WORKSPACE is true", async () => {
    const logPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const dockerBin = await createDockerStub(logPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "PANDA_AGENTS=",
      "PANDA_DISPOSABLE_ENVIRONMENTS_ENABLED=true",
      "PANDA_EXECUTION_ENVIRONMENT_MANAGER_TOKEN=environment-manager-token",
      "PANDA_DISPOSABLE_WORKSPACE_IMAGE=registry.example/panda-workspace:custom",
    ].join("\n"));

    const result = await runScript(["up", "--build"], {
      envFile,
      dockerBin,
      homeDir: await makeTempDir("panda-home-"),
      env: {PANDA_BUILD_WORKSPACE: "true"},
    });

    expect(result.exitCode).toBe(0);
    const logContents = await readFile(logPath, "utf8");
    expect(logContents).not.toContain("image inspect registry.example/panda-workspace:custom");
    expect(logContents).toContain("build --target workspace-runner -t registry.example/panda-workspace:custom");
  });

  it("does not mount the Docker socket when PANDA_DOCKER_HOST is not a Unix socket", async () => {
    const logPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const dockerBin = await createDockerStub(logPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "PANDA_AGENTS=",
      "PANDA_DISPOSABLE_ENVIRONMENTS_ENABLED=true",
      "PANDA_EXECUTION_ENVIRONMENT_MANAGER_TOKEN=environment-manager-token",
      "PANDA_DOCKER_HOST=tcp://docker-proxy:2375",
    ].join("\n"));

    const result = await runScript(["up"], {
      envFile,
      dockerBin,
      homeDir: await makeTempDir("panda-home-"),
    });

    expect(result.exitCode).toBe(0);
    const generatedCompose = await readFile(generatedComposePath, "utf8");
    expect(generatedCompose).toContain("PANDA_DOCKER_HOST: ${PANDA_DOCKER_HOST:-unix:///var/run/docker.sock}");
    expect(generatedCompose).not.toContain("/var/run/docker.sock:/var/run/docker.sock");
  });

  it("rejects disposable environments without an environment manager token", async () => {
    const logPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const dockerBin = await createDockerStub(logPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "PANDA_AGENTS=",
      "PANDA_DISPOSABLE_ENVIRONMENTS_ENABLED=true",
    ].join("\n"));

    const result = await runScript(["up"], {
      envFile,
      dockerBin,
      homeDir: await makeTempDir("panda-home-"),
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("PANDA_EXECUTION_ENVIRONMENT_MANAGER_TOKEN is required");
  });

  it("does not require the environment manager token for passive compose commands", async () => {
    const logPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const dockerBin = await createDockerStub(logPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "PANDA_AGENTS=",
      "PANDA_DISPOSABLE_ENVIRONMENTS_ENABLED=true",
    ].join("\n"));
    const homeDir = await makeTempDir("panda-home-");

    await expect(runScript(["ps"], {envFile, dockerBin, homeDir})).resolves.toMatchObject({exitCode: 0});
    await expect(runScript(["logs", "environment-manager"], {envFile, dockerBin, homeDir})).resolves.toMatchObject({
      exitCode: 0,
    });
    await expect(runScript(["down"], {envFile, dockerBin, homeDir})).resolves.toMatchObject({exitCode: 0});

    const logContents = await readFile(logPath, "utf8");
    expect(logContents).toContain("ps");
    expect(logContents).toContain("logs -f panda-environment-manager");
    expect(logContents).toContain("down --remove-orphans");
  });

  it("normalizes HOME-based disposable environment host roots before rendering compose", async () => {
    const logPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const dockerBin = await createDockerStub(logPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "PANDA_AGENTS=claw",
      "PANDA_DISPOSABLE_ENVIRONMENTS_ENABLED=true",
      "PANDA_EXECUTION_ENVIRONMENT_MANAGER_TOKEN=environment-manager-token",
      "PANDA_ENVIRONMENTS_HOST_ROOT=$HOME/panda-envs",
    ].join("\n"));
    const homeDir = await makeTempDir("panda-home-");

    const result = await runScript(["up"], {
      envFile,
      dockerBin,
      homeDir,
    });

    expect(result.exitCode).toBe(0);
    const generatedCompose = await readFile(generatedComposePath, "utf8");
    const environmentsRoot = path.join(homeDir, "panda-envs");
    expect(generatedCompose).toContain(`PANDA_ENVIRONMENTS_HOST_ROOT: ${environmentsRoot}`);
    expect(generatedCompose).toContain(`- "${environmentsRoot}:${"${PANDA_ENVIRONMENTS_ROOT:-/root/.panda/environments}"}"`);
    expect(generatedCompose).toContain(`- "${environmentsRoot}/claw:${"${PANDA_RUNNER_ENVIRONMENTS_ROOT:-/environments}"}"`);
    expect(generatedCompose).not.toContain("$HOME/panda-envs");
  });

  it("rejects relative disposable environment host roots", async () => {
    const logPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const dockerBin = await createDockerStub(logPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "PANDA_AGENTS=claw",
      "PANDA_ENVIRONMENTS_HOST_ROOT=./panda-envs",
    ].join("\n"));

    const result = await runScript(["up"], {
      envFile,
      dockerBin,
      homeDir: await makeTempDir("panda-home-"),
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("PANDA_ENVIRONMENTS_HOST_ROOT must be an absolute path");
  });

  it("does not enable disposable environments from manager config alone", async () => {
    const logPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const dockerBin = await createDockerStub(logPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "PANDA_AGENTS=",
      "PANDA_EXECUTION_ENVIRONMENT_MANAGER_TOKEN=environment-manager-token",
    ].join("\n"));

    const result = await runScript(["up"], {
      envFile,
      dockerBin,
      homeDir: await makeTempDir("panda-home-"),
    });

    expect(result.exitCode).toBe(0);
    const generatedCompose = await readFile(generatedComposePath, "utf8");
    expect(generatedCompose).not.toContain("panda-environment-manager:");
    expect(generatedCompose).not.toContain("disposable_runner_net");
  });

  it("uses the configured Node major when building runner images", async () => {
    const logPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const dockerBin = await createDockerStub(logPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "PANDA_AGENTS=claw",
      "PANDA_RUNNER_NODE_MAJOR=20",
    ].join("\n"));

    const result = await runScript(["up", "--build"], {
      envFile,
      dockerBin,
      homeDir: await makeTempDir("panda-home-"),
    });

    expect(result.exitCode).toBe(0);
    const logContents = await readFile(logPath, "utf8");
    expect(logContents.match(/build --target app -t panda-app:latest/g)).toHaveLength(1);
    expect(logContents.match(/build --target browser-runner -t panda-browser-runner:latest/g)).toHaveLength(1);
    expect(logContents.match(/build --target bash-runner --build-arg NODE_MAJOR=20 -t panda-runner:latest/g)).toHaveLength(1);
    expect(logContents).not.toContain("build --target workspace-runner");
  });

  it("rejects unsupported runner Node majors", async () => {
    const logPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const dockerBin = await createDockerStub(logPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "PANDA_AGENTS=claw",
      "PANDA_RUNNER_NODE_MAJOR=19",
    ].join("\n"));

    const result = await runScript(["up", "--build"], {
      envFile,
      dockerBin,
      homeDir: await makeTempDir("panda-home-"),
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("PANDA_RUNNER_NODE_MAJOR must be one of: 20, 22, 24.");
    const logContents = await readFile(logPath, "utf8").catch(() => "");
    expect(logContents).not.toContain("build --target app");
    expect(logContents).not.toContain("build --target browser-runner");
    expect(logContents).not.toContain("build --target bash-runner");
  });

  it("builds runner and browser images in parallel before starting compose", async () => {
    const logPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const dockerBin = await createSynchronizedBuildDockerStub(logPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "PANDA_AGENTS=claw",
    ].join("\n"));

    const result = await runScript(["up", "--build"], {
      envFile,
      dockerBin,
      homeDir: await makeTempDir("panda-home-"),
    });

    expect(result.exitCode).toBe(0);
    const logLines = (await readFile(logPath, "utf8")).trimEnd().split("\n");
    const findLogIndex = (predicate: (line: string) => boolean): number => {
      const index = logLines.findIndex(predicate);
      expect(index).toBeGreaterThanOrEqual(0);
      return index;
    };
    const findBuildIndex = (marker: "START" | "END", target: string) => findLogIndex(
      (line) => line.includes(`${marker} build --target ${target} `),
    );

    const appStart = findBuildIndex("START", "app");
    const appEnd = findBuildIndex("END", "app");
    const browserStart = findBuildIndex("START", "browser-runner");
    const browserEnd = findBuildIndex("END", "browser-runner");
    const runnerStart = findBuildIndex("START", "bash-runner");
    const runnerEnd = findBuildIndex("END", "bash-runner");
    const composeStart = findLogIndex(
      (line) => line.startsWith("START compose ") && line.includes(" up -d --no-build --remove-orphans"),
    );

    expect(appStart).toBeLessThan(appEnd);
    expect(appEnd).toBeLessThan(browserStart);
    expect(appEnd).toBeLessThan(runnerStart);
    expect(browserStart).toBeLessThan(runnerEnd);
    expect(runnerStart).toBeLessThan(browserEnd);
    expect(browserEnd).toBeLessThan(composeStart);
    expect(runnerEnd).toBeLessThan(composeStart);
  });

  it("renders one runner per agent, enables telegram automatically, and maps agent logs to runner services", async () => {
    const logPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const dockerBin = await createDockerStub(logPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
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
    expect(generatedCompose).toContain("image: panda-runner:latest");
    expect(generatedCompose).toContain('command: ["bash-server"]');
    expect(generatedCompose).toContain("BASH_SERVER_SHARED_SECRET: ${BASH_SERVER_SHARED_SECRET:-}");
    expect(generatedCompose).toContain("BASH_SERVER_ALLOWED_ROOTS: ${BASH_SERVER_ALLOWED_ROOTS:-}");
    expect(generatedCompose.match(/restart: unless-stopped/g)).toHaveLength(2);
    expect(generatedCompose).not.toContain("panda-runner-Luna");
    expect(generatedCompose).not.toContain("image: panda:latest");
    const environmentsRoot = path.join(homeDir, ".panda", "environments");
    expect(generatedCompose).toContain(`- "${environmentsRoot}/claw:${"${PANDA_RUNNER_ENVIRONMENTS_ROOT:-/environments}"}"`);
    expect(generatedCompose).toContain(`- "${environmentsRoot}/luna:${"${PANDA_RUNNER_ENVIRONMENTS_ROOT:-/environments}"}"`);

    const baseCompose = await readFile(baseComposePath, "utf8");
    expect(baseCompose).toContain("  panda-telegram:\n    image: panda-app:latest");
    expect(baseCompose).toContain("  panda-discord:\n    image: panda-app:latest");
    expect(baseCompose).toContain('command: ["discord", "run", "--all-enabled"]');
    expect(baseCompose).toContain("PANDA_DISCORD_DB_POOL_MAX: ${PANDA_DISCORD_DB_POOL_MAX:-2}");
    expect(baseCompose).toContain("  panda-whatsapp:\n    image: panda-app:latest");
    expect(baseCompose).toContain("${PANDA_ENVIRONMENTS_HOST_ROOT:-${HOME}/.panda/environments}:${PANDA_ENVIRONMENTS_ROOT:-/root/.panda/environments}");
    expect(baseCompose).toContain("BASH_SERVER_SHARED_SECRET: ${BASH_SERVER_SHARED_SECRET:-}");
    expect(baseCompose).not.toContain("  panda-telegram:\n    build:");
    expect(baseCompose).not.toContain("  panda-discord:\n    build:");
    expect(baseCompose).not.toContain("  panda-whatsapp:\n    build:");

    const logContents = await readFile(logPath, "utf8");
    expect(logContents).toContain("--profile telegram");
    expect(logContents).toContain("compose --env-file");
    expect(logContents.match(/build --target app -t panda-app:latest/g)).toHaveLength(1);
    expect(logContents.match(/build --target browser-runner -t panda-browser-runner:latest/g)).toHaveLength(1);
    expect(logContents.match(/build --target bash-runner --build-arg NODE_MAJOR=22 -t panda-runner:latest/g)).toHaveLength(1);
    expect(logContents).toContain("up -d --no-build --remove-orphans");
    expect(logContents).not.toContain("up -d --build --remove-orphans");
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

  it("enables discord explicitly, orders wiki after discord, and maps discord logs", async () => {
    const logPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const dockerBin = await createDockerStub(logPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "DISCORD_ENABLED=true",
      "PANDA_AGENTS=",
    ].join("\n"));

    const homeDir = await makeTempDir("panda-home-");
    const upResult = await runScript(["up"], {
      envFile,
      dockerBin,
      homeDir,
    });

    expect(upResult.exitCode).toBe(0);
    expect(upResult.stdout).toContain("./scripts/docker-stack.sh logs discord");
    const logContents = await readFile(logPath, "utf8");
    expect(logContents).toContain("--profile discord");
    const generatedWikiCompose = await readFile(generatedWikiComposePath, "utf8");
    expect(generatedWikiCompose).toMatch(/services:\n  wiki:\n    depends_on:\n      panda-discord:\n        condition: service_started/);

    const logsResult = await runScript(["logs", "discord"], {
      envFile,
      dockerBin,
      homeDir,
    });
    expect(logsResult.exitCode).toBe(0);
    expect(await readFile(logPath, "utf8")).toContain("logs -f panda-discord");
  });

  it("enables whatsapp explicitly and maps whatsapp logs", async () => {
    const logPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const dockerBin = await createDockerStub(logPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "WHATSAPP_ENABLED=true",
      "WHATSAPP_CONNECTOR_KEY=main",
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
    expect(logContents).toContain("--profile whatsapp");
    expect(upResult.stdout).toContain("./scripts/docker-stack.sh logs whatsapp");

    const logsResult = await runScript(["logs", "whatsapp"], {
      envFile,
      dockerBin,
      homeDir,
    });
    expect(logsResult.exitCode).toBe(0);
    expect(await readFile(logPath, "utf8")).toContain("logs -f panda-whatsapp");

    const linkResult = await runScript([
      "panda",
      "whatsapp",
      "link",
      "--phone",
      "421900000000",
    ], {
      envFile,
      dockerBin,
      homeDir,
    });
    expect(linkResult.exitCode).toBe(0);
    expect(await readFile(logPath, "utf8")).toContain(
      "exec -T panda-core panda whatsapp link --phone 421900000000",
    );

    const pandaResult = await runScript([
      "panda",
      "whatsapp",
      "pair",
      "--identity",
      "alice",
      "--actor",
      "421911111111",
    ], {
      envFile,
      dockerBin,
      homeDir,
    });
    expect(pandaResult.exitCode).toBe(0);
    expect(await readFile(logPath, "utf8")).toContain(
      "exec -T panda-core panda whatsapp pair --identity alice --actor 421911111111",
    );
  });

  it("always includes the wiki compose file and maps wiki logs", async () => {
    const logPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const dockerBin = await createDockerStub(logPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
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

  it("auto-includes the apps edge compose when PANDA_APPS_BASE_URL is set", async () => {
    const logPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const dockerBin = await createDockerStub(logPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "PANDA_APPS_BASE_URL=https://panda.patrikmojzis.com",
      "PANDA_APPS_PUBLIC_HOST=panda.patrikmojzis.com",
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
    expect(logContents).toContain("docker-compose.apps-edge.yml");
    const appsCompose = await readFile(appsEdgeComposePath, "utf8");
    expect(appsCompose).not.toContain("env_file:");
    expect(appsCompose).not.toContain("PANDA_APPS_AUTH: required");
    expect(appsCompose).toContain("../.generated/Caddyfile.public-edge");
    expect(appsCompose).not.toContain("runner_net");
    expect(appsCompose).toContain("read_only: true");
    expect(appsCompose).toContain("no-new-privileges:true");
    expect(appsCompose).toContain("NET_BIND_SERVICE");
    const generatedCompose = await readFile(generatedComposePath, "utf8");
    expect(generatedCompose).toContain("PANDA_APPS_AUTH: required");
    expect(generatedCompose).toContain("PANDA_APPS_BASE_URL: ${PANDA_APPS_BASE_URL}");
    expect(generatedCompose).toContain("apps_edge_net");
    expect(generatedCompose).not.toContain("gateway_edge_net");
    const caddyfile = await readFile(generatedPublicCaddyfilePath, "utf8");
    expect(caddyfile).toContain("panda.patrikmojzis.com");
    expect(caddyfile).toContain("@unsafeDotSegments vars_regexp {http.request.orig_uri.path}");
    expect(caddyfile).toContain("respond \"Bad request\" 400");
    expect(caddyfile).toContain("reverse_proxy panda-core:8092");
    expect(caddyfile).toContain("header_up X-Forwarded-For {remote_host}");

    const logsResult = await runScript(["logs", "apps"], {
      envFile,
      dockerBin,
      homeDir,
    });
    expect(logsResult.exitCode).toBe(0);
    expect(await readFile(logPath, "utf8")).toContain("logs -f caddy");
  });

  it("renders the public gateway edge on an isolated gateway network", async () => {
    const logPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const dockerBin = await createDockerStub(logPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "PANDA_GATEWAY_BASE_URL=https://gateway.patrikmojzis.com",
      "PANDA_GATEWAY_PUBLIC_HOST=gateway.patrikmojzis.com",
      "GATEWAY_IP_ALLOWLIST=203.0.113.10/32",
      "GATEWAY_GUARD_MODEL=openai-codex/gpt-5.5",
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
    expect(logContents).toContain("docker-compose.apps-edge.yml");
    const generatedCompose = await readFile(generatedComposePath, "utf8");
    expect(generatedCompose).toContain("panda-gateway:");
    expect(generatedCompose).toContain("panda-gateway:\n    image: panda-app:latest");
    expect(generatedCompose).toContain('command: ["gateway", "run"]');
    expect(generatedCompose).not.toContain("panda-gateway:\n    build:");
    expect(generatedCompose).toContain("read_only: true");
    expect(generatedCompose).toContain("cap_drop:");
    expect(generatedCompose).toContain("      - ALL");
    expect(generatedCompose).toContain("no-new-privileges:true");
    expect(generatedCompose).toContain("tmpfs:");
    expect(generatedCompose).toContain("GATEWAY_HOST: 0.0.0.0");
    expect(generatedCompose).toContain("GATEWAY_IP_ALLOWLIST: ${GATEWAY_IP_ALLOWLIST}");
    expect(generatedCompose).toContain("GATEWAY_TRUSTED_PROXY_IPS: ${GATEWAY_TRUSTED_PROXY_IPS}");
    expect(generatedCompose).toContain("GATEWAY_GUARD_MODEL: ${GATEWAY_GUARD_MODEL}");
    expect(generatedCompose).toContain("gateway_edge_net");
    expect(generatedCompose).not.toContain("PANDA_APPS_AUTH: required");
    expect(generatedCompose).not.toContain("panda-gateway:\n    networks:\n      - runner_net");
    const caddyfile = await readFile(generatedPublicCaddyfilePath, "utf8");
    expect(caddyfile).toContain("gateway.patrikmojzis.com");
    expect(caddyfile).toContain("reverse_proxy panda-gateway:8094");
    expect(caddyfile).toContain("header_up X-Forwarded-For {remote_host}");

    const logsResult = await runScript(["logs", "gateway"], {
      envFile,
      dockerBin,
      homeDir,
    });
    expect(logsResult.exitCode).toBe(0);
    expect(await readFile(logPath, "utf8")).toContain("logs -f panda-gateway");
  });

  it("keeps gateway and caddy off disposable environment networks", async () => {
    const logPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const dockerBin = await createDockerStub(logPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "PANDA_GATEWAY_BASE_URL=https://gateway.patrikmojzis.com",
      "PANDA_GATEWAY_PUBLIC_HOST=gateway.patrikmojzis.com",
      "GATEWAY_IP_ALLOWLIST=203.0.113.10/32",
      "GATEWAY_GUARD_MODEL=openai-codex/gpt-5.5",
      "PANDA_DISPOSABLE_ENVIRONMENTS_ENABLED=true",
      "PANDA_EXECUTION_ENVIRONMENT_MANAGER_TOKEN=environment-manager-token",
      "PANDA_AGENTS=",
    ].join("\n"));

    const upResult = await runScript(["up"], {
      envFile,
      dockerBin,
      homeDir: await makeTempDir("panda-home-"),
    });

    expect(upResult.exitCode).toBe(0);
    const generatedCompose = await readFile(generatedComposePath, "utf8");
    const gatewayStart = generatedCompose.indexOf("  panda-gateway:");
    const caddyStart = generatedCompose.indexOf("  caddy:");
    const browserStart = generatedCompose.indexOf("  panda-browser-runner:");
    const networksStart = generatedCompose.indexOf("\nnetworks:");
    expect(gatewayStart).toBeGreaterThanOrEqual(0);
    expect(caddyStart).toBeGreaterThan(gatewayStart);
    expect(browserStart).toBeGreaterThan(caddyStart);
    expect(networksStart).toBeGreaterThan(caddyStart);
    const gatewaySection = generatedCompose.slice(gatewayStart, caddyStart);
    const caddySection = generatedCompose.slice(caddyStart, browserStart);
    const browserSection = generatedCompose.slice(browserStart, networksStart);
    expect(gatewaySection).toContain("gateway_edge_net");
    expect(gatewaySection).not.toContain("disposable_runner_net");
    expect(gatewaySection).not.toContain("execution_manager_net");
    expect(caddySection).toContain("gateway_edge_net");
    expect(caddySection).not.toContain("disposable_runner_net");
    expect(caddySection).not.toContain("execution_manager_net");
    expect(browserSection).toMatch(/^\s+- runner_net$/m);
    expect(browserSection).toMatch(/^\s+- disposable_runner_net$/m);
  });

  it("rejects unsafe public gateway edge settings", async () => {
    const logPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const dockerBin = await createDockerStub(logPath);
    const homeDir = await makeTempDir("panda-home-");
    const missingGuardEnvFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "PANDA_GATEWAY_BASE_URL=https://gateway.example.com",
      "PANDA_GATEWAY_PUBLIC_HOST=gateway.example.com",
      "GATEWAY_IP_ALLOWLIST=203.0.113.10/32",
      "PANDA_AGENTS=",
    ].join("\n"));

    const missingGuardResult = await runScript(["up"], {
      envFile: missingGuardEnvFile,
      dockerBin,
      homeDir,
    });
    expect(missingGuardResult.exitCode).not.toBe(0);
    expect(missingGuardResult.stderr).toContain("GATEWAY_GUARD_MODEL is required");

    const missingAllowlistEnvFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "PANDA_GATEWAY_BASE_URL=https://gateway.example.com",
      "PANDA_GATEWAY_PUBLIC_HOST=gateway.example.com",
      "GATEWAY_GUARD_MODEL=openai-codex/gpt-5.5",
      "PANDA_AGENTS=",
    ].join("\n"));

    const missingAllowlistResult = await runScript(["up"], {
      envFile: missingAllowlistEnvFile,
      dockerBin,
      homeDir,
    });
    expect(missingAllowlistResult.exitCode).not.toBe(0);
    expect(missingAllowlistResult.stderr).toContain("GATEWAY_IP_ALLOWLIST is required");

    const unsafeOverrideEnvFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "PANDA_GATEWAY_BASE_URL=https://gateway.example.com",
      "PANDA_GATEWAY_PUBLIC_HOST=gateway.example.com",
      "GATEWAY_IP_ALLOWLIST=203.0.113.10/32",
      "GATEWAY_ALLOW_PUBLIC_WITHOUT_IP_ALLOWLIST=true",
      "GATEWAY_GUARD_MODEL=openai-codex/gpt-5.5",
      "PANDA_AGENTS=",
    ].join("\n"));

    const unsafeOverrideResult = await runScript(["up"], {
      envFile: unsafeOverrideEnvFile,
      dockerBin,
      homeDir,
    });
    expect(unsafeOverrideResult.exitCode).not.toBe(0);
    expect(unsafeOverrideResult.stderr).toContain(
      "GATEWAY_ALLOW_PUBLIC_WITHOUT_IP_ALLOWLIST must not be enabled",
    );

    const httpEnvFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "PANDA_GATEWAY_BASE_URL=http://gateway.example.com",
      "PANDA_GATEWAY_PUBLIC_HOST=gateway.example.com",
      "GATEWAY_IP_ALLOWLIST=203.0.113.10/32",
      "GATEWAY_GUARD_MODEL=openai-codex/gpt-5.5",
      "PANDA_AGENTS=",
    ].join("\n"));

    const httpResult = await runScript(["up"], {
      envFile: httpEnvFile,
      dockerBin,
      homeDir,
    });
    expect(httpResult.exitCode).not.toBe(0);
    expect(httpResult.stderr).toContain("PANDA_GATEWAY_BASE_URL must be a plain https:// origin");

    const duplicateHostEnvFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "PANDA_APPS_BASE_URL=https://panda.example.com",
      "PANDA_APPS_PUBLIC_HOST=panda.example.com",
      "PANDA_GATEWAY_BASE_URL=https://panda.example.com",
      "PANDA_GATEWAY_PUBLIC_HOST=panda.example.com",
      "GATEWAY_IP_ALLOWLIST=203.0.113.10/32",
      "GATEWAY_GUARD_MODEL=openai-codex/gpt-5.5",
      "PANDA_AGENTS=",
    ].join("\n"));

    const duplicateHostResult = await runScript(["up"], {
      envFile: duplicateHostEnvFile,
      dockerBin,
      homeDir,
    });
    expect(duplicateHostResult.exitCode).not.toBe(0);
    expect(duplicateHostResult.stderr).toContain(
      "PANDA_GATEWAY_PUBLIC_HOST must not match PANDA_APPS_PUBLIC_HOST",
    );
  });

  it("rejects unsafe or mismatched public apps edge settings", async () => {
    const logPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const dockerBin = await createDockerStub(logPath);
    const homeDir = await makeTempDir("panda-home-");
    const httpEnvFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "PANDA_APPS_BASE_URL=http://panda.example.com",
      "PANDA_APPS_PUBLIC_HOST=panda.example.com",
      "PANDA_AGENTS=",
    ].join("\n"));

    const httpResult = await runScript(["up"], {
      envFile: httpEnvFile,
      dockerBin,
      homeDir,
    });
    expect(httpResult.exitCode).not.toBe(0);
    expect(httpResult.stderr).toContain("PANDA_APPS_BASE_URL must be a plain https:// origin");

    const mismatchEnvFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "PANDA_APPS_BASE_URL=https://panda.example.com",
      "PANDA_APPS_PUBLIC_HOST=other.example.com",
      "PANDA_AGENTS=",
    ].join("\n"));

    const mismatchResult = await runScript(["up"], {
      envFile: mismatchEnvFile,
      dockerBin,
      homeDir,
    });
    expect(mismatchResult.exitCode).not.toBe(0);
    expect(mismatchResult.stderr).toContain("PANDA_APPS_PUBLIC_HOST must match PANDA_APPS_BASE_URL host");
  });

  it("skips wiki auto-bootstrap with a warning when no host-reachable wiki URL is configured", async () => {
    const dockerLogPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const dockerBin = await createDockerStub(dockerLogPath);
    const wikiLocalScript = await createFailingWikiLocalStub();
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
      "WIKI_URL=http://wiki:3000",
      "WIKI_SITE_URL=   ",
      "WIKI_PUBLISH_PORT=   ",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "PANDA_AGENTS=claw",
      "WIKI_ADMIN_EMAIL=admin@localhost",
      "WIKI_ADMIN_PASSWORD=secret",
    ].join("\n"));

    const upResult = await runScript(["up"], {
      envFile,
      dockerBin,
      homeDir: await makeTempDir("panda-home-"),
      wikiLocalScript,
    });

    expect(upResult.exitCode).toBe(0);
    expect(upResult.stdout).toContain(
      "Warning: Wiki.js auto-bootstrap skipped because neither WIKI_SITE_URL nor WIKI_PUBLISH_PORT is configured",
    );
    expect(upResult.stdout).toContain("WIKI_ENV_FILE=");
    expect(upResult.stdout).toContain("bootstrap claw");
    expect(upResult.stdout).toContain("Stack is up.");
    expect(upResult.stderr).not.toContain("wiki-local should not be called");
  });

  it("bootstraps wiki for all declared agents when admin credentials are set", async () => {
    const dockerLogPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const wikiLogPath = path.join(await makeTempDir("panda-wiki-log-"), "wiki.log");
    const dockerBin = await createDockerStub(dockerLogPath);
    const wikiLocalScript = await createWikiLocalStub(wikiLogPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "PANDA_AGENTS=claw,Luna",
      "WIKI_ADMIN_EMAIL=admin@localhost",
      "WIKI_ADMIN_PASSWORD=secret",
      "WIKI_SITE_URL=http://127.0.0.1:3100",
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

  it("loads env files without shell-breaking URLs and passes them intact to wiki bootstrap", async () => {
    const dockerLogPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const wikiLogPath = path.join(await makeTempDir("panda-wiki-log-"), "wiki.log");
    const dockerBin = await createDockerStub(dockerLogPath);
    const wikiLocalScript = await createWikiLocalStub(wikiLogPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://agent@example/panda?sslmode=verify-full&sslrootcert=/etc/ssl/certs/panda-postgres-ca.crt",
      "WIKI_DB_URL=postgresql://wiki@example/wiki?sslmode=verify-full&sslrootcert=/etc/ssl/certs/panda-postgres-ca.crt",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "PANDA_AGENTS=claw",
      "WIKI_ADMIN_EMAIL=admin@localhost",
      "WIKI_ADMIN_PASSWORD=secret",
      "WIKI_PUBLISH_PORT=3100",
    ].join("\n"));

    const homeDir = await makeTempDir("panda-home-");
    const upResult = await runScript(["up"], {
      envFile,
      dockerBin,
      homeDir,
      wikiLocalScript,
    });

    expect(upResult.exitCode).toBe(0);
    const wikiLog = await readFile(wikiLogPath, "utf8");
    expect(wikiLog).toContain("DATABASE_URL=postgresql://agent@example/panda?sslmode=verify-full&sslrootcert=/etc/ssl/certs/panda-postgres-ca.crt");
    expect(wikiLog).toContain("WIKI_DB_URL=postgresql://wiki@example/wiki?sslmode=verify-full&sslrootcert=/etc/ssl/certs/panda-postgres-ca.crt");
  });

  it("publishes wiki only when WIKI_PUBLISH_PORT is set", async () => {
    const logPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const dockerBin = await createDockerStub(logPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
      "WIKI_PUBLISH_PORT=4100",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "PANDA_AGENTS=",
    ].join("\n"));

    const result = await runScript(["up"], {
      envFile,
      dockerBin,
      homeDir: await makeTempDir("panda-home-"),
    });

    expect(result.exitCode).toBe(0);
    expect(await readFile(generatedWikiComposePath, "utf8")).toContain('127.0.0.1:4100:3000');
  });
});
