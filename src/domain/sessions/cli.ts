import process from "node:process";

import {Command, InvalidArgumentError} from "commander";
import type {Pool} from "pg";

import {DB_URL_OPTION_DESCRIPTION} from "../../app/cli-shared.js";
import {DAEMON_REQUEST_TIMEOUT_MS, DAEMON_STALE_AFTER_MS, DEFAULT_DAEMON_KEY} from "../../app/runtime/daemon.js";
import {ensureSchemas, withPostgresPool} from "../../app/runtime/postgres-bootstrap.js";
import {DaemonStateRepo} from "../../app/runtime/state/repo.js";
import {PostgresAgentStore} from "../agents/postgres.js";
import {RuntimeRequestRepo} from "../threads/requests/repo.js";
import {ConversationRepo} from "./conversations/repo.js";
import {PostgresThreadRuntimeStore} from "../threads/runtime/index.js";
import {PostgresIdentityStore} from "../identity/postgres.js";
import {PostgresSessionStore} from "./postgres.js";

interface SessionCliOptions {
  dbUrl?: string;
}

interface HeartbeatCliOptions extends SessionCliOptions {
  enable?: boolean;
  disable?: boolean;
  every?: number;
}

interface WithSessionStores {
  sessionStore: PostgresSessionStore;
  threadStore: PostgresThreadRuntimeStore;
  requests: RuntimeRequestRepo;
  daemonState: DaemonStateRepo;
  conversations: ConversationRepo;
}

function createSessionCliStores(pool: Pool): WithSessionStores & {
  agentStore: PostgresAgentStore;
  identityStore: PostgresIdentityStore;
} {
  const identityStore = new PostgresIdentityStore({pool});
  return {
    agentStore: new PostgresAgentStore({pool}),
    identityStore,
    sessionStore: new PostgresSessionStore({pool}),
    threadStore: new PostgresThreadRuntimeStore({pool}),
    requests: new RuntimeRequestRepo({pool}),
    daemonState: new DaemonStateRepo({pool}),
    conversations: new ConversationRepo({pool}),
  };
}

function parsePositiveInt(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError("Expected a positive integer.");
  }

  return parsed;
}

async function withSessionStores<T>(
  options: SessionCliOptions,
  fn: (stores: WithSessionStores) => Promise<T>,
): Promise<T> {
  return withPostgresPool(options.dbUrl, async (pool) => {
    const stores = createSessionCliStores(pool);
    await ensureSchemas([
      stores.identityStore,
      stores.agentStore,
      stores.sessionStore,
      stores.threadStore,
      stores.requests,
      stores.daemonState,
      stores.conversations,
    ]);
    return fn(stores);
  });
}

async function waitForRequestResult(
  requests: RuntimeRequestRepo,
  requestId: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const request = await requests.getRequest(requestId);
    if (request.status === "completed") {
      return (request.result ?? {}) as Record<string, unknown>;
    }
    if (request.status === "failed") {
      throw new Error(request.error ?? `Runtime request ${requestId} failed.`);
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for runtime request ${requestId}.`);
}

async function requireDaemonOnline(daemonState: DaemonStateRepo): Promise<void> {
  const state = await daemonState.readState(DEFAULT_DAEMON_KEY);
  if (!state || Date.now() - state.heartbeatAt > DAEMON_STALE_AFTER_MS) {
    throw new Error(`panda run (${DEFAULT_DAEMON_KEY}) is offline.`);
  }
}

async function listSessionsCommand(agentKey: string, options: SessionCliOptions): Promise<void> {
  await withSessionStores(options, async ({sessionStore}) => {
    const sessions = await sessionStore.listAgentSessions(agentKey);
    if (sessions.length === 0) {
      process.stdout.write(`No sessions for ${agentKey}.\n`);
      return;
    }

    for (const session of sessions) {
      process.stdout.write(
        [
          session.id,
          `  kind ${session.kind} · current thread ${session.currentThreadId}`,
          `  created by ${session.createdByIdentityId ?? "-"}`,
        ].join("\n") + "\n\n",
      );
    }
  });
}

async function inspectSessionCommand(sessionId: string, options: SessionCliOptions): Promise<void> {
  await withSessionStores(options, async ({sessionStore, threadStore}) => {
    const session = await sessionStore.getSession(sessionId);
    const thread = await threadStore.getThread(session.currentThreadId);
    const heartbeat = await sessionStore.getHeartbeat(session.id);
    process.stdout.write(
      [
        `Session ${session.id}`,
        `agent ${session.agentKey}`,
        `kind ${session.kind}`,
        `current thread ${session.currentThreadId}`,
        `created by ${session.createdByIdentityId ?? "-"}`,
        `thread model ${thread.model ?? "-"}`,
        `heartbeat enabled ${heartbeat?.enabled ? "yes" : "no"}`,
        `heartbeat every ${heartbeat?.everyMinutes ?? "-"} minutes`,
      ].join("\n") + "\n",
    );
  });
}

async function resetSessionCommand(sessionId: string, options: SessionCliOptions): Promise<void> {
  await withSessionStores(options, async ({sessionStore, requests, daemonState}) => {
    await requireDaemonOnline(daemonState);
    const session = await sessionStore.getSession(sessionId);
    const request = await requests.enqueueRequest({
      kind: "reset_session",
      payload: {
        source: "operator",
        sessionId: session.id,
      },
    });
    const result = await waitForRequestResult(requests, request.id, DAEMON_REQUEST_TIMEOUT_MS);
    process.stdout.write(
      [
        `Reset session ${session.id}.`,
        `new thread ${typeof result.threadId === "string" ? result.threadId : "-"}`,
        `previous thread ${typeof result.previousThreadId === "string" ? result.previousThreadId : "-"}`,
      ].join("\n") + "\n",
    );
  });
}

async function heartbeatCommand(sessionId: string, options: HeartbeatCliOptions): Promise<void> {
  if (options.enable && options.disable) {
    throw new Error("Pick one: --enable or --disable.");
  }

  await withSessionStores(options, async ({sessionStore}) => {
    const heartbeat = await sessionStore.updateHeartbeatConfig({
      sessionId,
      enabled: options.disable ? false : options.enable ? true : undefined,
      everyMinutes: options.every,
    });
    process.stdout.write(
      [
        `Updated heartbeat for ${sessionId}.`,
        `enabled ${heartbeat.enabled ? "yes" : "no"}`,
        `every ${heartbeat.everyMinutes} minutes`,
      ].join("\n") + "\n",
    );
  });
}

async function bindConversationCommand(
  sessionId: string,
  source: string,
  connectorKey: string,
  externalConversationId: string,
  options: SessionCliOptions,
): Promise<void> {
  await withSessionStores(options, async ({conversations, sessionStore}) => {
    await sessionStore.getSession(sessionId);
    const binding = await conversations.bindConversation({
      source,
      connectorKey,
      externalConversationId,
      sessionId,
    });
    process.stdout.write(
      [
        `Bound conversation to session ${binding.binding.sessionId}.`,
        `${binding.binding.source}/${binding.binding.connectorKey}/${binding.binding.externalConversationId}`,
      ].join("\n") + "\n",
    );
  });
}

export function registerSessionCommands(program: Command): void {
  const sessionProgram = program
    .command("session")
    .description("Manage Panda agent sessions");

  sessionProgram
    .command("list")
    .description("List sessions for an agent")
    .argument("<agentKey>", "Agent key")
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((agentKey: string, options: SessionCliOptions) => {
      return listSessionsCommand(agentKey, options);
    });

  sessionProgram
    .command("inspect")
    .description("Inspect one session")
    .argument("<sessionId>", "Session id")
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((sessionId: string, options: SessionCliOptions) => {
      return inspectSessionCommand(sessionId, options);
    });

  sessionProgram
    .command("reset")
    .description("Reset one session through the daemon")
    .argument("<sessionId>", "Session id")
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((sessionId: string, options: SessionCliOptions) => {
      return resetSessionCommand(sessionId, options);
    });

  sessionProgram
    .command("heartbeat")
    .description("Configure session heartbeat")
    .argument("<sessionId>", "Session id")
    .option("--enable", "Enable heartbeat")
    .option("--disable", "Disable heartbeat")
    .option("--every <minutes>", "Heartbeat interval in minutes", parsePositiveInt)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((sessionId: string, options: HeartbeatCliOptions) => {
      return heartbeatCommand(sessionId, options);
    });

  sessionProgram
    .command("bind-conversation")
    .description("Bind an external conversation to a session")
    .argument("<sessionId>", "Session id")
    .argument("<source>", "Channel source, for example telegram")
    .argument("<connectorKey>", "Connector key")
    .argument("<externalConversationId>", "External conversation id")
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((
      sessionId: string,
      source: string,
      connectorKey: string,
      externalConversationId: string,
      options: SessionCliOptions,
    ) => {
      return bindConversationCommand(sessionId, source, connectorKey, externalConversationId, options);
    });
}
