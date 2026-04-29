import {spawn} from "node:child_process";
import {mkdtemp, readFile, rm, stat, writeFile} from "node:fs/promises";
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
const generatedCalendarComposePath = path.join(
  repoRoot,
  ".generated/docker-compose.radicale.core.yml",
);
const generatedPublicCaddyfilePath = path.join(repoRoot, ".generated/Caddyfile.public-edge");
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
    await rm(generatedCalendarComposePath, {force: true});
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
printf 'DATABASE_URL=%s\\n' "\${DATABASE_URL-}" >> "${logPath}"
printf 'WIKI_DB_URL=%s\\n' "\${WIKI_DB_URL-}" >> "${logPath}"
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

  it("publishes telepathy on localhost only through the generated override", async () => {
    const logPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const dockerBin = await createDockerStub(logPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "TELEPATHY_PORT=8787",
      "PANDA_AGENTS=",
    ].join("\n"));

    const result = await runScript(["up"], {
      envFile,
      dockerBin,
      homeDir: await makeTempDir("panda-home-"),
    });

    expect(result.exitCode).toBe(0);
    expect(await readFile(generatedComposePath, "utf8")).toContain('127.0.0.1:8787:8787');
  });

  it("does not publish telepathy when it is explicitly disabled", async () => {
    const logPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const dockerBin = await createDockerStub(logPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "TELEPATHY_ENABLED=false",
      "TELEPATHY_PORT=8787",
      "PANDA_AGENTS=",
    ].join("\n"));

    const result = await runScript(["up"], {
      envFile,
      dockerBin,
      homeDir: await makeTempDir("panda-home-"),
    });

    expect(result.exitCode).toBe(0);
    expect(await readFile(generatedComposePath, "utf8")).not.toContain('127.0.0.1:8787:8787');
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
    expect(generatedCompose.match(/restart: unless-stopped/g)).toHaveLength(2);
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

  it("bootstraps one private Radicale calendar per declared agent", async () => {
    const logPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const dockerBin = await createDockerStub(logPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "PANDA_AGENTS=claw,Luna",
    ].join("\n"));

    const homeDir = await makeTempDir("panda-home-");
    const result = await runScript(["up"], {
      envFile,
      dockerBin,
      homeDir,
    });

    expect(result.exitCode).toBe(0);
    const generatedCalendarCompose = await readFile(generatedCalendarComposePath, "utf8");
    expect(generatedCalendarCompose).toContain("PANDA_CALENDAR_URL");
    expect(generatedCalendarCompose).toContain(`UID: ${process.getuid?.() ?? 0}`);
    expect(generatedCalendarCompose).toContain(`GID: ${process.getgid?.() ?? 0}`);
    expect(await readFile(logPath, "utf8")).toContain("docker-compose.radicale.yml");
    const usersPath = path.join(homeDir, ".panda/radicale/config/users");
    const usersFile = await readFile(usersPath, "utf8");
    expect(usersFile).toMatch(/^claw:.+/m);
    expect(usersFile).toMatch(/^luna:.+/m);
    expect((await stat(usersPath)).mode & 0o777).toBe(0o600);
    await expect(readFile(
      path.join(homeDir, ".panda/radicale/data/collections/collection-root/claw/calendar/.Radicale.props"),
      "utf8",
    )).resolves.toBe('{"tag":"VCALENDAR"}\n');

    const logsResult = await runScript(["logs", "calendar"], {
      envFile,
      dockerBin,
      homeDir,
    });
    expect(logsResult.exitCode).toBe(0);
    expect(await readFile(logPath, "utf8")).toContain("logs -f radicale");
  });

  it("skips Radicale when calendar is disabled", async () => {
    const logPath = path.join(await makeTempDir("panda-docker-log-"), "docker.log");
    const dockerBin = await createDockerStub(logPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://example/panda",
      "WIKI_DB_URL=postgresql://example/wiki",
      "BROWSER_RUNNER_SHARED_SECRET=secret",
      "PANDA_AGENTS=claw",
      "PANDA_CALENDAR_ENABLED=false",
    ].join("\n"));

    const homeDir = await makeTempDir("panda-home-");
    const result = await runScript(["up"], {
      envFile,
      dockerBin,
      homeDir,
    });

    expect(result.exitCode).toBe(0);
    expect(await readFile(logPath, "utf8")).not.toContain("docker-compose.radicale.yml");
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
    expect(generatedCompose).toContain('command: ["gateway", "run"]');
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
