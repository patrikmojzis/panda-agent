import {spawn, type ChildProcess} from "node:child_process";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";

import {PostgresAgentStore} from "../src/domain/agents/postgres.js";
import {CredentialCrypto} from "../src/domain/credentials/crypto.js";
import {PostgresMcpOAuthStore} from "../src/domain/mcp/oauth-postgres.js";
import {McpOAuthService} from "../src/domain/mcp/oauth-service.js";
import type {McpHttpOAuthAuth} from "../src/domain/mcp/types.js";
import {SdkMcpRunner} from "../src/integrations/mcp/client.js";
import {
  finishMcpOAuthAuthorization,
  McpOAuthProviderSession,
  McpOAuthRuntime,
  startMcpOAuthAuthorization,
} from "../src/integrations/mcp/oauth.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const processes: ChildProcess[] = [];
const pools: Array<{end(): Promise<void>}> = [];

afterEach(async () => {
  for (const child of processes.splice(0)) child.kill("SIGTERM");
  while (pools.length > 0) await pools.pop()?.end();
});

async function startFixture(): Promise<string> {
  const child = spawn(process.execPath, [path.join(root, "examples/mcp/fixture-server.mjs"), "--transport", "http", "--port", "0", "--mode", "oauth"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  processes.push(child);
  return new Promise((resolve, reject) => {
    let output = "";
    child.stdout!.on("data", (chunk) => {
      output += chunk.toString("utf8");
      const line = output.split("\n").find((entry) => entry.startsWith("READY "));
      if (!line) return;
      const ready = JSON.parse(line.slice("READY ".length)) as {mcp: string};
      resolve(ready.mcp);
    });
    child.once("exit", (code) => reject(new Error(`OAuth MCP fixture exited before readiness with ${code}.`)));
  });
}

async function serviceHarness(): Promise<McpOAuthService> {
  const db = newDb({noAstCoverageCheck: true});
  db.public.registerFunction({name: "pg_notify", args: [DataType.text, DataType.text], returns: DataType.text, implementation: () => ""});
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  pools.push(pool);
  const agents = new PostgresAgentStore({pool});
  const store = new PostgresMcpOAuthStore(pool);
  await agents.ensureAgentTableSchema();
  await store.ensureSchema();
  await agents.bootstrapAgent({agentKey: "panda", displayName: "Panda"});
  return new McpOAuthService({store, crypto: new CredentialCrypto("oauth-flow-test-master-key")});
}

describe("MCP OAuth lifecycle", () => {
  it("runs DCR, PKCE, tools, rotating refresh, and revoke through the public runtime", async () => {
    const serverUrl = await startFixture();
    const service = await serviceHarness();
    const redirectUrl = "http://127.0.0.1:4767/api/control/mcp/oauth/callback";
    const authConfig: McpHttpOAuthAuth = {
      type: "oauth",
      registration: {mode: "dynamic"},
      scope: {mode: "explicit", values: ["resource:read"]},
    };
    const rawState = "opaque-test-state";
    const started = await startMcpOAuthAuthorization({
      service,
      agentKey: "panda",
      serverName: "fixture",
      serverUrl,
      authConfig,
      redirectUrl,
      rawState,
      initiator: {kind: "control", identityId: "identity-test", sessionId: "session-test"},
    });
    const authorization = await fetch(started.authorizationUrl, {redirect: "manual"});
    const callback = new URL(authorization.headers.get("location")!);
    expect(callback.searchParams.get("state")).toBe(rawState);
    const attempt = await service.consumeAttempt(rawState);
    await finishMcpOAuthAuthorization({
      service,
      agentKey: "panda",
      serverName: "fixture",
      serverUrl,
      authConfig,
      redirectUrl,
      authorizationCode: callback.searchParams.get("code")!,
      codeVerifier: attempt!.codeVerifier,
    });

    const runtime = new McpOAuthRuntime({service, redirectUrl});
    const runner = new SdkMcpRunner({oauth: runtime});
    const invocation = {
      config: {transport: "streamable-http" as const, enabled: true, url: serverUrl, timeoutMs: 5_000, oauth: {agentKey: "panda", serverName: "fixture", auth: authConfig}},
      knownSecrets: [],
    };
    const tools = await runner.listTools(invocation);
    expect((tools.value.tools as Array<{name: string}>).map((tool) => tool.name)).toContain("echo");
    await fetch(new URL("/oauth/expire", serverUrl), {method: "POST"});
    const refreshed = await runner.callTool(invocation, {name: "echo", arguments: {message: "after-refresh"}});
    expect(refreshed.value.content).toEqual(expect.arrayContaining([expect.objectContaining({type: "text", text: "after-refresh"})]));

    const events = await (await fetch(new URL("/oauth/events", serverUrl))).json() as {events: Array<{type: string; rotated?: boolean}>};
    expect(events.events).toEqual(expect.arrayContaining([{type: "register"}, {type: "exchange", rotated: false}, {type: "refresh", rotated: true}]));
    const session = await McpOAuthProviderSession.create({service, agentKey: "panda", serverName: "fixture", serverUrl, authConfig, redirectUrl});
    await expect(session.revokeAndDisconnect()).resolves.toBe("succeeded");
    await expect(service.getConnection("panda", "fixture")).resolves.toMatchObject({
      state: {clientInformation: {client_id: expect.any(String)}, reauthorizationRequired: false},
    });
    expect((await service.getConnection("panda", "fixture"))?.state.tokens).toBeUndefined();
  }, 30_000);
});
