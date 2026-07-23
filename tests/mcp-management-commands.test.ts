import {describe, expect, it, vi} from "vitest";

import {RuntimeCommandDispatcher} from "../src/app/runtime/command-dispatcher.js";
import {
  createMcpOauthStartCommand,
  createMcpServerAddCommand,
  createMcpServerDeleteCommand,
  createMcpServerDisableCommand,
  createMcpServerEnableCommand,
  createMcpServerListCommand,
  createMcpServerShowCommand,
  createMcpServerTestCommand,
  createMcpServerUpdateCommand,
} from "../src/domain/mcp/management-commands.js";
import {McpManagementService, type McpOAuthManager} from "../src/domain/mcp/management-service.js";
import {InMemoryMcpConfigStore} from "../src/domain/mcp/store.js";

const commandNames = [
  "mcp.server.list", "mcp.server.show", "mcp.server.add", "mcp.server.update",
  "mcp.server.enable", "mcp.server.disable", "mcp.server.delete", "mcp.server.test",
  "mcp.oauth.start",
] as const;

function harness(input: {oauth?: McpOAuthManager} = {}) {
  const configs = new InMemoryMcpConfigStore();
  const credentials = {resolveCredential: vi.fn(async (envKey: string) => ({envKey, value: "resolved-secret"}))};
  const runner = {
    listTools: vi.fn(async () => ({
      value: {tools: [{name: "echo", inputSchema: {type: "object"}}]},
      diagnostics: {transport: "stdio" as const, stderr: "", stderrTruncated: false},
    })),
    callTool: vi.fn(async () => { throw new Error("test must never call a tool"); }),
  };
  const audit = {recordAudit: vi.fn(async () => {})};
  const service = new McpManagementService({configs, credentials, runner, oauth: input.oauth, audit});
  const commands = [
    createMcpServerListCommand(service), createMcpServerShowCommand(service),
    createMcpServerAddCommand(service), createMcpServerUpdateCommand(service),
    createMcpServerEnableCommand(service), createMcpServerDisableCommand(service),
    createMcpServerDeleteCommand(service), createMcpServerTestCommand(service),
    createMcpOauthStartCommand(service),
  ];
  const dispatcher = new RuntimeCommandDispatcher({commands});
  const execute = (command: typeof commandNames[number], body: Record<string, unknown>, scope: Record<string, unknown> = {}) => dispatcher.execute({
    command,
    input: body,
    scope: {
      agentKey: "panda",
      sessionId: "session-panda",
      threadId: "thread-panda",
      identityId: "identity-patrik",
      allowedCommands: [...commandNames],
      credentialPolicy: {mode: "all_agent" as const},
      ...scope,
    },
  });
  return {configs, credentials, runner, audit, execute};
}

const disabledStdio = {
  transport: "stdio",
  enabled: false,
  command: "node",
  args: ["fixture.mjs"],
  env: {TOKEN: {credentialEnvKey: "TOKEN"}},
  timeoutMs: 30_000,
};

describe("agent MCP management commands", () => {
  it("runs the versioned own-agent lifecycle and tests disabled servers without invoking a tool", async () => {
    const {execute, runner, audit} = harness();
    await expect(execute("mcp.server.add", {server: "fixture", config: disabledStdio, expectedVersion: 0})).resolves.toMatchObject({
      ok: true,
      output: {version: 1, server: {serverName: "fixture", enabled: false, status: "disabled"}},
    });
    await expect(execute("mcp.server.list", {})).resolves.toMatchObject({ok: true, output: {count: 1, version: 1}});
    await expect(execute("mcp.server.test", {server: "fixture"})).resolves.toMatchObject({ok: true, output: {toolCount: 1, tools: [{name: "echo"}]}});
    expect(runner.listTools).toHaveBeenCalledWith(expect.objectContaining({config: expect.objectContaining({enabled: false})}));
    expect(runner.callTool).not.toHaveBeenCalled();

    await expect(execute("mcp.server.enable", {server: "fixture", expectedVersion: 1})).resolves.toMatchObject({ok: true, output: {version: 2, server: {enabled: true}}});
    await expect(execute("mcp.server.enable", {server: "fixture", expectedVersion: 2})).resolves.toMatchObject({ok: true, output: {version: 2}});
    await expect(execute("mcp.server.update", {server: "fixture", config: disabledStdio, expectedVersion: 1})).resolves.toMatchObject({
      ok: false,
      error: {code: "conflict", details: {failureCode: "stale_version", currentVersion: 2, requiresRefresh: true}},
    });
    await expect(execute("mcp.server.disable", {server: "fixture", expectedVersion: 2})).resolves.toMatchObject({ok: true, output: {version: 3}});
    await expect(execute("mcp.server.delete", {server: "fixture", expectedVersion: 3})).resolves.toMatchObject({ok: true, output: {deleted: true, version: 4}});
    await expect(execute("mcp.server.delete", {server: "fixture", expectedVersion: 4})).resolves.toMatchObject({ok: true, output: {deleted: false, version: 4}});
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "agent_mcp_operation",
      identityId: "identity-patrik",
      metadata: expect.objectContaining({actorKind: "agent", agentKey: "panda", runtimeSessionId: "session-panda", threadId: "thread-panda"}),
    }));
    const auditText = JSON.stringify(audit.recordAudit.mock.calls);
    expect(auditText).toContain("stale_version");
    expect(auditText).not.toContain("fixture.mjs");
  });

  it("rejects forged scope fields and raw credential values before a registry write", async () => {
    const {configs, execute} = harness();
    await expect(execute("mcp.server.add", {agentKey: "luna", server: "fixture", config: disabledStdio, expectedVersion: 0})).resolves.toMatchObject({
      ok: false,
      error: {code: "invalid_input"},
    });
    await expect(configs.getAgentConfig("panda")).resolves.toMatchObject({version: 0});
    await expect(configs.getAgentConfig("luna")).resolves.toMatchObject({version: 0});

    await expect(execute("mcp.server.add", {server: "fixture", expectedVersion: 0, config: {
      ...disabledStdio,
      env: {TOKEN: {value: "literal-secret"}},
    }})).resolves.toMatchObject({ok: false, error: {code: "invalid_input"}});
    await expect(configs.getAgentConfig("panda")).resolves.toMatchObject({version: 0});
  });

  it("redacts Control-compatible stored literals from agent DTOs", async () => {
    const {configs, execute} = harness();
    await configs.putServer("panda", "legacy", {
      transport: "stdio",
      enabled: true,
      command: "node",
      args: [],
      env: {TOKEN: {value: "stored-literal-secret"}},
      timeoutMs: 30_000,
    });
    const result = await execute("mcp.server.show", {server: "legacy"});
    expect(result).toMatchObject({
      ok: true,
      output: {server: {env: {TOKEN: {literal: true, redacted: true}}}},
    });
    expect(JSON.stringify(result)).not.toContain("stored-literal-secret");
  });

  it("checks credential policy before decrypt or network during test", async () => {
    const {configs, credentials, execute, runner} = harness();
    await configs.putServer("panda", "fixture", {...disabledStdio, enabled: true});
    await expect(execute("mcp.server.test", {server: "fixture"}, {credentialPolicy: {mode: "none"}})).resolves.toMatchObject({
      ok: false,
      error: {code: "forbidden", details: {failureCode: "credential_policy_denied"}},
    });
    expect(credentials.resolveCredential).not.toHaveBeenCalled();
    expect(runner.listTools).not.toHaveBeenCalled();
  });

  it("starts manual OAuth with a credential ref and preserves the agent initiator", async () => {
    const start = vi.fn(async () => ({authorizationUrl: "https://login.example/authorize", expiresAt: 2_000}));
    const oauth: McpOAuthManager = {
      status: async () => ({status: "authorization_required"}),
      discover: async () => { throw new Error("not used"); },
      start,
      finish: async () => { throw new Error("not used"); },
      fail: async () => { throw new Error("not used"); },
      disconnect: async () => ({disconnected: true, remoteRevocation: "unsupported"}),
      deleteConnection: async () => true,
      invalidate: async () => {},
    };
    const {configs, credentials, execute} = harness({oauth});
    await configs.putServer("panda", "analytics", {
      transport: "streamable-http", enabled: true, url: "https://mcp.example/mcp", timeoutMs: 30_000,
      auth: {type: "oauth", registration: {mode: "manual"}, scope: {mode: "explicit", values: ["read"]}},
    });
    const result = await execute("mcp.oauth.start", {server: "analytics", manualClient: {
      clientId: "client-id",
      tokenEndpointAuthMethod: "client_secret_basic",
      clientSecretCredentialEnvKey: "OAUTH_CLIENT_SECRET",
    }});
    expect(result).toMatchObject({ok: true, output: {authorizationUrl: "https://login.example/authorize"}});
    expect(credentials.resolveCredential).toHaveBeenCalledWith("OAUTH_CLIENT_SECRET", {agentKey: "panda"});
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      agentKey: "panda",
      serverName: "analytics",
      initiator: {kind: "agent", agentKey: "panda", sessionId: "session-panda", identityId: "identity-patrik", threadId: "thread-panda"},
      manualClient: {clientId: "client-id", clientSecret: "resolved-secret", tokenEndpointAuthMethod: "client_secret_basic"},
    }));
    await expect(execute("mcp.oauth.start", {server: "analytics", manualClient: {
      clientId: "client-id",
      tokenEndpointAuthMethod: "client_secret_basic",
      clientSecret: "raw-secret",
    }})).resolves.toMatchObject({ok: false, error: {code: "invalid_input"}});
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("returns authorization_required before testing an OAuth server without a grant", async () => {
    const oauth: McpOAuthManager = {
      status: async () => ({status: "authorization_required"}),
      discover: async () => { throw new Error("not used"); },
      start: async () => { throw new Error("not used"); },
      finish: async () => { throw new Error("not used"); },
      fail: async () => { throw new Error("not used"); },
      disconnect: async () => ({disconnected: false, remoteRevocation: "unsupported"}),
      deleteConnection: async () => false,
      invalidate: async () => {},
    };
    const {configs, execute, runner} = harness({oauth});
    await configs.putServer("panda", "analytics", {
      transport: "streamable-http", enabled: true, url: "https://mcp.example/mcp", timeoutMs: 30_000,
      auth: {type: "oauth", registration: {mode: "dynamic"}, scope: {mode: "explicit", values: ["read"]}},
    });
    await expect(execute("mcp.server.test", {server: "analytics"})).resolves.toMatchObject({
      ok: false,
      error: {code: "command_failed", details: {failureCode: "authorization_required"}},
    });
    expect(runner.listTools).not.toHaveBeenCalled();
  });
});
