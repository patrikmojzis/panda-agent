import {spawn, spawnSync} from "node:child_process";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {afterEach, describe, expect, it} from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repoRoot, "scripts/wiki-local.sh");

interface ScriptResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

describe.sequential("wiki-local.sh", () => {
  const directories: string[] = [];

  afterEach(async () => {
    while (directories.length > 0) {
      await rm(directories.pop() ?? "", {recursive: true, force: true});
    }
  });

  async function makeTempDir(prefix: string): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
    directories.push(directory);
    return directory;
  }

  async function createEnvFile(contents: string): Promise<string> {
    const envPath = path.join(await makeTempDir("panda-wiki-env-"), ".env");
    await writeFile(envPath, contents);
    return envPath;
  }

  async function createCommandStubs(logPath: string): Promise<string> {
    const binDir = await makeTempDir("panda-wiki-bin-");
    const jqPath = process.env.JQ_PATH
      ?? spawnSync("bash", ["-lc", "command -v jq"], {encoding: "utf8"}).stdout.trim();
    if (!jqPath) {
      throw new Error("jq is required for wiki-local.sh tests.");
    }

    await writeFile(path.join(binDir, "docker"), `#!/usr/bin/env bash
set -euo pipefail
printf 'docker %s\\n' "$*" >> "${logPath}"
cat >/dev/null || true
`, {mode: 0o755});

    await writeFile(path.join(binDir, "curl"), `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"/graphql"* ]]; then
  payload=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -d)
        payload="$2"
        shift 2
        ;;
      *)
        shift
        ;;
    esac
  done

  case "$payload" in
    *"authentication { login"*)
      printf '%s' '{"data":{"authentication":{"login":{"jwt":"jwt-token","responseResult":{"succeeded":true,"message":"ok"}}}}}'
      ;;
    *"search { searchEngines"*"isAvailable"*)
      printf '%s' '{"data":{"search":{"searchEngines":[{"key":"postgres","isEnabled":false,"isAvailable":true,"config":[{"key":"dictLanguage","value":"{\\"value\\":\\"simple\\"}"}]}]}}}'
      ;;
    *"updateSearchEngines"*)
      printf '%s' '{"data":{"search":{"updateSearchEngines":{"responseResult":{"succeeded":true,"message":"ok"}}}}}'
      ;;
    *'search { searchEngines { key isEnabled } }'*)
      printf '%s' '{"data":{"search":{"searchEngines":[{"key":"postgres","isEnabled":true}]}}}'
      ;;
    *"rebuildIndex"*)
      printf '%s' '{"data":{"search":{"rebuildIndex":{"responseResult":{"succeeded":true,"message":"ok"}}}}}'
      ;;
    *"groups { list"*)
      printf '%s' '{"data":{"groups":{"list":[]}}}'
      ;;
    *"groups { create"*)
      printf '%s' '{"data":{"groups":{"create":{"responseResult":{"succeeded":true,"message":"ok"},"group":{"id":7,"name":"Claw Agent"}}}}}'
      ;;
    *"groups { update"*)
      printf '%s' '{"data":{"groups":{"update":{"responseResult":{"succeeded":true,"message":"ok"}}}}}'
      ;;
    *'authentication { apiKeys'*)
      printf '%s' '{"data":{"authentication":{"apiKeys":[]}}}'
      ;;
    *"createApiKey"*)
      printf '%s' '{"data":{"authentication":{"createApiKey":{"key":"wiki-api-token","responseResult":{"succeeded":true,"message":"ok"}}}}}'
      ;;
    *"setApiState"*)
      printf '%s' '{"data":{"authentication":{"setApiState":{"responseResult":{"succeeded":true,"message":"ok"}}}}}'
      ;;
    *)
      printf '%s' '{"data":{}}'
      ;;
  esac
  printf 'curl payload %s\n' "$payload" >> "${logPath}"
  exit 0
fi

printf 'ok'
`, {mode: 0o755});

    await writeFile(path.join(binDir, "jq"), `#!/usr/bin/env bash
exec "${jqPath}" "$@"
`, {mode: 0o755});

    return binDir;
  }

  async function runScript(args: string[], options: {
    envFile: string;
    pathPrefix: string;
  }): Promise<ScriptResult> {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    return await new Promise((resolve, reject) => {
      const child = spawn("bash", [scriptPath, ...args], {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${options.pathPrefix}:/usr/bin:/bin`,
          WIKI_ENV_FILE: options.envFile,
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

  it("stores bindings through panda-core when host pnpm is unavailable", async () => {
    const logPath = path.join(await makeTempDir("panda-wiki-log-"), "commands.log");
    const binDir = await createCommandStubs(logPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://agent@example/panda?sslmode=verify-full&sslrootcert=/etc/ssl/certs/panda-postgres-ca.crt",
      "CREDENTIALS_MASTER_KEY=test-master-key",
      "PANDA_AGENTS=claw",
      "WIKI_ADMIN_EMAIL=admin@localhost",
      "WIKI_ADMIN_PASSWORD=secret",
      "WIKI_PUBLISH_PORT=3100",
      "WIKI_DB_URL=postgresql://wiki@example/wiki?sslmode=verify-full&sslrootcert=/etc/ssl/certs/panda-postgres-ca.crt",
    ].join("\n"));

    const result = await runScript(["bootstrap", "claw"], {
      envFile,
      pathPrefix: binDir,
    });

    expect(result.exitCode).toBe(0);
    const logs = await readFile(logPath, "utf8");
    expect(logs).toContain("docker compose --env-file");
    expect(logs).toContain("exec -T panda-core panda wiki binding set claw --group-id 7 --namespace agents/claw --stdin");
    expect(logs).not.toContain("pnpm");
  });

  it("grants namespace-scoped asset read, write, and manage permissions during bootstrap", async () => {
    const logPath = path.join(await makeTempDir("panda-wiki-log-"), "commands.log");
    const binDir = await createCommandStubs(logPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://agent@example/panda",
      "CREDENTIALS_MASTER_KEY=test-master-key",
      "PANDA_AGENTS=claw",
      "WIKI_ADMIN_EMAIL=admin@localhost",
      "WIKI_ADMIN_PASSWORD=secret",
      "WIKI_PUBLISH_PORT=3100",
      "WIKI_DB_URL=postgresql://wiki@example/wiki",
    ].join("\n"));

    const result = await runScript(["bootstrap", "claw"], {
      envFile,
      pathPrefix: binDir,
    });

    expect(result.exitCode).toBe(0);
    const logs = await readFile(logPath, "utf8");
    expect(logs).toContain('"read:assets"');
    expect(logs).toContain('"write:assets"');
    expect(logs).toContain('"manage:assets"');
    expect(logs).toContain('"path": "agents/claw"');
  });

  it("fails cleanly when bootstrap has no reachable host URL configured", async () => {
    const logPath = path.join(await makeTempDir("panda-wiki-log-"), "commands.log");
    const binDir = await createCommandStubs(logPath);
    const envFile = await createEnvFile([
      "DATABASE_URL=postgresql://agent@example/panda?sslmode=verify-full&sslrootcert=/etc/ssl/certs/panda-postgres-ca.crt",
      "CREDENTIALS_MASTER_KEY=test-master-key",
      "WIKI_ADMIN_EMAIL=admin@localhost",
      "WIKI_ADMIN_PASSWORD=secret",
      "WIKI_DB_URL=postgresql://wiki@example/wiki?sslmode=verify-full&sslrootcert=/etc/ssl/certs/panda-postgres-ca.crt",
    ].join("\n"));

    const result = await runScript(["bootstrap", "claw"], {
      envFile,
      pathPrefix: binDir,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("WIKI_SITE_URL or WIKI_PUBLISH_PORT is required");
  });
});
