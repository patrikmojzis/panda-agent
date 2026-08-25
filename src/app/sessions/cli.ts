import process from "node:process";

import {Command, InvalidArgumentError} from "commander";
import type {Pool} from "pg";

import {DB_URL_OPTION_DESCRIPTION} from "../../lib/cli.js";
import {normalizeAgentKey} from "../../domain/agents/types.js";
import {withPostgresPool} from "../../lib/postgres-database.js";
import {PostgresAgentStore} from "../../domain/agents/postgres.js";
import {
  type SessionCliOptions,
  registerSessionManagementCommands,
} from "../../domain/sessions/cli.js";
import {ConversationRepo} from "../../domain/sessions/conversations/repo.js";
import {PostgresSessionStore} from "../../domain/sessions/postgres.js";
import {PostgresThreadRuntimeStore} from "../../domain/threads/runtime/postgres.js";
import {RuntimeRequestRepo} from "../../domain/threads/requests/repo.js";
import {PostgresIdentityStore} from "../../domain/identity/postgres.js";
import {DAEMON_REQUEST_TIMEOUT_MS, DAEMON_STALE_AFTER_MS, DEFAULT_DAEMON_KEY} from "../runtime/daemon.js";
import {DaemonStateRepo} from "../runtime/state/repo.js";

interface SessionResetCliOptions extends SessionCliOptions {
  agent?: string;
}

interface SessionCompactCliOptions extends SessionResetCliOptions {
  instructions?: string;
  json?: boolean;
}

const SESSION_COMPACT_REQUEST_TIMEOUT_MS = 15 * 60_000;

interface WithSessionResetStores {
  sessionStore: PostgresSessionStore;
  requests: RuntimeRequestRepo;
  daemonState: DaemonStateRepo;
}

function createSessionResetStores(pool: Pool): WithSessionResetStores & {
  agentStore: PostgresAgentStore;
  identityStore: PostgresIdentityStore;
  threadStore: PostgresThreadRuntimeStore;
  conversations: ConversationRepo;
} {
  return {
    agentStore: new PostgresAgentStore({pool}),
    identityStore: new PostgresIdentityStore({pool}),
    sessionStore: new PostgresSessionStore({pool}),
    threadStore: new PostgresThreadRuntimeStore({pool}),
    requests: new RuntimeRequestRepo({pool}),
    daemonState: new DaemonStateRepo({pool}),
    conversations: new ConversationRepo({pool}),
  };
}

async function withSessionResetStores<T>(
  options: SessionCliOptions,
  fn: (stores: WithSessionResetStores) => Promise<T>,
): Promise<T> {
  return withPostgresPool(options.dbUrl, async (pool) => {
    const stores = createSessionResetStores(pool);
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

function parseAgentKeyOption(value: string): string {
  try {
    return normalizeAgentKey(value);
  } catch (error) {
    throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
  }
}

async function requireDaemonOnline(daemonState: DaemonStateRepo): Promise<void> {
  const state = await daemonState.readState(DEFAULT_DAEMON_KEY);
  if (!state || Date.now() - state.heartbeatAt > DAEMON_STALE_AFTER_MS) {
    throw new Error(`panda run (${DEFAULT_DAEMON_KEY}) is offline.`);
  }
}

async function resetSessionCommand(sessionRef: string, options: SessionResetCliOptions): Promise<void> {
  await withSessionResetStores(options, async ({sessionStore, requests, daemonState}) => {
    await requireDaemonOnline(daemonState);
    const session = await sessionStore.resolveSessionRef({
      sessionRef,
      agentKey: options.agent,
    });
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

async function compactSessionCommand(sessionRef: string, options: SessionCompactCliOptions): Promise<void> {
  await withSessionResetStores(options, async ({sessionStore, requests, daemonState}) => {
    await requireDaemonOnline(daemonState);
    const session = await sessionStore.resolveSessionRef({
      sessionRef,
      agentKey: options.agent,
    });
    const request = await requests.enqueueRequest({
      kind: "compact_session",
      payload: {
        sessionId: session.id,
        customInstructions: options.instructions?.trim() ?? "",
      },
    });
    const result = await waitForRequestResult(requests, request.id, SESSION_COMPACT_REQUEST_TIMEOUT_MS);
    const output = {
      compacted: result.compacted === true,
      sessionId: session.id,
      threadId: typeof result.threadId === "string" ? result.threadId : session.currentThreadId,
      ...(typeof result.tokensBefore === "number" ? {tokensBefore: result.tokensBefore} : {}),
      ...(typeof result.tokensAfter === "number" ? {tokensAfter: result.tokensAfter} : {}),
    };

    if (options.json) {
      process.stdout.write(`${JSON.stringify(output)}\n`);
      return;
    }

    if (!output.compacted) {
      process.stdout.write(`Session ${output.sessionId} has no older context to compact.\nthread ${output.threadId}\n`);
      return;
    }

    process.stdout.write(
      `Compacted session ${output.sessionId}.\nthread ${output.threadId}\ntokens ${output.tokensBefore ?? "-"} -> ${output.tokensAfter ?? "-"}\n`,
    );
  });
}

export function registerSessionCommands(program: Command): void {
  const sessionProgram = program
    .command("session")
    .description("Manage Panda agent sessions");

  registerSessionManagementCommands(sessionProgram);

  sessionProgram
    .command("reset")
    .description("Reset one session through the daemon")
    .argument("<sessionRef>", "Session id, or alias when --agent is provided")
    .option("--agent <agentKey>", "Agent key for alias lookup", parseAgentKeyOption)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((sessionRef: string, options: SessionResetCliOptions) => {
      return resetSessionCommand(sessionRef, options);
    });

  sessionProgram
    .command("compact")
    .description("Compact the current thread of one session through the daemon")
    .argument("<sessionRef>", "Session id, or alias when --agent is provided")
    .option("--agent <agentKey>", "Agent key for alias lookup", parseAgentKeyOption)
    .option("--instructions <text>", "Additional instructions for the compact summary")
    .option("--json", "Render the compaction result as JSON")
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((sessionRef: string, options: SessionCompactCliOptions) => {
      return compactSessionCommand(sessionRef, options);
    });
}
