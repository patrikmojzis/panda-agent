import path from "node:path";
import {fileURLToPath} from "node:url";

import {describe, expect, it, vi} from "vitest";

import {RuntimeCommandDispatcher} from "../src/app/runtime/command-dispatcher.js";
import {resolveCommandLeaseAuthority} from "../src/domain/execution-environments/command-authority.js";
import {
  createMcpCallCommand,
  createMcpToolsCommand,
  MCP_CALL_COMMAND_NAME,
  MCP_TOOLS_COMMAND_NAME,
} from "../src/domain/mcp/commands.js";
import {InMemoryMcpConfigStore} from "../src/domain/mcp/store.js";
import type {McpRunner} from "../src/domain/mcp/types.js";
import {DEFAULT_AGENT_COMMAND_CATALOG} from "../src/panda/commands/agent-command-modules.js";
import {SdkMcpRunner} from "../src/integrations/mcp/client.js";

const secret = "raw-secret-value";
const fixturePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../examples/mcp/fixture-server.mjs");
const baseConfig = {
  servers: {
    fixture: {
      transport: "stdio",
      enabled: true,
      command: "node",
      args: ["fixture.mjs"],
      env: {
        FIXTURE_SECRET: {credentialEnvKey: "FIXTURE_SECRET"},
        TENANT: {value: "demo"},
      },
      timeoutMs: 30_000,
    },
  },
};

function request(command: "mcp.tools" | "mcp.call", input: Record<string, unknown>, scope: Record<string, unknown> = {}) {
  return {
    command,
    input,
    scope: {
      agentKey: "panda",
      sessionId: "session-panda",
      allowedCommands: ["mcp.tools", "mcp.call"],
      credentialPolicy: {mode: "all_agent" as const},
      ...scope,
    },
  };
}

function dependencies(overrides: {configs?: InMemoryMcpConfigStore; runner?: McpRunner; credentials?: {resolveCredential: ReturnType<typeof vi.fn>}} = {}) {
  const runner = overrides.runner ?? {
    listTools: vi.fn(async () => ({
      value: {
        tools: [{name: "write_fixture", inputSchema: {type: "object"}, annotations: {destructiveHint: true}}],
        _meta: {complete: true},
      },
      diagnostics: {transport: "stdio" as const, stderr: "", stderrTruncated: false},
    })),
    callTool: vi.fn(async () => ({
      value: {
        content: [{type: "text", text: "hello"}],
        structuredContent: {nested: true},
        _meta: {preserved: true},
        isError: false,
      },
      diagnostics: {transport: "stdio" as const, stderr: "", stderrTruncated: false},
    })),
  };
  const credentials = overrides.credentials ?? {
    resolveCredential: vi.fn(async (envKey: string) => ({envKey, value: secret})),
  };
  return {
    configs: overrides.configs ?? new InMemoryMcpConfigStore({panda: baseConfig}),
    runner,
    credentials,
  };
}

describe("generic MCP commands", () => {
  it("keeps MCP catalog visibility behind the mcp group", () => {
    expect(DEFAULT_AGENT_COMMAND_CATALOG.namesForToolGroups(["mcp"])).toEqual(["mcp.*"]);
    expect(resolveCommandLeaseAuthority({
      commandCatalog: DEFAULT_AGENT_COMMAND_CATALOG,
      toolPolicy: {},
    }).filter((name) => name.startsWith("mcp."))).toEqual([]);
    expect(resolveCommandLeaseAuthority({
      commandCatalog: DEFAULT_AGENT_COMMAND_CATALOG,
      toolPolicy: {allowedTools: ["mcp.*"]},
    }).filter((name) => name.startsWith("mcp."))).toEqual([MCP_TOOLS_COMMAND_NAME, MCP_CALL_COMMAND_NAME]);
  });

  it("loads the agent registry and preserves full tool/result envelopes", async () => {
    const deps = dependencies();
    const dispatcher = new RuntimeCommandDispatcher({
      commands: [createMcpToolsCommand(deps), createMcpCallCommand(deps)],
    });
    const tools = await dispatcher.execute(request("mcp.tools", {server: "fixture"}));
    expect(tools).toMatchObject({
      ok: true,
      output: {
        server: "fixture",
        toolCount: 1,
        tools: [{name: "write_fixture", annotations: {destructiveHint: true}}],
        _meta: {complete: true},
        diagnostics: {transport: "stdio", configSource: "database"},
      },
    });
    const called = await dispatcher.execute(request("mcp.call", {server: "fixture", tool: "echo", input: {message: "hi"}}));
    expect(called).toMatchObject({
      ok: true,
      output: {
        content: [{type: "text", text: "hello"}],
        structuredContent: {nested: true},
        _meta: {preserved: true},
        exitCode: 0,
      },
    });
    expect(deps.runner.callTool).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({env: {FIXTURE_SECRET: secret, TENANT: "demo"}}),
      knownSecrets: [secret],
    }), {name: "echo", arguments: {message: "hi"}});
  });

  it.each([
    undefined,
    {mode: "none"},
    {mode: "allowlist", envKeys: []},
  ])("denies credential refs before resolve or external work for policy %j", async (credentialPolicy) => {
    const deps = dependencies();
    const dispatcher = new RuntimeCommandDispatcher({commands: [createMcpToolsCommand(deps)]});
    const result = await dispatcher.execute(request("mcp.tools", {server: "fixture"}, {credentialPolicy}));
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "forbidden",
        message: "An MCP credential required by this server is not allowed in the current execution scope.",
        details: {
          failureCode: "command_scope_denied",
          retryable: false,
          exitCode: 3,
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("FIXTURE_SECRET");
    expect(deps.credentials.resolveCredential).not.toHaveBeenCalled();
    expect(deps.runner.listTools).not.toHaveBeenCalled();
  });

  it("allows an explicit subagent credential allowlist", async () => {
    const deps = dependencies();
    const result = await new RuntimeCommandDispatcher({commands: [createMcpToolsCommand(deps)]}).execute(
      request("mcp.tools", {server: "fixture"}, {credentialPolicy: {mode: "allowlist", envKeys: ["FIXTURE_SECRET"]}}),
    );
    expect(result.ok).toBe(true);
    expect(deps.runner.listTools).toHaveBeenCalledOnce();
  });

  it("requires the opaque OAuth grant ref before creating a runtime client", async () => {
    const configs = new InMemoryMcpConfigStore({panda: {servers: {analytics: {
      transport: "streamable-http",
      enabled: true,
      url: "http://127.0.0.1:3010/mcp",
      auth: {
        type: "oauth",
        registration: {mode: "dynamic"},
        scope: {mode: "explicit", values: ["resource:read"]},
      },
      timeoutMs: 5_000,
    }}}});
    const deps = dependencies({configs});
    const dispatcher = new RuntimeCommandDispatcher({commands: [createMcpToolsCommand(deps)]});

    const denied = await dispatcher.execute(request("mcp.tools", {server: "analytics"}, {
      credentialPolicy: {mode: "allowlist", envKeys: [], credentialRefs: []},
    }));
    expect(denied).toMatchObject({ok: false, error: {code: "forbidden", details: {failureCode: "command_scope_denied"}}});
    expect(deps.runner.listTools).not.toHaveBeenCalled();

    const allowed = await dispatcher.execute(request("mcp.tools", {server: "analytics"}, {
      credentialPolicy: {mode: "allowlist", envKeys: [], credentialRefs: ["mcp-oauth:analytics"]},
    }));
    expect(allowed.ok).toBe(true);
    expect(deps.runner.listTools).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({
        oauth: expect.objectContaining({agentKey: "panda", serverName: "analytics"}),
      }),
    }));
    expect(deps.credentials.resolveCredential).not.toHaveBeenCalled();
  });

  it.each([
    [async () => null, "not configured"],
    [async () => { throw new Error(`decrypt ${secret}`); }, "could not be decrypted"],
  ])("fails missing/unreadable credentials before external work", async (resolveCredential, message) => {
    const deps = dependencies({credentials: {resolveCredential: vi.fn(resolveCredential)}});
    const result = await new RuntimeCommandDispatcher({commands: [createMcpToolsCommand(deps)]}).execute(
      request("mcp.tools", {server: "fixture"}),
    );
    expect(result).toMatchObject({ok: false, error: {details: {exitCode: 3, kind: "authentication"}}});
    expect(JSON.stringify(result)).toContain(message);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(deps.runner.listTools).not.toHaveBeenCalled();
  });

  it("keeps full-runner secret keys out of command/transcript-visible serialization", async () => {
    const configs = new InMemoryMcpConfigStore({panda: {servers: {fixture: {
      transport: "stdio",
      enabled: true,
      command: process.execPath,
      args: [fixturePath, "--transport", "stdio", "--mode", "secret-keys"],
      env: {FIXTURE_SECRET: {credentialEnvKey: "FIXTURE_SECRET"}},
      timeoutMs: 5_000,
    }}}});
    const deps = dependencies({configs, runner: new SdkMcpRunner()});
    const dispatcher = new RuntimeCommandDispatcher({
      commands: [createMcpToolsCommand(deps), createMcpCallCommand(deps)],
    });
    const tools = await dispatcher.execute(request("mcp.tools", {server: "fixture"}));
    const called = await dispatcher.execute(request("mcp.call", {server: "fixture", tool: "secret_echo", input: {}}));
    for (const visible of [tools, called]) {
      const serialized = JSON.stringify(visible);
      expect(serialized).not.toContain(secret);
      expect(serialized).toContain('"[redacted]"');
    }
    expect(called).toMatchObject({
      ok: true,
      output: {
        structuredContent: {"[redacted]": "structured-key"},
        _meta: {"[redacted]": "result-metadata"},
      },
    });
  });

  it("preserves tool-level isError as command output with exitCode 4", async () => {
    const deps = dependencies({
      runner: {
        listTools: vi.fn(),
        callTool: vi.fn(async () => ({
          value: {content: [{type: "text", text: "tool failed"}], isError: true},
          diagnostics: {transport: "stdio" as const, stderr: "", stderrTruncated: false},
        })),
      },
    });
    const result = await new RuntimeCommandDispatcher({commands: [createMcpCallCommand(deps)]}).execute(
      request("mcp.call", {server: "fixture", tool: "tool_error", input: {}}),
    );
    expect(result).toMatchObject({ok: true, output: {isError: true, exitCode: 4, phase: "tool_error"}});
  });

  it("fails disabled and unknown servers before credential resolution", async () => {
    const configs = new InMemoryMcpConfigStore({panda: {
      servers: {disabled: {...baseConfig.servers.fixture, enabled: false}},
    }});
    const deps = dependencies({configs});
    const dispatcher = new RuntimeCommandDispatcher({commands: [createMcpToolsCommand(deps)]});
    await expect(dispatcher.execute(request("mcp.tools", {server: "disabled"}))).resolves.toMatchObject({
      ok: false,
      error: {details: {kind: "config_input"}},
    });
    await expect(dispatcher.execute(request("mcp.tools", {server: "unknown"}))).resolves.toMatchObject({
      ok: false,
      error: {details: {kind: "config_input"}},
    });
    expect(deps.credentials.resolveCredential).not.toHaveBeenCalled();
    expect(deps.runner.listTools).not.toHaveBeenCalled();
  });

  it("fails closed without a partial command result over the normalized 8 MiB cap", async () => {
    const deps = dependencies({
      runner: {
        listTools: vi.fn(async () => ({
          value: {tools: [{name: "huge", description: "x".repeat(8 * 1024 * 1024)}]},
          diagnostics: {transport: "stdio" as const, stderr: "", stderrTruncated: false},
        })),
        callTool: vi.fn(),
      },
    });
    const result = await new RuntimeCommandDispatcher({commands: [createMcpToolsCommand(deps)]}).execute(
      request("mcp.tools", {server: "fixture"}),
    );
    expect(result).toMatchObject({ok: false, error: {details: {exitCode: 3, kind: "output_limit"}}});
    expect(result).not.toHaveProperty("output");
  });

  it("rejects timeout overrides outside the 1s-120s contract", async () => {
    const deps = dependencies();
    const dispatcher = new RuntimeCommandDispatcher({commands: [createMcpToolsCommand(deps)]});
    await expect(dispatcher.execute(request("mcp.tools", {server: "fixture", timeoutMs: 999}))).resolves.toMatchObject({
      ok: false,
      error: {details: {exitCode: 2, kind: "config_input"}},
    });
    await expect(dispatcher.execute(request("mcp.tools", {server: "fixture", timeoutMs: 120_001}))).resolves.toMatchObject({ok: false});
    expect(deps.runner.listTools).not.toHaveBeenCalled();
  });
});
