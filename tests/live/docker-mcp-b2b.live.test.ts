import {execFile as execFileCallback} from "node:child_process";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";

import {afterAll, beforeAll, describe, expect, it} from "vitest";

const execFile = promisify(execFileCallback);
const RUN_LIVE = process.env.PANDA_MCP_B2B_DOCKER_SMOKE === "1";
const describeLive = RUN_LIVE ? describe : describe.skip;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function docker(args: string[], options: {allowFailure?: boolean} = {}): Promise<string> {
  try {
    return (await execFile("docker", args, {cwd: repoRoot, timeout: 600_000, maxBuffer: 20 * 1024 * 1024})).stdout.trim();
  } catch (error) {
    if (options.allowFailure) return "";
    throw error;
  }
}

describeLive("Docker MCP built-app B2B smoke", () => {
  const suffix = `mcp-b2b-${process.pid}-${Date.now()}`;
  const image = `panda-app:${suffix}`;
  const network = `panda-${suffix}`;
  const fixture = `panda-${suffix}-fixture`;

  beforeAll(async () => {
    await docker(["info"]);
    await docker(["build", "--target", "app", "-t", image, "."]);
    await docker(["network", "create", network]);
    await docker([
      "run", "-d", "--name", fixture, "--network", network,
      "--entrypoint", "node", "-e", "FIXTURE_SECRET=docker-fixture-secret",
      image, "/app/examples/mcp/fixture-server.mjs", "--transport", "http", "--port", "3010",
    ]);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if ((await docker(["logs", fixture], {allowFailure: true})).includes("READY ")) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Docker MCP fixture did not become ready.");
  }, 600_000);

  afterAll(async () => {
    await docker(["rm", "-f", fixture], {allowFailure: true});
    await docker(["network", "rm", network], {allowFailure: true});
    await docker(["rmi", "-f", image], {allowFailure: true});
  }, 120_000);

  it("uses checked-in stdio, Streamable HTTP, and SSE fixtures through compiled production modules", async () => {
    const script = `
      import {SdkMcpRunner} from '/app/dist/integrations/mcp/client.js';
      const runner = new SdkMcpRunner();
      const secret = 'docker-fixture-secret';
      const configs = [
        {transport:'stdio',enabled:true,command:process.execPath,args:['/app/examples/mcp/fixture-server.mjs','--transport','stdio'],env:{FIXTURE_SECRET:secret},timeoutMs:10000},
        {transport:'streamable-http',enabled:true,url:'http://${fixture}:3010/mcp',headers:{Authorization:'Bearer '+secret},timeoutMs:10000},
        {transport:'sse',enabled:true,url:'http://${fixture}:3010/sse',headers:{Authorization:'Bearer '+secret},timeoutMs:10000},
      ];
      const output = [];
      for (const config of configs) {
        const tools = await runner.listTools({config,knownSecrets:[secret]});
        const called = await runner.callTool({config,knownSecrets:[secret]},{name:'secret_echo',arguments:{}});
        output.push({transport:config.transport,names:tools.value.tools.map((tool)=>tool.name),result:called.value});
      }
      process.stdout.write(JSON.stringify(output));
    `;
    const output = await docker([
      "run", "--rm", "--network", network, "--entrypoint", "node", image,
      "--input-type=module", "-e", script,
    ]);
    expect(output).not.toContain("docker-fixture-secret");
    const parsed = JSON.parse(output) as Array<{transport: string; names: string[]; result: Record<string, unknown>}>;
    expect(parsed.map((entry) => entry.transport)).toEqual(["stdio", "streamable-http", "sse"]);
    for (const entry of parsed) {
      expect(entry.names).toEqual(["echo", "destructive_fixture"]);
      expect(JSON.stringify(entry.result)).toContain("[redacted]");
    }
  }, 600_000);
});
