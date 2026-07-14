import {spawn, type ChildProcess} from "node:child_process";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {afterEach, describe, expect, it} from "vitest";

import {SdkMcpRunner} from "../src/integrations/mcp/client.js";
import {
  McpRedactionCollisionError,
  redactExactJson,
  redactExactString,
  StreamingSecretRedactor,
} from "../src/integrations/mcp/redaction.js";
import type {McpResolvedInvocation, McpResolvedServerConfig} from "../src/domain/mcp/types.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = path.join(root, "examples/mcp/fixture-server.mjs");
const secret = "fixture-raw-secret-value";
const children: ChildProcess[] = [];

function invocation(config: McpResolvedServerConfig): McpResolvedInvocation {
  return {config, knownSecrets: [secret]};
}

async function startHttpFixture(mode = "normal"): Promise<{base: string; mcp: string; sse: string}> {
  const child = spawn(process.execPath, [fixturePath, "--transport", "http", "--port", "0", "--mode", mode], {
    cwd: root,
    env: {...process.env, FIXTURE_SECRET: secret},
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const ready = await new Promise<{port: number; mcp: string; sse: string}>((resolve, reject) => {
    let pending = "";
    const timer = setTimeout(() => reject(new Error("fixture start timeout")), 5_000);
    child.once("error", reject);
    child.stdout!.on("data", (chunk) => {
      pending += chunk.toString("utf8");
      const line = pending.split("\n").find((entry) => entry.startsWith("READY "));
      if (!line) return;
      clearTimeout(timer);
      resolve(JSON.parse(line.slice("READY ".length)));
    });
  });
  return {...ready, base: `http://127.0.0.1:${ready.port}`};
}

afterEach(async () => {
  await Promise.all(children.splice(0).map(async (child) => {
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 1_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }));
});

describe("MCP exact raw secret redaction", () => {
  it("uses longest-first exact matching for overlapping values and regex characters", () => {
    expect(redactExactString("token=a+b; short=a", ["a", "a+b"])).toBe("token=[redacted]; short=[redacted]");
    expect(redactExactString("encoded=YSs=", ["a+b"])).toBe("encoded=YSs=");
  });

  it("redacts object keys and fails closed on redaction-induced duplicate keys", () => {
    expect(redactExactJson({[secret]: {value: secret}}, [secret])).toEqual({
      "[redacted]": {value: "[redacted]"},
    });
    expect(() => redactExactJson({[secret]: "one", "[redacted]": "two"}, [secret]))
      .toThrow(McpRedactionCollisionError);
  });

  it("holds a raw suffix so a secret split across stderr chunks is redacted", () => {
    let output = "";
    const redactor = new StreamingSecretRedactor(["split-secret"], (value) => { output += value });
    redactor.append(Buffer.from("before split-se"));
    redactor.append(Buffer.from("cret after"));
    redactor.finish();
    expect(output).toBe("before [redacted] after");
  });
});

describe("MCP SDK runner", () => {
  it("uses a bounded stdio adapter, exhausts pagination, preserves annotations, and redacts nested/stderr secrets", async () => {
    const runner = new SdkMcpRunner();
    const config = {
      transport: "stdio" as const,
      enabled: true,
      command: process.execPath,
      args: [fixturePath, "--transport", "stdio"],
      env: {FIXTURE_SECRET: secret},
      timeoutMs: 5_000,
    };
    const tools = await runner.listTools(invocation(config));
    expect(tools.value).toMatchObject({
      tools: [
        {name: "echo", annotations: {destructiveHint: false}},
        {name: "destructive_fixture", annotations: {destructiveHint: true}},
      ],
    });
    expect(tools.value).not.toHaveProperty("nextCursor");

    const called = await runner.callTool(invocation(config), {name: "secret_echo", arguments: {}});
    const serialized = JSON.stringify(called);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain("[redacted]");
    expect(called).toMatchObject({
      value: {
        structuredContent: {nested: {value: "[redacted]"}},
        _meta: {fixtureSecretEcho: "[redacted]"},
      },
      diagnostics: {transport: "stdio", stderr: "stderr:[redacted]\n"},
    });
    expect(called.value.content?.[0]).toMatchObject({type: "text", text: "[redacted]"});
  });

  it("redacts secret keys throughout full runner envelopes and server metadata", async () => {
    const config = {
      transport: "stdio" as const,
      enabled: true,
      command: process.execPath,
      args: [fixturePath, "--transport", "stdio", "--mode", "secret-keys"],
      env: {FIXTURE_SECRET: secret},
      timeoutMs: 5_000,
    };
    const runner = new SdkMcpRunner();
    const tools = await runner.listTools(invocation(config));
    const called = await runner.callTool(invocation(config), {name: "secret_echo", arguments: {}});
    for (const envelope of [tools, called]) {
      const serialized = JSON.stringify(envelope);
      expect(serialized).not.toContain(secret);
      expect(serialized).toContain('"[redacted]"');
    }
    expect(called.value).toMatchObject({
      structuredContent: {"[redacted]": "structured-key"},
      _meta: {"[redacted]": "result-metadata"},
    });
    expect(tools.serverCapabilities).toMatchObject({
      experimental: {"[redacted]": {source: "server-metadata"}},
    });
  });

  it("fails closed when redacted result keys collide", async () => {
    const caught = new SdkMcpRunner().callTool(invocation({
      transport: "stdio",
      enabled: true,
      command: process.execPath,
      args: [fixturePath, "--transport", "stdio", "--mode", "secret-key-collision"],
      env: {FIXTURE_SECRET: secret},
      timeoutMs: 5_000,
    }), {name: "secret_echo", arguments: {}});
    await expect(caught).rejects.toMatchObject({exitCode: 3, phase: "invalid_content"});
    await expect(caught).rejects.not.toHaveProperty("message", expect.stringContaining(secret));
  });

  it("propagates streamable HTTP credentials/session/protocol headers and terminates the session", async () => {
    const fixture = await startHttpFixture();
    const runner = new SdkMcpRunner();
    const config = {
      transport: "streamable-http" as const,
      enabled: true,
      url: fixture.mcp,
      headers: {Authorization: `Bearer ${secret}`, "X-API-Key": secret},
      timeoutMs: 5_000,
    };
    await expect(runner.listTools(invocation(config))).resolves.toMatchObject({
      value: {tools: [{name: "echo"}, {name: "destructive_fixture"}]},
      diagnostics: {transport: "streamable-http"},
    });
    const events = await fetch(`${fixture.base}/events`).then((response) => response.json()) as {events: Array<Record<string, unknown>>};
    expect(events.events[0]).toMatchObject({method: "POST", session: false, protocol: false, authorization: true, apiKey: true});
    expect(events.events.some((event) => event.method === "POST" && event.session === true && event.protocol === true)).toBe(true);
    expect(events.events.at(-1)).toMatchObject({method: "DELETE", session: true, protocol: true});
    expect(JSON.stringify(events)).not.toContain(secret);
  });

  it("uses explicit legacy SSE without transport fallback and closes its stream", async () => {
    const fixture = await startHttpFixture();
    const result = await new SdkMcpRunner().callTool(invocation({
      transport: "sse",
      enabled: true,
      url: fixture.sse,
      headers: {Authorization: `Bearer ${secret}`},
      timeoutMs: 5_000,
    }), {name: "echo", arguments: {message: "legacy-ok"}});
    expect(result).toMatchObject({diagnostics: {transport: "sse"}});
    expect(result.value.content?.[0]).toMatchObject({type: "text", text: "legacy-ok"});
    const events = await fetch(`${fixture.base}/events`).then((response) => response.json()) as {events: Array<Record<string, unknown>>};
    expect(events.events[0]).toMatchObject({method: "GET", path: "/sse", authorization: true});
    expect(events.events.some((event) => event.method === "POST" && event.path === "/messages")).toBe(true);
    expect(events.events.some((event) => event.path === "/mcp")).toBe(false);
  });

  it.each([
    ["redirect", "/redirect", "http_status", 302],
    ["remote error", "/error", "http_status", 500],
    ["authentication", "/auth", "authentication", 401],
    ["invalid content type", "/invalid-content", "invalid_content", undefined],
    ["invalid JSON", "/invalid-json", "invalid_content", undefined],
    ["oversized body", "/oversize", "output_limit", undefined],
  ])("fails closed on %s with a distinct sanitized phase", async (_label, pathname, phase, status) => {
    const fixture = await startHttpFixture();
    let caught: unknown;
    try {
      await new SdkMcpRunner().listTools(invocation({
        transport: "streamable-http",
        enabled: true,
        url: `${fixture.base}${pathname}`,
        headers: {Authorization: `Bearer ${secret}`},
        timeoutMs: 2_000,
      }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({exitCode: 3, phase, ...(status ? {httpStatus: status} : {})});
    expect(JSON.stringify(caught)).not.toContain(secret);
    expect((caught as Error).message).not.toContain("remote body");
  });

  it("distinguishes connect, session-expiry, and protocol failures", async () => {
    await expect(new SdkMcpRunner().listTools(invocation({
      transport: "streamable-http",
      enabled: true,
      url: "http://127.0.0.1:1/mcp",
      timeoutMs: 2_000,
    }))).rejects.toMatchObject({exitCode: 3, phase: "connect"});

    const expired = await startHttpFixture("session-expired");
    await expect(new SdkMcpRunner().listTools(invocation({
      transport: "streamable-http",
      enabled: true,
      url: expired.mcp,
      timeoutMs: 2_000,
    }))).rejects.toMatchObject({exitCode: 3, phase: "session_expired", httpStatus: 404});

    await expect(new SdkMcpRunner().callTool(invocation({
      transport: "stdio",
      enabled: true,
      command: process.execPath,
      args: [fixturePath, "--transport", "stdio"],
      timeoutMs: 2_000,
    }), {name: "protocol_error", arguments: {}})).rejects.toMatchObject({exitCode: 3, phase: "protocol"});
  });

  it("enforces one absolute deadline and aborts a delayed call", async () => {
    const fixture = await startHttpFixture();
    const startedAt = Date.now();
    await expect(new SdkMcpRunner().callTool(invocation({
      transport: "streamable-http",
      enabled: true,
      url: fixture.mcp,
      timeoutMs: 50,
    }), {name: "delay", arguments: {delayMs: 2_000}})).rejects.toMatchObject({exitCode: 124, phase: "timeout"});
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("caps stdio stderr at 64 KiB and marks truncation", async () => {
    const result = await new SdkMcpRunner().callTool(invocation({
      transport: "stdio",
      enabled: true,
      command: process.execPath,
      args: [fixturePath, "--transport", "stdio", "--mode", "stderr-flood"],
      timeoutMs: 2_000,
    }), {name: "echo", arguments: {}});
    expect(result.diagnostics).toMatchObject({stderrTruncated: true});
    expect(Buffer.byteLength(result.diagnostics.stderr ?? "", "utf8")).toBeLessThanOrEqual(64 * 1024);
  });

  it("kills stdio before parsing a JSON-RPC line over 8 MiB", async () => {
    await expect(new SdkMcpRunner().listTools(invocation({
      transport: "stdio",
      enabled: true,
      command: process.execPath,
      args: [fixturePath, "--transport", "stdio", "--mode", "oversize-line"],
      timeoutMs: 2_000,
    }))).rejects.toMatchObject({exitCode: 3, phase: "output_limit"});
  });

  it("detects pagination cursor cycles without returning a partial tool list", async () => {
    await expect(new SdkMcpRunner().listTools(invocation({
      transport: "stdio",
      enabled: true,
      command: process.execPath,
      args: [fixturePath, "--transport", "stdio", "--mode", "cursor-cycle"],
      timeoutMs: 2_000,
    }))).rejects.toMatchObject({exitCode: 3, phase: "protocol"});
  });

  it("rejects aggregate paginated tools at 8 MiB before retaining another page", async () => {
    await expect(new SdkMcpRunner().listTools(invocation({
      transport: "stdio",
      enabled: true,
      command: process.execPath,
      args: [fixturePath, "--transport", "stdio", "--mode", "aggregate-oversize"],
      timeoutMs: 5_000,
    }))).rejects.toMatchObject({exitCode: 3, phase: "output_limit"});
  });
});
