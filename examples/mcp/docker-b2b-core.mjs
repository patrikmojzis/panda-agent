#!/usr/bin/env node
import {mkdir, writeFile} from "node:fs/promises";

import {createRuntime} from "/app/dist/app/runtime/create-runtime.js";
import {startCommandHttpServer} from "/app/dist/integrations/commands/http-server.js";
import {startControlServer} from "/app/dist/integrations/control/http-server.js";

const databaseUrl = process.env.DATABASE_URL;
const commandUrl = process.env.MCP_B2B_COMMAND_URL ?? "http://mcp-core:8096";
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

async function writeAccessFile(name, lease) {
  if (!lease) throw new Error(`MCP B2B ${name} lease was not issued.`);
  await writeFile(
    `${accessDir}/${name}`,
    `PANDA_COMMAND_URL=${commandUrl}\nPANDA_COMMAND_SOCKET=\nPANDA_COMMAND_TOKEN=${lease.token}\n`,
    {mode: 0o600},
  );
}

async function close() {
  await controlServer?.close().catch(() => undefined);
  await commandServer?.close().catch(() => undefined);
  await runtime.close().catch(() => undefined);
}

try {
  await runtime.identityStore.createIdentity({
    id: "identity-mcp-b2b",
    handle: "mcp-b2b",
    displayName: "MCP B2B",
  });
  await runtime.agentStore.bootstrapAgent({agentKey: "panda", displayName: "Panda"});
  await runtime.agentStore.ensurePairing("panda", "identity-mcp-b2b");
  await runtime.sessionStore.createSession({
    id: "session-mcp-primary",
    agentKey: "panda",
    kind: "main",
    currentThreadId: "thread-mcp-primary",
    createdByIdentityId: "identity-mcp-b2b",
  });
  for (const suffix of ["deny", "allow"]) {
    await runtime.sessionStore.createSession({
      id: `session-mcp-subagent-${suffix}`,
      agentKey: "panda",
      kind: "subagent",
      currentThreadId: `thread-mcp-subagent-${suffix}`,
      createdByIdentityId: "identity-mcp-b2b",
      metadata: {mcpB2b: true},
    });
  }

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

  const toolPolicy = {allowedTools: ["mcp.*"]};
  await mkdir(accessDir, {recursive: true, mode: 0o700});
  await writeAccessFile("primary", runtime.commandLeases.issueCommandLease({
    agentKey: "panda",
    sessionId: "session-mcp-primary",
    toolPolicy,
    credentialPolicy: {mode: "all_agent"},
  }));
  await writeAccessFile("subagent-deny", runtime.commandLeases.issueCommandLease({
    agentKey: "panda",
    sessionId: "session-mcp-subagent-deny",
    toolPolicy,
    credentialPolicy: {mode: "none"},
  }));
  await writeAccessFile("subagent-allow", runtime.commandLeases.issueCommandLease({
    agentKey: "panda",
    sessionId: "session-mcp-subagent-allow",
    toolPolicy,
    credentialPolicy: {mode: "allowlist", envKeys: ["FIXTURE_SECRET"]},
  }));

  process.stdout.write(`READY ${JSON.stringify({controlPort: controlServer.port, commandPort: commandServer.port})}\n`);
  await new Promise((resolve) => {
    process.once("SIGTERM", resolve);
    process.once("SIGINT", resolve);
  });
} finally {
  await close();
}
