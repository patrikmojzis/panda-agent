import {randomUUID} from "node:crypto";
import process from "node:process";

import {Command, InvalidArgumentError} from "commander";
import type {Pool} from "pg";

import {DB_URL_OPTION_DESCRIPTION, parsePositiveIntegerOption} from "../../lib/cli.js";
import {resolveAgentDir} from "../../lib/data-dir.js";
import {ensureSchemas, withPostgresPool} from "../../lib/postgres-bootstrap.js";
import {PostgresAgentStore} from "../agents/postgres.js";
import {normalizeAgentKey} from "../agents/types.js";
import {ConversationRepo} from "./conversations/repo.js";
import {PostgresThreadRuntimeStore} from "../threads/runtime/postgres.js";
import {PostgresIdentityStore} from "../identity/postgres.js";
import {createSessionWithInitialThread} from "./lifecycle.js";
import {PostgresSessionStore} from "./postgres.js";

export interface SessionCliOptions {
  dbUrl?: string;
}

interface HeartbeatCliOptions extends SessionCliOptions {
  enable?: boolean;
  disable?: boolean;
  every?: number;
}

interface WithSessionStores {
  pool: Pool;
  agentStore: PostgresAgentStore;
  sessionStore: PostgresSessionStore;
  threadStore: PostgresThreadRuntimeStore;
  conversations: ConversationRepo;
}

export function createSessionCliStores(pool: Pool): WithSessionStores & {
  identityStore: PostgresIdentityStore;
} {
  const identityStore = new PostgresIdentityStore({pool});
  return {
    pool,
    agentStore: new PostgresAgentStore({pool}),
    identityStore,
    sessionStore: new PostgresSessionStore({pool}),
    threadStore: new PostgresThreadRuntimeStore({pool}),
    conversations: new ConversationRepo({pool}),
  };
}

export async function withSessionStores<T>(
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
      stores.conversations,
    ]);
    return fn(stores);
  });
}

function normalizeSessionRef(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    throw new Error("Session ref must not be empty.");
  }

  if (!/^[a-z0-9][a-z0-9_-]*$/.test(normalized)) {
    throw new Error(
      "Session ref must use letters, numbers, hyphens, or underscores, and start with a letter or number.",
    );
  }

  return normalized;
}

function parseCliValue<T>(value: string, parser: (value: string) => T): T {
  try {
    return parser(value);
  } catch (error) {
    if (error instanceof Error) {
      throw new InvalidArgumentError(error.message);
    }

    throw error;
  }
}

function parseCreateAgentKey(value: string): string {
  return parseCliValue(value, normalizeAgentKey);
}

function parseSessionRefArgument(value: string): string {
  return parseCliValue(value, normalizeSessionRef);
}

function isUnknownSessionError(error: unknown, sessionId: string): boolean {
  return error instanceof Error && error.message === `Unknown session ${sessionId}`;
}

function isDuplicateSessionIdError(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as {code?: unknown}).code;
    if (code === "23505") {
      return true;
    }
  }

  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes("duplicate key");
}

function duplicateSessionRefError(sessionId: string): Error {
  return new Error(`Session ${sessionId} already exists. Pick a different session ref.`);
}

async function assertSessionIdAvailable(sessionStore: PostgresSessionStore, sessionId: string): Promise<void> {
  try {
    await sessionStore.getSession(sessionId);
  } catch (error) {
    if (isUnknownSessionError(error, sessionId)) {
      return;
    }

    throw error;
  }

  throw duplicateSessionRefError(sessionId);
}

function buildSessionCreateOutput(input: {
  agentKey: string;
  sessionRef?: string;
  sessionId: string;
  threadId: string;
}): string {
  return [
    "Created branch session.",
    `agent ${input.agentKey}`,
    ...(input.sessionRef ? [`ref ${input.sessionRef}`] : []),
    `sessionId ${input.sessionId}`,
    `initialThread ${input.threadId}`,
    "",
    "Discord bind example:",
    `panda discord bind-channel --account <accountKey> --channel <discordChannelId> --session ${input.sessionId}`,
  ].join("\n") + "\n";
}

async function createSessionCommand(
  agentKey: string,
  sessionRef: string | undefined,
  options: SessionCliOptions,
): Promise<void> {
  await withSessionStores(options, async ({pool, agentStore, sessionStore, threadStore}) => {
    const agent = await agentStore.getAgent(agentKey);
    const normalizedRef = sessionRef ? normalizeSessionRef(sessionRef) : undefined;
    const sessionId = normalizedRef ? `${agent.agentKey}:${normalizedRef}` : randomUUID();
    const threadId = randomUUID();

    if (normalizedRef) {
      await assertSessionIdAvailable(sessionStore, sessionId);
    }

    try {
      await createSessionWithInitialThread({
        pool,
        sessionStore,
        threadStore,
        session: {
          id: sessionId,
          agentKey: agent.agentKey,
          kind: "branch",
          currentThreadId: threadId,
        },
        thread: {
          id: threadId,
          sessionId,
          context: {
            agentKey: agent.agentKey,
            sessionId,
            cwd: resolveAgentDir(agent.agentKey),
          },
        },
      });
    } catch (error) {
      if (normalizedRef && isDuplicateSessionIdError(error)) {
        throw duplicateSessionRefError(sessionId);
      }

      throw error;
    }

    process.stdout.write(buildSessionCreateOutput({
      agentKey: agent.agentKey,
      sessionRef: normalizedRef,
      sessionId,
      threadId,
    }));
  });
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

export function registerSessionManagementCommands(sessionProgram: Command): void {
  sessionProgram
    .command("create")
    .description("Create a branch session for an agent")
    .argument("<agentKey>", "Agent key", parseCreateAgentKey)
    .argument("[sessionRef]", "Optional readable session ref", parseSessionRefArgument)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((agentKey: string, sessionRef: string | undefined, options: SessionCliOptions) => {
      return createSessionCommand(agentKey, sessionRef, options);
    });

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
    .command("heartbeat")
    .description("Configure session heartbeat")
    .argument("<sessionId>", "Session id")
    .option("--enable", "Enable heartbeat")
    .option("--disable", "Disable heartbeat")
    .option("--every <minutes>", "Heartbeat interval in minutes", parsePositiveIntegerOption)
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

export function registerSessionCommands(program: Command): void {
  registerSessionManagementCommands(
    program
      .command("session")
      .description("Manage Panda agent sessions"),
  );
}
