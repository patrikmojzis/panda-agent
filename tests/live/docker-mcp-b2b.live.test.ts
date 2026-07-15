import {execFile as execFileCallback} from "node:child_process";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";

import {afterAll, beforeAll, describe, expect, it} from "vitest";

const execFile = promisify(execFileCallback);
const RUN_LIVE = process.env.PANDA_MCP_B2B_DOCKER_SMOKE === "1";
const describeLive = RUN_LIVE ? describe : describe.skip;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureSecret = "docker-fixture-secret";

interface DockerResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function docker(args: string[], options: {allowFailure?: boolean} = {}): Promise<DockerResult> {
  try {
    const result = await execFile("docker", args, {
      cwd: repoRoot,
      timeout: 600_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    return {stdout: result.stdout.trim(), stderr: result.stderr.trim(), exitCode: 0};
  } catch (error) {
    if (!options.allowFailure) throw error;
    const failure = error as {stdout?: string; stderr?: string; code?: number};
    return {
      stdout: failure.stdout?.trim() ?? "",
      stderr: failure.stderr?.trim() ?? "",
      exitCode: typeof failure.code === "number" ? failure.code : 1,
    };
  }
}

function cookieHeader(response: Response): string {
  const values = response.headers.getSetCookie?.() ?? [response.headers.get("set-cookie") ?? ""];
  return values.map((value) => value.split(";", 1)[0]).filter(Boolean).join("; ");
}

describeLive("Docker MCP built-app Control-to-shim B2B", () => {
  const suffix = `mcp-b2b-${process.pid}-${Date.now()}`;
  const appImage = `panda-app:${suffix}`;
  const runnerImage = `panda-runner:${suffix}`;
  const network = `panda-${suffix}`;
  const volume = `panda-${suffix}-access`;
  const postgres = `panda-${suffix}-postgres`;
  const fixture = `panda-${suffix}-fixture`;
  const core = `panda-${suffix}-core`;
  let controlBase = "";
  let cookie = "";
  let csrf = "";
  const createdContainers = new Set<string>();
  const createdImages = new Set<string>();
  const createdNetworks = new Set<string>();
  const createdVolumes = new Set<string>();

  async function waitForLog(container: string, marker: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const logs = await docker(["logs", container], {allowFailure: true});
      if (`${logs.stdout}\n${logs.stderr}`.includes(marker)) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`${container} did not emit ${marker}.`);
  }

  async function controlWrite(pathname: string, method: "POST" | "PUT" | "DELETE", body?: unknown): Promise<Response> {
    return fetch(`${controlBase}/api/control${pathname}`, {
      method,
      headers: {
        cookie,
        "x-control-csrf": csrf,
        ...(body === undefined ? {} : {"content-type": "application/json"}),
      },
      ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    });
  }

  type AccessName = "primary-initial" | "primary" | "subagent-deny" | "subagent-allow";

  async function runShim(access: AccessName, args: string[], allowFailure = false): Promise<DockerResult> {
    return docker([
      "run", "--rm", "--network", network,
      "--mount", `source=${volume},target=/run/panda-b2b,readonly`,
      "-e", `PANDA_COMMAND_ACCESS_FILE=/run/panda-b2b/${access}`,
      "--entrypoint", "/usr/local/bin/panda",
      runnerImage,
      ...args,
    ], {allowFailure});
  }

  async function runCommandRequest(access: AccessName, command: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const request = Buffer.from(JSON.stringify({command, input, outputMode: "json"}), "utf8").toString("base64");
    const result = await docker([
      "run", "--rm", "--network", network,
      "--mount", `source=${volume},target=/run/panda-b2b,readonly`,
      "-e", `PANDA_COMMAND_ACCESS_FILE=/run/panda-b2b/${access}`,
      "-e", `MCP_B2B_REQUEST=${request}`,
      "--entrypoint", "/bin/bash",
      runnerImage,
      "-lc",
      '. "$PANDA_COMMAND_ACCESS_FILE"; payload="$(printf %s "$MCP_B2B_REQUEST" | base64 -d)"; curl -sS -H "authorization: Bearer ${PANDA_COMMAND_TOKEN}" -H "content-type: application/json" -X POST --data "$payload" "${PANDA_COMMAND_URL}/commands/execute"',
    ]);
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout) as Record<string, unknown>;
  }

  beforeAll(async () => {
    await docker(["info"]);
    await docker(["build", "--target", "app", "-t", appImage, "."]);
    createdImages.add(appImage);
    await docker(["build", "--target", "bash-runner", "-t", runnerImage, "."]);
    createdImages.add(runnerImage);
    await docker(["network", "create", network]);
    createdNetworks.add(network);
    await docker(["volume", "create", volume]);
    createdVolumes.add(volume);
    await docker([
      "run", "-d", "--name", postgres, "--network", network,
      "-e", "POSTGRES_PASSWORD=postgres", "-e", "POSTGRES_DB=panda",
      "postgres:16-alpine",
    ]);
    createdContainers.add(postgres);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const ready = await docker(["exec", postgres, "pg_isready", "-U", "postgres", "-d", "panda"], {allowFailure: true});
      if (ready.exitCode === 0) break;
      if (attempt === 99) throw new Error("Docker PostgreSQL did not become ready.");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await docker([
      "run", "-d", "--name", fixture, "--network", network,
      "--entrypoint", "node", "-e", `FIXTURE_SECRET=${fixtureSecret}`,
      appImage, "/app/examples/mcp/fixture-server.mjs", "--transport", "http", "--host", "0.0.0.0", "--port", "3010", "--mode", "require-auth",
    ]);
    createdContainers.add(fixture);
    await waitForLog(fixture, "READY ");
    await docker([
      "run", "-d", "--name", core, "--network", network,
      "--mount", `source=${volume},target=/run/panda-b2b`,
      "-p", "127.0.0.1::4767",
      "--entrypoint", "node",
      "-e", "DATABASE_URL=postgres://postgres:postgres@" + postgres + ":5432/panda",
      "-e", "CREDENTIALS_MASTER_KEY=0123456789abcdef0123456789abcdef",
      "-e", "PANDA_COMMAND_SERVER_ENABLED=true",
      "-e", "PANDA_COMMAND_SERVER_HOST=0.0.0.0",
      "-e", "PANDA_COMMAND_SERVER_PORT=8096",
      "-e", `PANDA_COMMAND_SERVER_URL=http://${core}:8096`,
      appImage, "/app/examples/mcp/docker-b2b-core.mjs",
    ]);
    createdContainers.add(core);
    await waitForLog(core, "READY ");
    const published = (await docker(["port", core, "4767/tcp"])).stdout.split("\n", 1)[0]!;
    controlBase = `http://127.0.0.1:${published.slice(published.lastIndexOf(":") + 1)}`;
    const login = await fetch(`${controlBase}/api/control/dev-login`, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({identity: "mcp-b2b", role: "admin"}),
    });
    expect(login.status).toBe(200);
    cookie = cookieHeader(login);
    csrf = ((await login.json()) as {csrfToken: string}).csrfToken;
  }, 600_000);

  afterAll(async () => {
    const failures: string[] = [];
    const removeAndAssert = async (
      label: string,
      names: Iterable<string>,
      remove: (name: string) => string[],
      inspect: (name: string) => string[],
    ) => {
      for (const name of [...names].reverse()) {
        const removed = await docker(remove(name), {allowFailure: true});
        if (removed.exitCode !== 0) failures.push(`${label} ${name} removal exited ${removed.exitCode}`);
        const remaining = await docker(inspect(name), {allowFailure: true});
        if (remaining.exitCode === 0) failures.push(`${label} ${name} still exists after removal`);
      }
    };
    await removeAndAssert("container", createdContainers, (name) => ["rm", "-f", name], (name) => ["inspect", name]);
    await removeAndAssert("volume", createdVolumes, (name) => ["volume", "rm", "-f", name], (name) => ["volume", "inspect", name]);
    await removeAndAssert("network", createdNetworks, (name) => ["network", "rm", name], (name) => ["network", "inspect", name]);
    await removeAndAssert("image", createdImages, (name) => ["rmi", "-f", name], (name) => ["image", "inspect", name]);
    if (failures.length > 0) throw new Error(`Docker MCP B2B cleanup failed: ${failures.join("; ")}`);
  }, 120_000);

  it("persists authenticated Control config and executes primary/deny/allow/HTTP calls through the real shim boundary", async () => {
    const credential = await controlWrite("/agents/panda/credentials", "POST", {
      envKey: "FIXTURE_SECRET",
      value: fixtureSecret,
    });
    expect(credential.status).toBe(200);
    const stdio = await controlWrite("/agents/panda/mcp-servers/fixture-stdio", "PUT", {
      transport: "stdio",
      enabled: true,
      command: "/usr/bin/node",
      args: ["/app/examples/mcp/fixture-server.mjs", "--transport", "stdio"],
      env: {FIXTURE_SECRET: {credentialEnvKey: "FIXTURE_SECRET"}},
      timeoutMs: 10_000,
    });
    expect(stdio.status).toBe(200);
    const http = await controlWrite("/agents/panda/mcp-servers/fixture-http", "PUT", {
      transport: "streamable-http",
      enabled: true,
      url: `http://${fixture}:3010/mcp`,
      auth: {type: "bearer", credentialEnvKey: "FIXTURE_SECRET"},
      timeoutMs: 10_000,
    });
    expect(http.status).toBe(200);
    const persisted = await docker([
      "exec", postgres, "psql", "-U", "postgres", "-d", "panda", "-Atc",
      "SELECT count(*) FROM runtime.agent_mcp_configs AS configs CROSS JOIN LATERAL jsonb_object_keys(configs.config->'servers') AS server_keys(server_name) WHERE configs.agent_key='panda'",
    ]);
    expect(persisted.stdout).toBe("2");

    const primaryInitial = await runShim("primary-initial", ["mcp", "tools", "fixture-stdio"]);
    expect(primaryInitial.exitCode).toBe(0);
    expect(primaryInitial.stdout).toContain("echo");
    expect(primaryInitial.stdout).not.toContain(fixtureSecret);

    const primary = await runShim("primary", ["mcp", "call", "fixture-stdio", "echo", "--input", '{"message":"primary-ok"}']);
    expect(primary.exitCode).toBe(0);
    expect(primary.stdout).toContain("primary-ok");
    expect(primary.stdout).not.toContain(fixtureSecret);

    const denied = await runShim("subagent-deny", ["mcp", "call", "fixture-stdio", "secret_echo", "--input", "{}"], true);
    expect(denied.exitCode).toBe(3);
    expect(denied.stderr).toContain("MCP credential FIXTURE_SECRET is not allowed by this execution scope.");
    expect(`${denied.stdout}\n${denied.stderr}`).not.toContain(fixtureSecret);
    const deniedJson = await runCommandRequest("subagent-deny", "mcp.call", {
      server: "fixture-stdio",
      tool: "secret_echo",
      input: {},
    });
    expect(deniedJson).toMatchObject({
      ok: false,
      error: {
        message: "MCP credential FIXTURE_SECRET is not allowed by this execution scope.",
        details: {exitCode: 3, kind: "authentication"},
      },
    });

    const allowed = await runShim("subagent-allow", ["mcp", "call", "fixture-stdio", "secret_echo", "--input", "{}"]);
    expect(allowed.exitCode).toBe(0);
    expect(allowed.stdout).toContain("[redacted]");
    expect(allowed.stdout).not.toContain(fixtureSecret);

    const remote = await runShim("subagent-allow", ["mcp", "call", "fixture-http", "secret_echo", "--input", "{}"]);
    expect(remote.exitCode).toBe(0);
    expect(remote.stdout).toContain("[redacted]");
    expect(remote.stdout).not.toContain(fixtureSecret);

    const deleteHttp = await controlWrite("/agents/panda/mcp-servers/fixture-http", "DELETE");
    expect(deleteHttp.status).toBe(200);
    await expect(deleteHttp.json()).resolves.toMatchObject({deleted: true});
    const deleteStdio = await controlWrite("/agents/panda/mcp-servers/fixture-stdio", "DELETE");
    expect(deleteStdio.status).toBe(200);
    await expect(deleteStdio.json()).resolves.toMatchObject({deleted: true});
    const removed = await docker([
      "exec", postgres, "psql", "-U", "postgres", "-d", "panda", "-Atc",
      "SELECT count(*) FROM runtime.agent_mcp_configs WHERE agent_key='panda'",
    ]);
    expect(removed.stdout).toBe("0");
  }, 600_000);
});
