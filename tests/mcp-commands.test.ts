import {execFile} from "node:child_process";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {promisify} from "node:util";

import {afterEach, describe, expect, it} from "vitest";

import {RuntimeCommandDispatcher} from "../src/app/runtime/command-dispatcher.js";
import {resolveCommandLeaseAuthority} from "../src/domain/execution-environments/command-authority.js";
import {
  createMcpCallCommand,
  createMcpToolsCommand,
  MCP_CALL_COMMAND_NAME,
  MCP_TOOLS_COMMAND_NAME,
} from "../src/domain/mcp/commands.js";
import {DEFAULT_AGENT_COMMAND_CATALOG} from "../src/panda/commands/agent-command-modules.js";
import {
  startCommandHttpServer,
  type CommandHttpServer,
} from "../src/integrations/commands/http-server.js";
import {createTestCommandLeaseVerifier} from "./helpers/command-lease-verifier.js";

const execFileAsync = promisify(execFile);
const shimPath = path.resolve("scripts/agent-command-shim/panda");

const fakeServerSource = String.raw`
const tools = [
  {
    name: "echo",
    description: "Echo input.",
    inputSchema: {type: "object", properties: {message: {type: "string"}}},
  },
  {
    name: "destructive_write",
    description: "Intentionally destructive write tool.",
    inputSchema: {type: "object", properties: {path: {type: "string"}}},
    annotations: {destructiveHint: true, readOnlyHint: false, idempotentHint: false, openWorldHint: true},
  },
  {
    name: "rich_result",
    description: "Return structured and non-text content.",
    inputSchema: {type: "object", properties: {}},
    outputSchema: {type: "object", properties: {ok: {type: "boolean"}}},
  },
  {
    name: "returns_is_error",
    description: "Return an MCP tool-level error envelope.",
    inputSchema: {type: "object", properties: {}},
  },
  {
    name: "draft07_output",
    description: "Declare a Draft-07 output schema.",
    inputSchema: {type: "object", properties: {}},
    outputSchema: {$schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: {ok: {type: "boolean"}}},
  },
];

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) void handle(JSON.parse(line));
  }
});

function send(id, result) {
  process.stdout.write(JSON.stringify({jsonrpc: "2.0", id, result}) + "\n");
}

function sendError(id, code, message) {
  process.stdout.write(JSON.stringify({jsonrpc: "2.0", id, error: {code, message}}) + "\n");
}

async function handle(message) {
  if (message.method === "initialize") {
    send(message.id, {
      protocolVersion: "2025-06-18",
      capabilities: {tools: {}},
      serverInfo: {name: "fake-mcp", version: "1.0.0"},
    });
    return;
  }
  if (message.method === "notifications/initialized") {
    return;
  }
  if (message.method === "tools/list") {
    send(message.id, {tools});
    return;
  }
  if (message.method === "tools/call") {
    const name = message.params?.name;
    if (name === "echo") {
      send(message.id, {content: [{type: "text", text: String(message.params?.arguments?.message ?? "")}], structuredContent: {echoed: message.params?.arguments ?? {}}});
      return;
    }
    if (name === "rich_result") {
      process.stderr.write("fake stderr from rich_result\n");
      send(message.id, {
        content: [
          {type: "text", text: "hello"},
          {type: "image", data: "aW1hZ2U=", mimeType: "image/png"},
        ],
        structuredContent: {ok: true, nested: {value: 42}},
        _meta: {traceId: "fake-trace"},
      });
      return;
    }
    if (name === "returns_is_error") {
      process.stderr.write("fake stderr from isError\n");
      send(message.id, {content: [{type: "text", text: "tool failed"}], isError: true, _meta: {reason: "expected"}});
      return;
    }
    if (name === "draft07_output") {
      send(message.id, {content: [{type: "text", text: "draft ok"}], structuredContent: {ok: true}});
      return;
    }
    sendError(message.id, -32602, "unknown tool");
    return;
  }
  if (message.id !== undefined) sendError(message.id, -32601, "method not found");
}
`;

describe("generic MCP commands", () => {
  const directories: string[] = [];
  const servers: CommandHttpServer[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      await servers.pop()?.close();
    }
    while (directories.length > 0) {
      await rm(directories.pop()!, {recursive: true, force: true});
    }
  });

  async function writeFakeMcpConfig(): Promise<{env: NodeJS.ProcessEnv; configPath: string}> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "panda-mcp-test-"));
    directories.push(dir);
    const serverPath = path.join(dir, "fake-mcp-server.mjs");
    const configPath = path.join(dir, "mcp.json");
    await writeFile(serverPath, fakeServerSource, "utf8");
    await writeFile(configPath, JSON.stringify({
      servers: {
        fake: {
          transport: "stdio",
          command: process.execPath,
          args: [serverPath],
          timeoutMs: 5_000,
        },
      },
    }), "utf8");

    return {
      configPath,
      env: {
        ...process.env,
        PANDA_MCP_CONFIG: configPath,
      },
    };
  }

  function request(command: "mcp.tools" | "mcp.call", input: Record<string, unknown>) {
    return {
      command,
      input,
      scope: {
        agentKey: "panda",
        sessionId: "session-main",
      },
    };
  }

  it("gates MCP behind a dedicated mcp capability and only registers static MCP commands", () => {
    const mcpNames = DEFAULT_AGENT_COMMAND_CATALOG.names().filter((name) => name.startsWith("mcp."));
    expect(mcpNames).toEqual([MCP_TOOLS_COMMAND_NAME, MCP_CALL_COMMAND_NAME]);
    expect(DEFAULT_AGENT_COMMAND_CATALOG.namesForToolGroups(["mcp"])).toEqual(["mcp.*"]);

    expect(resolveCommandLeaseAuthority({
      commandCatalog: DEFAULT_AGENT_COMMAND_CATALOG,
      toolPolicy: {allowedTools: []},
    }).filter((name) => name.startsWith("mcp."))).toEqual([]);
    expect(resolveCommandLeaseAuthority({
      commandCatalog: DEFAULT_AGENT_COMMAND_CATALOG,
      toolPolicy: {allowedTools: ["mcp.*"]},
    }).filter((name) => name.startsWith("mcp."))).toEqual([MCP_TOOLS_COMMAND_NAME, MCP_CALL_COMMAND_NAME]);
  });

  it("does not show or execute MCP commands without a command allowlist grant", async () => {
    const {env} = await writeFakeMcpConfig();
    const dispatcher = new RuntimeCommandDispatcher({
      commands: [createMcpToolsCommand({env}), createMcpCallCommand({env})],
    });

    await expect(dispatcher.listCommands({
      agentKey: "panda",
      sessionId: "session-main",
      allowedCommands: [],
    })).resolves.toEqual([]);
    await expect(dispatcher.listCommands({
      agentKey: "panda",
      sessionId: "session-main",
      allowedCommands: [MCP_TOOLS_COMMAND_NAME, MCP_CALL_COMMAND_NAME],
    })).resolves.toMatchObject([
      {name: MCP_TOOLS_COMMAND_NAME},
      {name: MCP_CALL_COMMAND_NAME},
    ]);

    await expect(dispatcher.execute(request(MCP_TOOLS_COMMAND_NAME, {server: "fake"}))).resolves.toMatchObject({
      ok: false,
      error: {code: "forbidden"},
    });
  });

  it("lists every fake MCP tool including destructive/write annotations", async () => {
    const {env, configPath} = await writeFakeMcpConfig();
    const result = await createMcpToolsCommand({env}).execute(request(MCP_TOOLS_COMMAND_NAME, {server: "fake"}));

    expect(result.output.server).toBe("fake");
    expect(result.output.diagnostics).toMatchObject({configSource: configPath, stderr: ""});
    expect(result.output.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({name: "echo"}),
      expect.objectContaining({
        name: "destructive_write",
        annotations: expect.objectContaining({destructiveHint: true, readOnlyHint: false}),
      }),
      expect.objectContaining({name: "draft07_output"}),
    ]));
    expect(result.output.compatibilityWarnings).toEqual([
      expect.objectContaining({
        code: "mcp_output_schema_dialect_not_validated",
        tool: "draft07_output",
      }),
    ]);
  });

  it("preserves MCP call envelopes, non-text content, structuredContent, _meta, isError, and stderr", async () => {
    const {env} = await writeFakeMcpConfig();
    const command = createMcpCallCommand({env});

    const rich = await command.execute(request(MCP_CALL_COMMAND_NAME, {
      server: "fake",
      tool: "rich_result",
      input: {},
    }));
    expect(rich.output).toMatchObject({
      server: "fake",
      tool: "rich_result",
      structuredContent: {ok: true, nested: {value: 42}},
      _meta: {traceId: "fake-trace"},
      diagnostics: {stderr: expect.stringContaining("fake stderr from rich_result")},
      exitCode: 0,
    });
    expect(rich.output.content).toEqual([
      {type: "text", text: "hello"},
      {type: "image", data: "aW1hZ2U=", mimeType: "image/png"},
    ]);

    const isError = await command.execute(request(MCP_CALL_COMMAND_NAME, {
      server: "fake",
      tool: "returns_is_error",
      input: {},
    }));
    expect(isError.output).toMatchObject({
      isError: true,
      exitCode: 4,
      _meta: {reason: "expected"},
      diagnostics: {stderr: expect.stringContaining("fake stderr from isError")},
    });

    const draft07 = await command.execute(request(MCP_CALL_COMMAND_NAME, {
      server: "fake",
      tool: "draft07_output",
      input: {},
    }));
    expect(draft07.output).toMatchObject({
      structuredContent: {ok: true},
      exitCode: 0,
    });
  });

  it("maps shim MCP isError envelopes to exit code 4 while printing the envelope", async () => {
    const {env} = await writeFakeMcpConfig();
    const server = await startCommandHttpServer({
      executor: new RuntimeCommandDispatcher({
        commands: [createMcpToolsCommand({env}), createMcpCallCommand({env})],
      }),
      leaseVerifier: createTestCommandLeaseVerifier([
        ["token-a", {
          agentKey: "panda",
          sessionId: "session-main",
          allowedCommands: [MCP_TOOLS_COMMAND_NAME, MCP_CALL_COMMAND_NAME],
        }],
      ]),
    });
    servers.push(server);

    await expect(execFileAsync(shimPath, [
      "mcp",
      "call",
      "fake",
      "returns_is_error",
      "--input",
      "{}",
    ], {
      env: {
        ...env,
        PANDA_COMMAND_ACCESS_FILE: "",
        PANDA_COMMAND_URL: server.url,
        PANDA_COMMAND_SOCKET: "",
        PANDA_COMMAND_TOKEN: "token-a",
      },
    })).rejects.toMatchObject({
      code: 4,
      stdout: expect.stringContaining('"isError":true'),
    });
  });

  it("maps shim MCP local input errors to exit code 2", async () => {
    await expect(execFileAsync(shimPath, [
      "mcp",
      "call",
      "fake",
      "returns_is_error",
    ])).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("requires --input"),
    });
  });
});
