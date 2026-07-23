#!/usr/bin/env node
import {mkdir, writeFile} from "node:fs/promises";
import {spawn} from "node:child_process";

import {createRuntime} from "/app/dist/app/runtime/create-runtime.js";
import {startCommandHttpServer} from "/app/dist/integrations/commands/http-server.js";
import {startControlServer} from "/app/dist/integrations/control/http-server.js";

const databaseUrl = process.env.DATABASE_URL;
const accessDir = process.env.MCP_B2B_ACCESS_DIR ?? "/run/panda-b2b";
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const runtime = await createRuntime({
  dbUrl: databaseUrl,
  cwd: "/app",
  resolveDefinition: () => {
    throw new Error("Docker MCP B2B does not execute model inference.");
  },
});
let commandServer;
let controlServer;
let oauthFixture;

async function writeAccessFile(name, commandAccess) {
  if (!commandAccess?.url) throw new Error(`MCP B2B ${name} HTTP command access was not issued.`);
  await writeFile(
    `${accessDir}/${name}`,
    `PANDA_COMMAND_URL=${commandAccess.url}\nPANDA_COMMAND_SOCKET=\nPANDA_COMMAND_TOKEN=${commandAccess.token}\n`,
    {mode: 0o600},
  );
}

async function close() {
  await controlServer?.close().catch(() => undefined);
  await commandServer?.close().catch(() => undefined);
  await runtime.close().catch(() => undefined);
  oauthFixture?.kill("SIGTERM");
}

try {
  await runtime.identityStore.createIdentity({
    id: "identity-mcp-b2b",
    handle: "mcp-b2b",
    displayName: "MCP B2B",
  });
  await runtime.agentStore.bootstrapAgent({agentKey: "panda", displayName: "Panda"});
  await runtime.agentStore.ensurePairing("panda", "identity-mcp-b2b");
  oauthFixture = spawn(process.execPath, ["/app/examples/mcp/fixture-server.mjs", "--transport", "http", "--host", "127.0.0.1", "--port", "3011", "--mode", "oauth"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve, reject) => {
    let output = "";
    oauthFixture.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
      if (output.includes("READY ")) resolve();
    });
    oauthFixture.once("exit", (code) => reject(new Error(`OAuth fixture exited before readiness with ${code}.`)));
  });
  await runtime.sessionStore.createSession({
    id: "session-mcp-primary",
    agentKey: "panda",
    kind: "main",
    currentThreadId: "thread-mcp-primary",
    createdByIdentityId: "identity-mcp-b2b",
  });
  const deniedSubagent = await runtime.subagentSessions.createSubagentSession({
    agentKey: "panda",
    parentSessionId: "session-mcp-primary",
    task: "Prove MCP credential denial through production policy resolution.",
    toolGroups: ["mcp"],
    sessionId: "session-mcp-subagent-deny",
    threadId: "thread-mcp-subagent-deny",
    createdByIdentityId: "identity-mcp-b2b",
    deliveryMode: "queue",
  });
  const allowedSubagent = await runtime.subagentSessions.createSubagentSession({
    agentKey: "panda",
    parentSessionId: "session-mcp-primary",
    task: "Prove MCP credential allowlisting through production policy resolution.",
    toolGroups: ["mcp"],
    credentialAllowlist: ["FIXTURE_SECRET"],
    credentialRefAllowlist: ["mcp-oauth:fixture-oauth"],
    sessionId: "session-mcp-subagent-allow",
    threadId: "thread-mcp-subagent-allow",
    createdByIdentityId: "identity-mcp-b2b",
    deliveryMode: "queue",
  });

  commandServer = await startCommandHttpServer({
    host: "0.0.0.0",
    port: 8096,
    executor: runtime.commandExecutor,
    leaseVerifier: runtime.commandLeases,
  });
  controlServer = await startControlServer({
    host: "0.0.0.0",
    port: 4767,
    auth: runtime.controlAuth,
    reads: runtime.controlReads,
    home: runtime.controlHome,
    operator: runtime.controlOperator,
    mcp: runtime.controlMcp,
    briefings: runtime.controlBriefings,
    heartbeats: runtime.controlHeartbeats,
    scheduledTasks: runtime.controlScheduledTasks,
    watches: runtime.controlWatches,
    runtimeActivity: runtime.controlRuntimeActivity,
    connectorAccounts: runtime.controlConnectorAccounts,
    modelCallTraces: runtime.controlModelCallTraces,
    identityStore: runtime.identityStore,
    env: {
      ...process.env,
      PANDA_CONTROL_DEV_LOGIN_ENABLED: "true",
      PANDA_CONTROL_DEV_LOGIN_ALLOW_REMOTE: "true",
    },
  });

  async function refreshCommandAccess(session) {
    const executionEnvironment = await runtime.executionEnvironmentResolver.resolveDefault(session);
    const refreshed = await runtime.executionEnvironmentService.refreshSessionCommandAccess({
      session,
      executionEnvironment,
    });
    if (!refreshed.refreshed || !refreshed.commandAccess) {
      throw new Error(`MCP B2B command access refresh failed: ${refreshed.reason ?? "unknown"}.`);
    }
    return refreshed.commandAccess;
  }

  await mkdir(accessDir, {recursive: true, mode: 0o700});
  const primarySession = await runtime.sessionStore.getSession("session-mcp-primary");
  await writeAccessFile("primary-initial", await refreshCommandAccess(primarySession));
  await writeAccessFile("primary", await refreshCommandAccess(primarySession));
  await writeAccessFile("subagent-deny", await refreshCommandAccess(deniedSubagent.session));
  await writeAccessFile("subagent-allow", await refreshCommandAccess(allowedSubagent.session));

  process.stdout.write(`READY ${JSON.stringify({controlPort: controlServer.port, commandPort: commandServer.port})}\n`);
  await new Promise((resolve) => {
    process.once("SIGTERM", resolve);
    process.once("SIGINT", resolve);
  });
} finally {
  await close();
}
