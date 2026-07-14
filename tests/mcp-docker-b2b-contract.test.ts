import {readFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {describe, expect, it} from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function source(relative: string): Promise<string> {
  return readFile(path.join(root, relative), "utf8");
}

describe("MCP Docker B2B contract", () => {
  it("uses the built app Control, Postgres, command server, and runner shim instead of a direct SDK smoke", async () => {
    const live = await source("tests/live/docker-mcp-b2b.live.test.ts");
    const core = await source("examples/mcp/docker-b2b-core.mjs");
    expect(live).not.toContain("SdkMcpRunner");
    expect(live).toContain("/api/control/dev-login");
    expect(live).toContain("/agents/panda/mcp-servers/fixture-stdio");
    expect(live).toContain("/agents/panda/mcp-servers/fixture-http");
    expect(live).toContain("PANDA_COMMAND_ACCESS_FILE");
    expect(live).toContain('"--entrypoint", "/usr/local/bin/panda"');
    expect(live).toContain("runtime.agent_mcp_configs");
    expect(core).toContain("createRuntime");
    expect(core).toContain("startControlServer");
    expect(core).toContain("startCommandHttpServer");
    expect(core).toContain('credentialPolicy: {mode: "none"}');
    expect(core).toContain('credentialPolicy: {mode: "allowlist", envKeys: ["FIXTURE_SECRET"]}');
    expect(core).toContain('credentialPolicy: {mode: "all_agent"}');
  });

  it("triggers for every MCP authority, command, shim, subagent, runtime, Control, UI, and fixture seam", async () => {
    const workflow = await source(".github/workflows/live-docker-smoke.yml");
    for (const required of [
      "scripts/agent-command-shim/**",
      "src/app/runtime/**",
      "src/domain/commands/**",
      "src/domain/control/**",
      "src/domain/credentials/**",
      "src/domain/execution-environments/**",
      "src/domain/mcp/**",
      "src/domain/subagents/**",
      "src/integrations/commands/**",
      "src/integrations/control/**",
      "src/integrations/mcp/**",
      "src/panda/commands/**",
      "apps/control-ui/**",
      "examples/mcp/**",
      "tests/live/docker-mcp-b2b.live.test.ts",
    ]) {
      expect(workflow).toContain(`- ${required}`);
    }
  });
});
