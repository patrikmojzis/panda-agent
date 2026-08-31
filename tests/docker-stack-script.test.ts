import {spawn} from "node:child_process";
import {chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {afterEach, describe, expect, it} from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repoRoot, "scripts/docker-stack.sh");
const privateEnvFileHelperPath = path.join(repoRoot, "scripts/lib/private-env-file.sh");
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
  ps*'label=com.docker.compose.service=panda-core')
    printf 'writer-panda-core\\n'
    ;;
  ps*'label=com.docker.compose.service=panda-telegram')
    printf 'writer-panda-telegram\\n'
    ;;
  ps*'label=com.docker.compose.service=panda-discord')
    printf 'writer-panda-discord\\n'
    ;;
  ps*'label=com.docker.compose.service=panda-whatsapp')
    printf 'writer-panda-whatsapp\\n'
    ;;
  ps*'label=com.docker.compose.service=panda-gateway')
    printf 'writer-panda-gateway\\n'
    ;;
  *)
    ;;
esac
`, {mode: 0o755});
    return stubPath;
  }

  async function createFailingMigrationDockerStub(logPath: string): Promise<string> {
    const stubPath = path.join(await makeTempDir("panda-docker-stub-"), "docker");
    await writeFile(stubPath, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${logPath}"
cmd="$*"
case "$cmd" in
  compose*' run --rm --no-deps panda-core db migrate --writers-stopped')
    exit 42
    ;;
  ps*'label=com.docker.compose.service=panda-core')
    printf 'writer-panda-core\n'
    ;;
  ps*'label=com.docker.compose.service=panda-telegram')
    printf 'writer-panda-telegram\n'
    ;;
  ps*'label=com.docker.compose.service=panda-discord')
    printf 'writer-panda-discord\n'
    ;;
  ps*'label=com.docker.compose.service=panda-whatsapp')
    printf 'writer-panda-whatsapp\n'
    ;;
  ps*'label=com.docker.compose.service=panda-gateway')
    printf 'writer-panda-gateway\n'
    ;;
  image' 'inspect*)
    exit 1
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
  ps*'label=com.docker.compose.service=panda-core')
    printf 'writer-panda-core\n'
    ;;
  ps*'label=com.docker.compose.service=panda-telegram')
    printf 'writer-panda-telegram\n'
    ;;
  ps*'label=com.docker.compose.service=panda-discord')
    printf 'writer-panda-discord\n'
    ;;
  ps*'label=com.docker.compose.service=panda-whatsapp')
    printf 'writer-panda-whatsapp\n'
    ;;
  ps*'label=com.docker.compose.service=panda-gateway')
    printf 'writer-panda-gateway\n'
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
printf 'WIKI_DOCKER_BIN=%s\\n' "\${WIKI_DOCKER_BIN-}" >> "${logPath}"
printf 'PANDA_WIKI_BINDING_TRANSPORT=%s\\n' "\${PANDA_WIKI_BINDING_TRANSPORT-}" >> "${logPath}"
printf 'WIKI_ENV_FILE=%s\\n' "\${WIKI_ENV_FILE-}" >> "${logPath}"
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
    await writeFile(envPath, contents, {mode: 0o600});
    return envPath;
  }

  async function createPermissionsFixture(): Promise<{
    envFile: string;
    generatedDir: string;
    scriptFile: string;
  }> {
    const fixtureRoot = await makeTempDir("panda-stack-permissions-");
    const fixtureScripts = path.join(fixtureRoot, "scripts");
    const fixtureLib = path.join(fixtureScripts, "lib");
    const generatedDir = path.join(fixtureRoot, ".generated");
    const generatedWikiDir = path.join(generatedDir, "wiki");
    await mkdir(fixtureLib, {recursive: true});
    await mkdir(generatedWikiDir, {recursive: true});
    await chmod(generatedDir, 0o755);
    await chmod(generatedWikiDir, 0o755);

    const scriptFile = path.join(fixtureScripts, "docker-stack.sh");
    await copyFile(scriptPath, scriptFile);
    await copyFile(privateEnvFileHelperPath, path.join(fixtureLib, "private-env-file.sh"));

    const envFile = path.join(fixtureRoot, ".env");
    await writeFile(envFile, "DATABASE_URL=postgresql://example/panda\n", {mode: 0o600});
    await chmod(envFile, 0o644);
    for (const generatedFile of [
      path.join(generatedDir, "docker-compose.remote-bash.external-db.runners.yml"),
      path.join(generatedDir, "docker-compose.wiki.ssl.yml"),
      path.join(generatedDir, "Caddyfile.public-edge"),
      path.join(generatedWikiDir, "docker-compose.wiki.ssl.yml"),
      path.join(generatedDir, "wiki-host.env"),
    ]) {
      await writeFile(generatedFile, "generated-secret-bearing-content\n", {mode: 0o600});
      await chmod(generatedFile, 0o644);
    }

    return {envFile, generatedDir, scriptFile};
  }

  async function runScript(args: string[], options: {
    envFile: string;
    dockerBin: string;
    homeDir?: string;
    wikiLocalScript?: string;
    scriptFile?: string;
    env?: Record<string, string>;
  }): Promise<ScriptResult> {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    return await new Promise((resolve, reject) => {
      const child = spawn("bash", [options.scriptFile ?? scriptPath, ...args], {
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

  function permissionBits(mode: number): number {
    return mode & 0o777;
  }

  function expectTraceLabels(compose: string, service: string, sourceId: string, environment: string): void {
    expect(compose).toContain(`  ${service}:`);
    expect(compose).toContain('    labels:');
    expect(compose).toContain('      panda_trace.enabled: "true"');
    expect(compose).toContain(`      panda_trace.source_id: "${sourceId}"`);
    expect(compose).toContain(`      panda_trace.service: "${service}"`);
    expect(compose).toContain(`      panda_trace.environment: "${environment}"`);
  }

  it("refuses to load an env file readable by group or other users", async () => {
    const dockerLogPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const dockerBin = await createDockerStub(dockerLogPath);
    const envFile = await createEnvFile("DATABASE_URL=postgresql://example/panda\n");
    await chmod(envFile, 0o644);

    const result = await runScript(["ps"], {envFile, dockerBin});

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("refusing to load secret-bearing env file");
    expect(result.stderr).toContain("current mode: 0644");
    expect(result.stderr).toContain(`chmod 600 ${await realpath(envFile)}`);
    expect(result.stderr).toContain("./scripts/docker-stack.sh permissions-fix");
    await expect(readFile(dockerLogPath, "utf8")).rejects.toMatchObject({code: "ENOENT"});
  });

  it("repairs only the selected env file and known Panda-managed paths", async () => {
    const fixture = await createPermissionsFixture();
    const obsoleteWikiEnv = path.join(fixture.generatedDir, "wiki-host.env");
    const generatedCompose = path.join(
      fixture.generatedDir,
      "docker-compose.remote-bash.external-db.runners.yml",
    );

    const result = await runScript(["permissions-fix"], {
      envFile: fixture.envFile,
      dockerBin: "/docker-must-not-run",
      scriptFile: fixture.scriptFile,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(permissionBits((await stat(fixture.envFile)).mode)).toBe(0o600);
    expect(permissionBits((await stat(fixture.generatedDir)).mode)).toBe(0o700);
    expect(permissionBits((await stat(generatedCompose)).mode)).toBe(0o600);
    expect(permissionBits((await stat(path.join(fixture.generatedDir, "wiki"))).mode)).toBe(0o700);
    await expect(stat(obsoleteWikiEnv)).rejects.toMatchObject({code: "ENOENT"});
    expect(result.stdout).toContain("Permissions are ready. Re-run your stack command.");
    expect(result.stdout).toContain(
      "Only the selected env file and known Panda-managed generated paths were changed.",
    );
    expect(result.stdout).toContain(
      "Other host files were not scanned; secure manually created secret files separately.",
    );
  });

  it("refuses to follow a symlink at a Panda-managed file path", async () => {
    const fixture = await createPermissionsFixture();
    const generatedCompose = path.join(
      fixture.generatedDir,
      "docker-compose.remote-bash.external-db.runners.yml",
    );
    const outsideFile = path.join(path.dirname(fixture.envFile), "outside-file");
    await writeFile(outsideFile, "must-not-change\n", {mode: 0o600});
    await chmod(outsideFile, 0o644);
    await rm(generatedCompose);
    await symlink(outsideFile, generatedCompose);

    const result = await runScript(["permissions-fix"], {
      envFile: fixture.envFile,
      dockerBin: "/docker-must-not-run",
      scriptFile: fixture.scriptFile,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("refusing to use symlinked Panda-managed file");
    expect(await readFile(outsideFile, "utf8")).toBe("must-not-change\n");
    expect(permissionBits((await stat(outsideFile)).mode)).toBe(0o644);
  });

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
      "PANDA_COMMAND_TRANSPORT=http",
    ].join("\n"));

    const result = await runScript(["up"], {
      envFile,
      dockerBin,
      homeDir: await makeTempDir("panda-home-"),
    });

    expect(result.exitCode).toBe(0);
    expect(await readFile(generatedComposePath, "utf8")).toBe("services: {}\n");
    expect(permissionBits((await stat(path.dirname(generatedComposePath))).mode)).toBe(0o700);
    expect(permissionBits((await stat(generatedComposePath)).mode)).toBe(0o600);
    expect(await readFile(generatedWikiComposePath, "utf8")).not.toContain("ports:");
    const dockerLog = await readFile(logPath, "utf8");
    expect(dockerLog).not.toContain("panda agent ensure");
    const stopIndex = dockerLog.indexOf("stop writer-panda-core");
    const migrateIndex = dockerLog.indexOf(" run --rm --no-deps panda-core db migrate");
    const upIndex = dockerLog.indexOf(" up -d --remove-orphans");
    expect(stopIndex).toBeGreaterThanOrEqual(0);
    expect(migrateIndex).toBeGreaterThan(stopIndex);
    expect(dockerLog).toContain("panda-core db migrate --writers-stopped");
    expect(upIndex).toBeGreaterThan(migrateIndex);
    for (const service of ["panda-telegram", "panda-discord", "panda-whatsapp", "panda-gateway"]) {
      expect(dockerLog).toContain(`stop writer-${service}`);
    }
  });

  it("leaves Panda database writers stopped when migration fails", async () => {
    const logPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const dockerBin = await createFailingMigrationDockerStub(logPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "PANDA_AGENTS=",
      "PANDA_COMMAND_TRANSPORT=http",
    ].join("\n"));

    const result = await runScript(["up"], {
      envFile,
      dockerBin,
      homeDir: await makeTempDir("panda-home-"),
    });

    expect(result.exitCode).toBe(42);
    const dockerLog = await readFile(logPath, "utf8");
    expect(dockerLog).toContain("stop writer-panda-core");
    expect(dockerLog).toContain(" run --rm --no-deps panda-core db migrate");
    expect(dockerLog).not.toContain(" up -d");
    expect(dockerLog).not.toContain(" start panda-core");
  });


  it("keeps Panda Trace collector labels disabled by default", async () => {
    const logPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const dockerBin = await createDockerStub(logPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "PANDA_AGENTS=",
      "PANDA_COMMAND_TRANSPORT=http",
    ].join("\n"));

    const result = await runScript(["up"], {
      envFile,
      dockerBin,
      homeDir: await makeTempDir("panda-home-"),
    });

    expect(result.exitCode).toBe(0);
    const compose = await readFile(generatedComposePath, "utf8");
    expect(compose).toBe("services: {}\n");
    expect(compose).not.toContain("panda_trace.enabled");
    expect(result.stderr).not.toContain("PANDA_TRACE_SOURCE_");
  });

  it("labels only selected services for host-level Panda Trace collection", async () => {
    const logPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const dockerBin = await createDockerStub(logPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "PANDA_AGENTS=",
      "PANDA_COMMAND_TRANSPORT=http",
      "PANDA_TRACE_COLLECTOR_ENABLED=true",
      "PANDA_TRACE_COLLECTOR_SERVICES=core,discord",
      "PANDA_TRACE_ENVIRONMENT=staging",
      "PANDA_TRACE_SOURCE_CORE=src_core_123",
      "PANDA_TRACE_SOURCE_DISCORD=src_discord_456",
    ].join("\n"));

    const result = await runScript(["up"], {
      envFile,
      dockerBin,
      homeDir: await makeTempDir("panda-home-"),
    });

    expect(result.exitCode).toBe(0);
    const compose = await readFile(generatedComposePath, "utf8");
    expect((compose.match(/panda_trace.enabled: "true"/g) ?? [])).toHaveLength(2);
    expectTraceLabels(compose, "panda-core", "src_core_123", "staging");
    expectTraceLabels(compose, "panda-discord", "src_discord_456", "staging");
    expect(compose).not.toContain('panda_trace.service: "panda-browser-runner"');
    expect(compose).not.toContain('panda_trace.service: "panda-telegram"');
    expect(compose).not.toContain('panda_trace.service: "panda-whatsapp"');
    expect(compose).not.toContain("PANDA_TRACE_KEY");
  });

  it("labels environment manager, agent runners, wiki, and caddy for Panda Trace", async () => {
    const logPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const dockerBin = await createDockerStub(logPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "PANDA_AGENTS=clawd",
      "PANDA_DISPOSABLE_ENVIRONMENTS_ENABLED=true",
      "PANDA_EXECUTION_ENVIRONMENT_MANAGER_TOKEN=environment-manager-token",
      "PANDA_APPS_BASE_URL=https://panda.example.com",
      "PANDA_APPS_PUBLIC_HOST=panda.example.com",
      "PANDA_TRACE_COLLECTOR_ENABLED=true",
      "PANDA_TRACE_COLLECTOR_SERVICES=environment-manager,runners,wiki,caddy",
      "PANDA_TRACE_SOURCE_ENVIRONMENT_MANAGER=src_env",
      "PANDA_TRACE_SOURCE_RUNNERS=src_runners",
      "PANDA_TRACE_SOURCE_WIKI=src_wiki",
      "PANDA_TRACE_SOURCE_CADDY=src_caddy",
    ].join("\n"));

    const result = await runScript(["up"], {
      envFile,
      dockerBin,
      homeDir: await makeTempDir("panda-home-"),
    });

    expect(result.exitCode).toBe(0);
    const compose = await readFile(generatedComposePath, "utf8");
    expectTraceLabels(compose, "panda-environment-manager", "src_env", "prod");
    expect(compose).toContain("  panda-runner-clawd:");
    expect(compose).toContain('      panda_trace.source_id: "src_runners"');
    expect(compose).toContain('      panda_trace.service: "panda-runners"');
    expectTraceLabels(compose, "wiki", "src_wiki", "prod");
    expectTraceLabels(compose, "caddy", "src_caddy", "prod");
  });

  it("fails clearly when a selected Panda Trace service source id is missing", async () => {
    const logPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const dockerBin = await createDockerStub(logPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "PANDA_AGENTS=",
      "PANDA_COMMAND_TRANSPORT=http",
      "PANDA_TRACE_COLLECTOR_ENABLED=true",
      "PANDA_TRACE_COLLECTOR_SERVICES=core,discord",
      "PANDA_TRACE_SOURCE_CORE=src_core_123",
    ].join("\n"));

    const result = await runScript(["up"], {
      envFile,
      dockerBin,
      homeDir: await makeTempDir("panda-home-"),
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(
      "PANDA_TRACE_SOURCE_DISCORD is required when PANDA_TRACE_COLLECTOR_SERVICES includes discord.",
    );
  });

  it("rejects Panda Trace collector keys in the app stack env", async () => {
    const logPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const dockerBin = await createDockerStub(logPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "PANDA_AGENTS=",
      "PANDA_TRACE_COLLECTOR_ENABLED=true",
      "PANDA_TRACE_COLLECTOR_SERVICES=core",
      "PANDA_TRACE_SOURCE_CORE=src_core_123",
      "PANDA_TRACE_KEY=secret-collector-key",
    ].join("\n"));

    const result = await runScript(["up"], {
      envFile,
      dockerBin,
      homeDir: await makeTempDir("panda-home-"),
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("PANDA_TRACE_KEY must not be set in the Panda Agent stack env");
  });

  it("rejects Panda Trace collector keys even when Trace labeling is disabled", async () => {
    const cases = [
      {name: "unset", lines: []},
      {name: "false", lines: ["PANDA_TRACE_COLLECTOR_ENABLED=false"]},
    ];

    for (const traceCase of cases) {
      const logPath = path.join(await makeTempDir(`panda-docker-log-${traceCase.name}-`), "docker.log");
      const dockerBin = await createDockerStub(logPath);
      const envFile = await createEnvFile([
        "DATABASE_URL=postgresql://example/panda",
        "WIKI_DB_URL=postgresql://example/wiki",
        "BROWSER_RUNNER_SHARED_SECRET=secret",
        "PANDA_AGENTS=",
        ...traceCase.lines,
        "PANDA_TRACE_KEY=secret-collector-key",
      ].join("\n"));

      const result = await runScript(["up"], {
        envFile,
        dockerBin,
        homeDir: await makeTempDir(`panda-home-${traceCase.name}-`),
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("PANDA_TRACE_KEY must not be set in the Panda Agent stack env");
    }
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
    expect(compose).toContain("PANDA_CONTROL_PUBLIC_URL: ${PANDA_CONTROL_PUBLIC_URL:-}");
    expect(compose).toContain("PANDA_CONTROL_UI_DIR: ${PANDA_CONTROL_UI_DIR:-/app/control-ui}");
    expect(compose).toContain('"${PANDA_CONTROL_PUBLISH_HOST:-127.0.0.1}:${PANDA_CONTROL_PUBLISH_PORT:-${PANDA_CONTROL_PORT:-4767}}:${PANDA_CONTROL_PORT:-4767}"');
  });

  it("enables the command server privately for Docker runner CLI tools", async () => {
    const baseCompose = await readFile(baseComposePath, "utf8");
    const coreStart = baseCompose.indexOf("  panda-core:");
    const browserStart = baseCompose.indexOf("\n  panda-browser-runner:", coreStart);
    const coreSection = baseCompose.slice(coreStart, browserStart);

    expect(coreStart).toBeGreaterThanOrEqual(0);
    expect(browserStart).toBeGreaterThan(coreStart);
    expect(coreSection).toContain("PANDA_COMMAND_SERVER_ENABLED: ${PANDA_COMMAND_SERVER_ENABLED:-true}");
    expect(coreSection).toContain("PANDA_COMMAND_SERVER_HOST: ${PANDA_COMMAND_SERVER_HOST:-0.0.0.0}");
    expect(coreSection).toContain("PANDA_COMMAND_SERVER_PORT: ${PANDA_COMMAND_SERVER_PORT:-8096}");
    expect(coreSection).toContain("PANDA_COMMAND_SERVER_URL: ${PANDA_COMMAND_SERVER_URL:-http://panda-core:${PANDA_COMMAND_SERVER_PORT:-8096}}");
    expect(coreSection).toMatch(/^\s+- browser_runner_net$/m);
    expect(coreSection).not.toMatch(/8096:8096/);
    expect(coreSection).not.toContain("${PANDA_COMMAND_SERVER_PORT:-8096}:${PANDA_COMMAND_SERVER_PORT:-8096}");
    expect(coreSection).not.toContain("PANDA_COMMAND_SERVER_TOKEN");
    expect(coreSection).not.toContain("PANDA_COMMAND_SERVER_ALLOW_COMMANDS");
    expect(coreSection).not.toContain("PANDA_COMMAND_SERVER_AGENT");
    expect(coreSection).not.toContain("PANDA_COMMAND_SERVER_SESSION");
  });

  it("renders socket command transport as an explicit same-host Docker override", async () => {
    const logPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const dockerBin = await createDockerStub(logPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "PANDA_AGENTS=claw",
      "PANDA_COMMAND_TRANSPORT=socket",
    ].join("\n"));
    const homeDir = await makeTempDir("panda-home-");
    const socketHostDir = path.join(homeDir, ".panda", "run", "command");

    const result = await runScript(["up"], {
      envFile,
      dockerBin,
      homeDir,
    });

    expect(result.exitCode).toBe(0);
    expect((await stat(socketHostDir)).isDirectory()).toBe(true);
    const compose = await readFile(generatedComposePath, "utf8");
    const coreStart = compose.indexOf("  panda-core:");
    const runnerStart = compose.indexOf("  panda-runner-claw:");
    const coreSection = compose.slice(coreStart, runnerStart);
    const runnerSection = compose.slice(runnerStart, compose.indexOf("\nnetworks:"));

    expect(coreSection).toContain('PANDA_COMMAND_SERVER_ENABLED: "true"');
    expect(coreSection).toContain("PANDA_COMMAND_SERVER_SOCKET_PATH: /run/panda-command/command.sock");
    expect(coreSection).toContain('PANDA_COMMAND_SERVER_URL: ""');
    expect(coreSection).toContain('PANDA_COMMAND_SOCKET_MOUNTED_RUNNERS: "true"');
    expect(coreSection).toContain(`- "${socketHostDir}:/run/panda-command"`);
    expect(runnerSection).toContain(`- "${socketHostDir}:/run/panda-command:ro"`);
    expect(compose).not.toMatch(/8096:8096/);
    expect(coreSection).not.toContain("PANDA_COMMAND_SERVER_TOKEN");
    expect(coreSection).not.toContain("PANDA_COMMAND_SERVER_ALLOW_COMMANDS");
    expect(coreSection).not.toContain("PANDA_COMMAND_SERVER_AGENT");
    expect(coreSection).not.toContain("PANDA_COMMAND_SERVER_SESSION");
  });

  it("passes the socket host directory to the managed disposable environment manager", async () => {
    const logPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const dockerBin = await createDockerStub(logPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "PANDA_AGENTS=",
      "PANDA_COMMAND_TRANSPORT=socket",
      "PANDA_DISPOSABLE_ENVIRONMENTS_ENABLED=true",
      "PANDA_EXECUTION_ENVIRONMENT_MANAGER_TOKEN=environment-manager-token",
    ].join("\n"));
    const homeDir = await makeTempDir("panda-home-");
    const socketHostDir = path.join(homeDir, ".panda", "run", "command");

    const result = await runScript(["up"], {
      envFile,
      dockerBin,
      homeDir,
    });

    expect(result.exitCode).toBe(0);
    const compose = await readFile(generatedComposePath, "utf8");
    const managerStart = compose.indexOf("  panda-environment-manager:");
    const browserStart = compose.indexOf("  panda-browser-runner:");
    const managerSection = compose.slice(managerStart, browserStart);

    expect(compose).toContain("PANDA_COMMAND_SERVER_SOCKET_PATH: /run/panda-command/command.sock");
    expect(compose).toContain('PANDA_COMMAND_SERVER_URL: ""');
    expect(compose).toContain('PANDA_COMMAND_SOCKET_MOUNTED_RUNNERS: "true"');
    expect(compose).toContain(`- "${socketHostDir}:/run/panda-command"`);
    expect(managerSection).toContain("PANDA_COMMAND_SOCKET_HOST_DIR: ${PANDA_COMMAND_SOCKET_HOST_DIR:-}");
    expect(managerSection).toContain(`- "${socketHostDir}:${socketHostDir}:ro"`);
  });

  it("keeps Control publish disabled unless PANDA_CONTROL_ENABLED is truthy", async () => {
    const logPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const dockerBin = await createDockerStub(logPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "PANDA_AGENTS=",
      "PANDA_COMMAND_TRANSPORT=http",
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
    const homeDir = await makeTempDir("panda-home-");

    const result = await runScript(["up", "--build"], {
      envFile,
      dockerBin,
      homeDir,
    });

    expect(result.exitCode).toBe(0);
    const logContents = await readFile(logPath, "utf8");
    expect(logContents.match(/build --target app -t panda-app:latest/g)).toHaveLength(1);
    expect(logContents.match(/build --target browser-runner -t panda-browser-runner:latest/g)).toHaveLength(1);
    expect(logContents).not.toContain("build --target bash-runner --build-arg NODE_MAJOR=22 -t panda-runner:latest");
    expect(logContents).toContain("up -d --no-build --remove-orphans");
    expect(logContents).not.toContain("up -d --build --remove-orphans");
    expect(permissionBits((await stat(path.join(homeDir, ".panda-core-secrets", "runner-token-master-key"))).mode)).toBe(0o600);
    const baseCompose = await readFile(baseComposePath, "utf8");
    expect(baseCompose).toContain("PANDA_RUNNER_TOKEN_MASTER_KEY_FILE: /run/secrets/panda-core/runner-token-master-key");
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
    const runnerSecretsRoot = path.join(homeDir, ".panda-runner-secrets", "disposable");
    expect(generatedCompose).toContain("panda-environment-manager:");
    expect(generatedCompose).toContain('command: ["environment-manager"]');
    expect(generatedCompose).toContain("PANDA_DOCKER_HOST: ${PANDA_DOCKER_HOST:-unix:///var/run/docker.sock}");
    expect(generatedCompose).toContain('- "/var/run/docker.sock:/var/run/docker.sock"');
    expect(generatedCompose).toContain(`PANDA_ENVIRONMENTS_HOST_ROOT: ${environmentsRoot}`);
    expect(generatedCompose).toContain(`PANDA_DISPOSABLE_RUNNER_SECRETS_HOST_ROOT: ${runnerSecretsRoot}`);
    expect(generatedCompose).toContain("PANDA_DISPOSABLE_RUNNER_SECRETS_ROOT: ${PANDA_DISPOSABLE_RUNNER_SECRETS_ROOT:-/run/panda-runner-secrets}");
    expect(generatedCompose).toContain("PANDA_ENVIRONMENTS_ROOT: ${PANDA_ENVIRONMENTS_ROOT:-/root/.panda/environments}");
    expect(generatedCompose).toContain("PANDA_CORE_ENVIRONMENTS_ROOT: ${PANDA_CORE_ENVIRONMENTS_ROOT:-${PANDA_ENVIRONMENTS_ROOT:-/root/.panda/environments}}");
    expect(generatedCompose).toContain("PANDA_RUNNER_ENVIRONMENTS_ROOT: ${PANDA_RUNNER_ENVIRONMENTS_ROOT:-/environments}");
    expect(generatedCompose).toContain(`- "${environmentsRoot}:${"${PANDA_ENVIRONMENTS_ROOT:-/root/.panda/environments}"}"`);
    expect(generatedCompose).toContain(`- "${runnerSecretsRoot}:${"${PANDA_DISPOSABLE_RUNNER_SECRETS_ROOT:-/run/panda-runner-secrets}"}"`);
    expect(generatedCompose).toContain("PANDA_EXECUTION_ENVIRONMENT_MANAGER_URL: ${PANDA_EXECUTION_ENVIRONMENT_MANAGER_URL}");
    expect(generatedCompose).toContain("PANDA_EXECUTION_ENVIRONMENT_MANAGER_TOKEN: ${PANDA_EXECUTION_ENVIRONMENT_MANAGER_TOKEN}");
    expect(generatedCompose).toContain("PANDA_RUNNER_TOKEN_MASTER_KEY_FILE: /run/secrets/panda-core/runner-token-master-key");
    expect(generatedCompose.match(/BASH_SERVER_SHARED_SECRET: ""/g)).toHaveLength(1);
    expect(generatedCompose).toContain("PANDA_DISPOSABLE_CONTROL_RUNNER_IMAGE: ${PANDA_DISPOSABLE_CONTROL_RUNNER_IMAGE:-${PANDA_DISPOSABLE_RUNNER_IMAGE:-panda-runner:latest}}");
    const workspaceDefaultMatch = generatedCompose.match(/PANDA_DISPOSABLE_WORKSPACE_IMAGE: \${PANDA_DISPOSABLE_WORKSPACE_IMAGE:-panda-workspace:([a-f0-9]{16})}/);
    expect(workspaceDefaultMatch).not.toBeNull();
    const workspaceImage = `panda-workspace:${workspaceDefaultMatch?.[1]}`;
    const managerStart = generatedCompose.indexOf("  panda-environment-manager:");
    const coreSection = generatedCompose.slice(
      generatedCompose.indexOf("  panda-core:"),
      managerStart,
    );
    expect(coreSection).toContain('PANDA_RUNNER_TOKEN_MASTER_KEY: ""');
    expect(coreSection).toContain('BASH_SERVER_AUTH_TOKEN: ""');
    expect(coreSection).toContain('BASH_SERVER_AUTH_TOKEN_FILE: ""');
    expect(coreSection).toContain('BASH_SERVER_SHARED_SECRET: ""');
    const gatewayStart = generatedCompose.indexOf("  panda-gateway:");
    const managerSection = generatedCompose.slice(managerStart, gatewayStart >= 0 ? gatewayStart : generatedCompose.indexOf("\nnetworks:"));
    expect(managerSection).not.toContain("PANDA_RUNNER_TOKEN_MASTER_KEY_FILE");
    expect(managerSection).not.toContain("BASH_SERVER_SHARED_SECRET");
    expect(managerSection).toContain("PANDA_EXECUTION_ENVIRONMENT_MANAGER_URL: ${PANDA_EXECUTION_ENVIRONMENT_MANAGER_URL}");
    expect(managerSection).toContain("PANDA_DISPOSABLE_BROWSER_CONTAINER_NAME: ${PANDA_BROWSER_RUNNER_CONTAINER_NAME:-panda-browser-runner}");
    expect(managerSection).toMatch(/^\s+- execution_manager_net$/m);
    expect(managerSection).toMatch(/^\s+- runner_control_net$/m);
    expect(generatedCompose).toContain("      - execution_manager_net");
    expect(generatedCompose).toContain("      - runner_control_net");
    const browserStart = generatedCompose.indexOf("  panda-browser-runner:");
    const runnerStart = generatedCompose.indexOf("  panda-runner-");
    const networksStart = generatedCompose.indexOf("\nnetworks:");
    expect(browserStart).toBeGreaterThanOrEqual(0);
    const browserEnd = runnerStart >= 0 ? runnerStart : networksStart;
    const browserSection = generatedCompose.slice(browserStart, browserEnd);
    expect(browserSection).toContain("container_name: ${PANDA_BROWSER_RUNNER_CONTAINER_NAME:-panda-browser-runner}");
    expect(browserSection).not.toContain("runner_control_net");
    expect(generatedCompose).toContain("execution_manager_net:\n    name: ${PANDA_EXECUTION_ENVIRONMENT_MANAGER_NETWORK}\n    internal: true");
    expect(generatedCompose).toContain("runner_control_net:\n    name: ${PANDA_DISPOSABLE_RUNNER_CONTROL_NETWORK}\n    internal: true");
    expect(generatedCompose).not.toContain("gateway_edge_net");
    expect(permissionBits((await stat(runnerSecretsRoot)).mode)).toBe(0o700);
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
      "PANDA_DISPOSABLE_RUNNER_SECRETS_HOST_ROOT=$HOME/panda-runner-secrets",
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
    const runnerSecretsRoot = path.join(homeDir, "panda-runner-secrets");
    expect(generatedCompose).toContain(`PANDA_ENVIRONMENTS_HOST_ROOT: ${environmentsRoot}`);
    expect(generatedCompose).toContain(`- "${environmentsRoot}:${"${PANDA_ENVIRONMENTS_ROOT:-/root/.panda/environments}"}"`);
    expect(generatedCompose).toContain(`- "${environmentsRoot}/claw:${"${PANDA_RUNNER_ENVIRONMENTS_ROOT:-/environments}"}"`);
    expect(generatedCompose).toContain(`- "${runnerSecretsRoot}:${"${PANDA_DISPOSABLE_RUNNER_SECRETS_ROOT:-/run/panda-runner-secrets}"}"`);
    const persistentRunnerSection = generatedCompose.slice(
      generatedCompose.indexOf("  panda-runner-claw:"),
      generatedCompose.indexOf("\nnetworks:"),
    );
    expect(persistentRunnerSection).not.toContain(runnerSecretsRoot);
    expect(generatedCompose).not.toContain("$HOME/panda-envs");
    expect(generatedCompose).not.toContain("$HOME/panda-runner-secrets");
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

  it("rejects Core secret roots that resolve through an ancestor symlink into the shared workspace", async () => {
    const logPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const dockerBin = await createDockerStub(logPath);
    const homeDir = await makeTempDir("panda-home-");
    const sharedRoot = path.join(homeDir, ".panda", "shared");
    const aliasRoot = path.join(homeDir, "shared-alias");
    await mkdir(sharedRoot, {recursive: true});
    await symlink(sharedRoot, aliasRoot);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "PANDA_AGENTS=claw",
      `PANDA_CORE_SECRETS_HOST_ROOT=${path.join(aliasRoot, "secrets")}`,
    ].join("\n"));

    const result = await runScript(["up"], {envFile, dockerBin, homeDir});

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("PANDA_CORE_SECRETS_HOST_ROOT must not overlap shared workspace");
    await expect(readFile(path.join(aliasRoot, "secrets", "runner-token-master-key"), "utf8"))
      .rejects.toMatchObject({code: "ENOENT"});
  });

  it("rejects the obsolete shared disposable runner network", async () => {
    const logPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const dockerBin = await createDockerStub(logPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "PANDA_DISPOSABLE_ENVIRONMENTS_ENABLED=true",
      "PANDA_EXECUTION_ENVIRONMENT_MANAGER_TOKEN=environment-manager-token",
      "PANDA_DISPOSABLE_RUNNER_NETWORK=old-shared-net",
    ].join("\n"));

    const result = await runScript(["up"], {
      envFile,
      dockerBin,
      homeDir: await makeTempDir("panda-home-"),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("replaced by PANDA_DISPOSABLE_RUNNER_CONTROL_NETWORK");
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

  it("renders one runner per agent, enables telegram explicitly, and maps agent logs to runner services", async () => {
    const logPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const dockerBin = await createDockerStub(logPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "TELEGRAM_ENABLED=true",
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
    expect(generatedCompose).toContain("pull_policy: never");
    expect(generatedCompose).toContain('command: ["bash-server"]');
    expect(generatedCompose).toContain("BASH_SERVER_AUTH_TOKEN_FILE: /run/secrets/panda-runner/token");
    expect(generatedCompose.match(/BASH_SERVER_SHARED_SECRET: ""/g)).toHaveLength(1);
    expect(generatedCompose).toContain("BASH_SERVER_ALLOWED_ROOTS: ${BASH_SERVER_ALLOWED_ROOTS:-}");
    expect(generatedCompose.match(/restart: unless-stopped/g)).toHaveLength(2);
    expect(generatedCompose).not.toContain("panda-runner-Luna");
    expect(generatedCompose).not.toContain("image: panda:latest");
    const environmentsRoot = path.join(homeDir, ".panda", "environments");
    expect(generatedCompose).toContain(`- "${environmentsRoot}/claw:${"${PANDA_RUNNER_ENVIRONMENTS_ROOT:-/environments}"}"`);
    expect(generatedCompose).toContain(`- "${environmentsRoot}/luna:${"${PANDA_RUNNER_ENVIRONMENTS_ROOT:-/environments}"}"`);
    const runnerAuthDir = path.join(homeDir, ".panda-core-secrets", "runner-auth");
    const clawToken = (await readFile(path.join(runnerAuthDir, "claw.token"), "utf8")).trim();
    const lunaToken = (await readFile(path.join(runnerAuthDir, "luna.token"), "utf8")).trim();
    expect(clawToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(lunaToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(clawToken).not.toBe(lunaToken);
    expect(permissionBits((await stat(path.join(homeDir, ".panda-core-secrets", "runner-token-master-key"))).mode)).toBe(0o600);
    expect(permissionBits((await stat(path.join(homeDir, ".panda-core-secrets"))).mode)).toBe(0o700);
    expect(permissionBits((await stat(path.join(runnerAuthDir, "claw.token"))).mode)).toBe(0o600);
    expect(generatedCompose).not.toContain(clawToken);
    expect(generatedCompose).not.toContain(lunaToken);
    expect(generatedCompose.match(/\/workspace\/shared/g)).toHaveLength(3);
    const clawRunnerSection = generatedCompose.slice(
      generatedCompose.indexOf("  panda-runner-claw:"),
      generatedCompose.indexOf("  panda-runner-luna:"),
    );
    expect(clawRunnerSection).toContain(`${runnerAuthDir}/claw.token:/run/secrets/panda-runner/token:ro`);
    expect(clawRunnerSection).not.toContain("runner-token-master-key");
    expect(clawRunnerSection).not.toContain("/run/secrets/panda-core");
    expect(clawRunnerSection).not.toContain("BASH_SERVER_SHARED_SECRET");

    const baseCompose = await readFile(baseComposePath, "utf8");
    expect(baseCompose).toContain("  panda-telegram:\n    image: panda-app:latest");
    expect(baseCompose).toContain('command: ["telegram", "run", "--all-enabled"]');
    expect(baseCompose).toContain("PANDA_TELEGRAM_DB_POOL_MAX: ${PANDA_TELEGRAM_DB_POOL_MAX:-2}");
    expect(baseCompose).toContain("  panda-discord:\n    image: panda-app:latest");
    expect(baseCompose).toContain('command: ["discord", "run", "--all-enabled"]');
    expect(baseCompose).toContain("PANDA_DISCORD_DB_POOL_MAX: ${PANDA_DISCORD_DB_POOL_MAX:-2}");
    expect(baseCompose).toContain("  panda-whatsapp:\n    image: panda-app:latest");
    expect(baseCompose).toContain("CREDENTIALS_MASTER_KEY: ${CREDENTIALS_MASTER_KEY:-}");
    expect(baseCompose).toContain("PANDA_WHATSAPP_DB_POOL_MAX: ${PANDA_WHATSAPP_DB_POOL_MAX:-2}");
    expect(baseCompose).toContain("PANDA_WHATSAPP_CALL_WEBHOOK_PORT: ${PANDA_WHATSAPP_CALL_WEBHOOK_PORT:-8096}");
    expect(baseCompose).toContain("PANDA_LIVE_VOICE_ENABLED: ${PANDA_LIVE_VOICE_ENABLED:-false}");
    expect(baseCompose).toContain("${CODEX_HOST_HOME:-${HOME}/.codex}:/root/.codex:ro");
    expect(baseCompose).toContain("${PANDA_WHATSAPP_CALL_WEBHOOK_PUBLISH_HOST:-127.0.0.1}:${PANDA_WHATSAPP_CALL_WEBHOOK_PUBLISH_PORT:-${PANDA_WHATSAPP_CALL_WEBHOOK_PORT:-8096}}:${PANDA_WHATSAPP_CALL_WEBHOOK_PORT:-8096}");
    expect(baseCompose).toContain("${PANDA_CORE_SECRETS_HOST_ROOT:-${HOME}/.panda-core-secrets}:/run/secrets/panda-core:ro");
    expect(baseCompose.match(/PANDA_SCHEDULED_COMMAND_INTEGRITY_KEY: ""/g)).toHaveLength(3);
    expect(baseCompose.match(/PANDA_SCHEDULED_COMMAND_INTEGRITY_KEY_FILE: ""/g)).toHaveLength(3);
    expect(baseCompose.match(/PANDA_RUNNER_TOKEN_MASTER_KEY: ""/g)).toHaveLength(4);
    expect(baseCompose.match(/PANDA_RUNNER_TOKEN_MASTER_KEY_FILE:/g)).toHaveLength(4);
    expect(baseCompose.match(/BASH_SERVER_AUTH_TOKEN: ""/g)).toHaveLength(4);
    expect(baseCompose.match(/BASH_SERVER_AUTH_TOKEN_FILE: ""/g)).toHaveLength(4);
    expect(baseCompose.match(/BASH_SERVER_SHARED_SECRET: ""/g)).toHaveLength(4);
    expect(baseCompose.match(/\.panda-core-secrets/g)).toHaveLength(1);
    expect(baseCompose).toContain("${PANDA_ENVIRONMENTS_HOST_ROOT:-${HOME}/.panda/environments}:${PANDA_ENVIRONMENTS_ROOT:-/root/.panda/environments}");
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

  it("allows operators to explicitly remove every persistent runner from the shared workspace", async () => {
    const logPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const dockerBin = await createDockerStub(logPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "PANDA_AGENTS=claw,luna",
      "PANDA_SHARED_WORKSPACE_AGENTS=",
    ].join("\n"));

    const result = await runScript(["up"], {
      envFile,
      dockerBin,
      homeDir: await makeTempDir("panda-home-"),
    });

    expect(result.exitCode, JSON.stringify(result)).toBe(0);
    const generatedCompose = await readFile(generatedComposePath, "utf8");
    expect(generatedCompose.match(/\/workspace\/shared/g)).toHaveLength(1);
    expect(generatedCompose).toContain('PANDA_SHARED_WORKSPACE_AGENTS: "${PANDA_SHARED_WORKSPACE_AGENTS:-}"');
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
      "account",
      "link",
      "main",
      "--phone",
      "421900000000",
    ], {
      envFile,
      dockerBin,
      homeDir,
    });
    expect(linkResult.exitCode).toBe(0);
    expect(await readFile(logPath, "utf8")).toContain(
      "exec -T panda-core panda whatsapp account link main --phone 421900000000",
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

  it("renders tailnet serve loopback ports without caddy", async () => {
    const logPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const dockerBin = await createDockerStub(logPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "PANDA_TAILNET_SERVE_ENABLED=true",
      "PANDA_APPS_BASE_URL=https://mac-mini.tailnet.ts.net/apps",
      "PANDA_GATEWAY_BASE_URL=https://mac-mini.tailnet.ts.net/gateway",
      "GATEWAY_IP_ALLOWLIST=100.64.0.0/10,127.0.0.1/32",
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
    expect(logContents).not.toContain("docker-compose.apps-edge.yml");
    const generatedCompose = await readFile(generatedComposePath, "utf8");
    expect(generatedCompose).toContain("PANDA_APPS_AUTH: required");
    expect(generatedCompose).toContain("PANDA_APPS_BASE_URL: ${PANDA_APPS_BASE_URL}");
    expect(generatedCompose).toContain('${PANDA_APPS_PUBLISH_HOST:-127.0.0.1}:${PANDA_APPS_PUBLISH_PORT:-${PANDA_APPS_PORT:-8092}}:${PANDA_APPS_PORT:-8092}');
    expect(generatedCompose).toContain("panda-gateway:");
    expect(generatedCompose).toContain("GATEWAY_PATH_PREFIX: ${GATEWAY_PATH_PREFIX:-/gateway}");
    expect(generatedCompose).toContain('${GATEWAY_PUBLISH_HOST:-127.0.0.1}:${GATEWAY_PUBLISH_PORT:-${GATEWAY_PORT:-8094}}:${GATEWAY_PORT:-8094}');
    expect(generatedCompose).not.toContain("  caddy:");
    expect(generatedCompose).not.toContain("apps_edge_net");
    expect(generatedCompose).not.toContain("gateway_edge_net");
    expect(await readFile(generatedPublicCaddyfilePath, "utf8")).toContain("Public edge is disabled");
    expect(upResult.stdout).toContain("tailscale serve --bg --set-path=/apps http://127.0.0.1:8092");
    expect(upResult.stdout).toContain("tailscale serve --bg --set-path=/gateway http://127.0.0.1:8094");

    const logsResult = await runScript(["logs", "apps"], {
      envFile,
      dockerBin,
      homeDir,
    });
    expect(logsResult.exitCode).toBe(0);
    expect(await readFile(logPath, "utf8")).toContain("logs -f panda-core");
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
    expect(gatewaySection).not.toContain("runner_control_net");
    expect(gatewaySection).not.toContain("execution_manager_net");
    expect(caddySection).toContain("gateway_edge_net");
    expect(caddySection).not.toContain("runner_control_net");
    expect(caddySection).not.toContain("execution_manager_net");
    expect(browserSection).not.toContain("runner_control_net");
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
    const wikiLog = await readFile(wikiLogPath, "utf8");
    expect(wikiLog).toContain("bootstrap claw luna");
    expect(wikiLog).toContain(`WIKI_DOCKER_BIN=${dockerBin}`);
    expect(wikiLog).toContain("PANDA_WIKI_BINDING_TRANSPORT=compose");
    expect(wikiLog).toContain(`WIKI_ENV_FILE=${await realpath(envFile)}`);
    expect(wikiLog).not.toContain("wiki-host.env");
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
