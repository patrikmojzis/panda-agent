import {randomUUID} from "node:crypto";
import process from "node:process";
import {mkdir} from "node:fs/promises";

import {Command, InvalidArgumentError} from "commander";
import type {Pool} from "pg";

import {DB_URL_OPTION_DESCRIPTION} from "../../lib/cli.js";
import {resolveAgentDir} from "../../lib/data-dir.js";
import {ensureSchemas, withPostgresPool} from "../../lib/postgres-bootstrap.js";
import {PostgresIdentityStore} from "../identity/postgres.js";
import {createSessionWithInitialThread, resetSessionCurrentThread} from "../sessions/lifecycle.js";
import {PostgresSessionStore} from "../sessions/postgres.js";
import {PostgresThreadRuntimeStore} from "../threads/runtime/postgres.js";
import {isMissingThreadError} from "../threads/runtime/types.js";
import {isMissingAgentError} from "./errors.js";
import {PostgresAgentStore} from "./postgres.js";
import {type AgentRecord, normalizeAgentKey} from "./types.js";

interface AgentCliOptions {
  dbUrl?: string;
}

interface CreateAgentCliOptions extends AgentCliOptions {
  name?: string;
}

interface PairAgentCliOptions extends AgentCliOptions {}

interface AgentCliStores {
  pool: Pool;
  agentStore: PostgresAgentStore;
  identityStore: PostgresIdentityStore;
  sessionStore: PostgresSessionStore;
  threadStore: PostgresThreadRuntimeStore;
}

export interface EnsureAgentResult {
  agentKey: string;
  displayName: string;
  createdAgent: boolean;
  createdMainSession: boolean;
  createdMainThread: boolean;
  sessionId: string;
  threadId: string;
  homeDir: string;
}

function createAgentCliStores(pool: Pool): AgentCliStores {
  const identityStore = new PostgresIdentityStore({pool});
  return {
    pool,
    agentStore: new PostgresAgentStore({pool}),
    identityStore,
    sessionStore: new PostgresSessionStore({pool}),
    threadStore: new PostgresThreadRuntimeStore({pool}),
  };
}

async function withAgentStores<T>(
  options: AgentCliOptions,
  fn: (stores: AgentCliStores) => Promise<T>,
): Promise<T> {
  return withPostgresPool(options.dbUrl, async (pool) => {
    const stores = createAgentCliStores(pool);
    await ensureSchemas([
      stores.identityStore,
      stores.agentStore,
      stores.sessionStore,
      stores.threadStore,
    ]);
    return fn(stores);
  });
}

export function parseAgentKey(value: string): string {
  try {
    return normalizeAgentKey(value);
  } catch (error) {
    if (error instanceof Error) {
      throw new InvalidArgumentError(error.message);
    }

    throw error;
  }
}

async function createMainSessionThread(
  stores: Pick<AgentCliStores, "sessionStore" | "threadStore"> & {pool?: Pool},
  agentKey: string,
): Promise<{sessionId: string; threadId: string}> {
  const sessionId = randomUUID();
  const threadId = randomUUID();
  if (stores.pool) {
    await createSessionWithInitialThread({
      pool: stores.pool,
      sessionStore: stores.sessionStore,
      threadStore: stores.threadStore,
      session: {
        id: sessionId,
        agentKey,
        kind: "main",
        currentThreadId: threadId,
      },
      thread: {
        id: threadId,
        sessionId,
      },
    });
  } else {
    await stores.sessionStore.createSession({
      id: sessionId,
      agentKey,
      kind: "main",
      currentThreadId: threadId,
    });
    await stores.threadStore.createThread({
      id: threadId,
      sessionId,
    });
  }
  return {sessionId, threadId};
}

export async function ensureAgent(
  stores: Pick<AgentCliStores, "agentStore" | "sessionStore" | "threadStore"> & {pool?: Pool},
  agentKey: string,
  options: {name?: string; env?: NodeJS.ProcessEnv} = {},
): Promise<EnsureAgentResult> {
  const normalizedAgentKey = normalizeAgentKey(agentKey);
  const env = options.env ?? process.env;
  let createdAgent = false;
  let createdMainSession = false;
  let createdMainThread = false;

  let agent: AgentRecord;
  try {
    agent = await stores.agentStore.getAgent(normalizedAgentKey);
  } catch (error) {
    if (!isMissingAgentError(error, normalizedAgentKey)) {
      throw error;
    }

    agent = await stores.agentStore.bootstrapAgent({
      agentKey: normalizedAgentKey,
      displayName: options.name?.trim() || normalizedAgentKey,
    });
    createdAgent = true;
  }

  const homeDir = resolveAgentDir(agent.agentKey, env);
  await mkdir(homeDir, {recursive: true});

  const mainSession = await stores.sessionStore.getMainSession(agent.agentKey);
  let sessionId: string;
  let threadId: string;

  if (!mainSession) {
    const created = await createMainSessionThread(stores, agent.agentKey);
    sessionId = created.sessionId;
    threadId = created.threadId;
    createdMainSession = true;
    createdMainThread = true;
  } else {
    sessionId = mainSession.id;
    threadId = mainSession.currentThreadId;

    try {
      await stores.threadStore.getThread(threadId);
    } catch (error) {
      if (!isMissingThreadError(error, threadId)) {
        throw error;
      }

      threadId = randomUUID();
      if (stores.pool) {
        await resetSessionCurrentThread({
          pool: stores.pool,
          sessionStore: stores.sessionStore,
          threadStore: stores.threadStore,
          thread: {
            id: threadId,
            sessionId,
          },
          session: {
            sessionId,
            currentThreadId: threadId,
          },
        });
      } else {
        await stores.threadStore.createThread({
          id: threadId,
          sessionId,
        });
        await stores.sessionStore.updateCurrentThread({
          sessionId,
          currentThreadId: threadId,
        });
      }
      createdMainThread = true;
    }
  }

  return {
    agentKey: agent.agentKey,
    displayName: agent.displayName,
    createdAgent,
    createdMainSession,
    createdMainThread,
    sessionId,
    threadId,
    homeDir,
  };
}

export async function listAgentsCommand(options: AgentCliOptions): Promise<void> {
  await withAgentStores(options, async ({agentStore, sessionStore}) => {
    const agents = await agentStore.listAgents();

    if (agents.length === 0) {
      process.stdout.write("No agents yet.\n");
      return;
    }

    for (const agent of agents) {
      const sessions = await sessionStore.listAgentSessions(agent.agentKey);
      const main = sessions.find((session) => session.kind === "main");
      process.stdout.write(
        [
          agent.agentKey,
          `  name ${agent.displayName} · status ${agent.status} · created ${new Date(agent.createdAt).toISOString()}`,
          `  main session ${main?.id ?? "-"}`,
        ].join("\n") + "\n\n",
      );
    }
  });
}

export async function createAgentCommand(agentKey: string, options: CreateAgentCliOptions): Promise<void> {
  await withAgentStores(options, async ({agentStore, sessionStore, threadStore}) => {
    const created = await agentStore.bootstrapAgent({
      agentKey,
      displayName: options.name?.trim() || agentKey,
    });
    const agentHome = resolveAgentDir(created.agentKey);
    const {sessionId, threadId} = await createMainSessionThread(
      {sessionStore, threadStore},
      created.agentKey,
    );
    await mkdir(agentHome, {recursive: true});

    process.stdout.write(
      [
        `Created agent ${created.agentKey}.`,
        `name ${created.displayName}`,
        `main session ${sessionId}`,
        `initial thread ${threadId}`,
        `home ${agentHome}`,
      ].join("\n") + "\n",
    );
  });
}

export async function ensureAgentCommand(agentKey: string, options: CreateAgentCliOptions): Promise<void> {
  await withAgentStores(options, async ({agentStore, sessionStore, threadStore}) => {
    const ensured = await ensureAgent(
      {agentStore, sessionStore, threadStore},
      agentKey,
      {name: options.name, env: process.env},
    );

    process.stdout.write(
      [
        `Ensured agent ${ensured.agentKey}.`,
        `name ${ensured.displayName}`,
        `agent created ${ensured.createdAgent ? "yes" : "no"}`,
        `main session created ${ensured.createdMainSession ? "yes" : "no"}`,
        `main thread created ${ensured.createdMainThread ? "yes" : "no"}`,
        `main session ${ensured.sessionId}`,
        `current thread ${ensured.threadId}`,
        `home ${ensured.homeDir}`,
      ].join("\n") + "\n",
    );
  });
}

async function pairAgentCommand(
  agentKey: string,
  identityHandle: string,
  options: PairAgentCliOptions,
): Promise<void> {
  await withAgentStores(options, async ({agentStore, identityStore}) => {
    const identity = await identityStore.getIdentityByHandle(identityHandle);
    await agentStore.getAgent(agentKey);
    const pairing = await agentStore.ensurePairing(agentKey, identity.id);
    process.stdout.write(
      [
        `Paired ${identity.handle} with ${pairing.agentKey}.`,
        `identity ${pairing.identityId}`,
      ].join("\n") + "\n",
    );
  });
}

async function unpairAgentCommand(
  agentKey: string,
  identityHandle: string,
  options: PairAgentCliOptions,
): Promise<void> {
  await withAgentStores(options, async ({agentStore, identityStore}) => {
    const identity = await identityStore.getIdentityByHandle(identityHandle);
    const deleted = await agentStore.deletePairing(agentKey, identity.id);
    process.stdout.write(
      `${deleted ? "Removed" : "No"} pairing for ${identity.handle} and ${agentKey}.\n`,
    );
  });
}

async function listPairingsCommand(agentKey: string, options: PairAgentCliOptions): Promise<void> {
  await withAgentStores(options, async ({agentStore, identityStore}) => {
    const pairings = await agentStore.listAgentPairings(agentKey);
    if (pairings.length === 0) {
      process.stdout.write(`No pairings for ${agentKey}.\n`);
      return;
    }

    for (const pairing of pairings) {
      const identity = await identityStore.getIdentity(pairing.identityId);
      process.stdout.write(`${identity.handle} (${pairing.identityId})\n`);
    }
  });
}

export function registerAgentCommands(program: Command): void {
  const agentProgram = program
    .command("agent")
    .description("Manage Panda agents");

  agentProgram
    .command("list")
    .description("List stored Panda agents")
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((options: AgentCliOptions) => {
      return listAgentsCommand(options);
    });

  agentProgram
    .command("create")
    .description("Create a Panda agent")
    .argument("<agentKey>", "Agent key", parseAgentKey)
    .option("--name <displayName>", "Display name to show in UIs")
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((agentKey: string, options: CreateAgentCliOptions) => {
      return createAgentCommand(agentKey, options);
    });

  agentProgram
    .command("ensure")
    .description("Create a Panda agent if missing and repair its main session scaffold")
    .argument("<agentKey>", "Agent key", parseAgentKey)
    .option("--name <displayName>", "Display name to use when the agent is created")
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((agentKey: string, options: CreateAgentCliOptions) => {
      return ensureAgentCommand(agentKey, options);
    });

  agentProgram
    .command("pair")
    .description("Pair an identity with an agent")
    .argument("<agentKey>", "Agent key", parseAgentKey)
    .argument("<identityHandle>", "Identity handle")
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((agentKey: string, identityHandle: string, options: PairAgentCliOptions) => {
      return pairAgentCommand(agentKey, identityHandle, options);
    });

  agentProgram
    .command("unpair")
    .description("Remove an identity pairing from an agent")
    .argument("<agentKey>", "Agent key", parseAgentKey)
    .argument("<identityHandle>", "Identity handle")
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((agentKey: string, identityHandle: string, options: PairAgentCliOptions) => {
      return unpairAgentCommand(agentKey, identityHandle, options);
    });

  agentProgram
    .command("pairings")
    .description("List identities paired to an agent")
    .argument("<agentKey>", "Agent key", parseAgentKey)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((agentKey: string, options: PairAgentCliOptions) => {
      return listPairingsCommand(agentKey, options);
    });
}
