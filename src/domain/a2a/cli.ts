import process from "node:process";

import {Command} from "commander";
import type {Pool} from "pg";

import {DB_URL_OPTION_DESCRIPTION} from "../../app/cli-shared.js";
import {ensureSchemas, withPostgresPool} from "../../app/runtime/postgres-bootstrap.js";
import {parseSessionIdOption} from "../../lib/cli.js";
import {PostgresAgentStore} from "../agents/postgres.js";
import {parseAgentKey} from "../agents/cli.js";
import {PostgresIdentityStore} from "../identity/postgres.js";
import {PostgresSessionStore} from "../sessions/postgres.js";
import {A2ASessionBindingRepo} from "./repo.js";

interface A2ACliOptions {
  dbUrl?: string;
}

interface BindA2ACliOptions extends A2ACliOptions {
  fromAgent?: string;
  oneWay?: boolean;
  toAgent?: string;
}

interface ListA2ACliOptions extends A2ACliOptions {
  fromAgent?: string;
  fromSession?: string;
  toAgent?: string;
  toSession?: string;
}

interface A2AStores {
  agentStore: PostgresAgentStore;
  bindings: A2ASessionBindingRepo;
  identityStore: PostgresIdentityStore;
  sessionStore: PostgresSessionStore;
}

function createA2AStores(pool: Pool): A2AStores {
  return {
    agentStore: new PostgresAgentStore({pool}),
    bindings: new A2ASessionBindingRepo({pool}),
    identityStore: new PostgresIdentityStore({pool}),
    sessionStore: new PostgresSessionStore({pool}),
  };
}

async function withA2AStores<T>(
  options: A2ACliOptions,
  fn: (stores: A2AStores) => Promise<T>,
): Promise<T> {
  return withPostgresPool(options.dbUrl, async (pool) => {
    const stores = createA2AStores(pool);
    await ensureSchemas([
      stores.identityStore,
      stores.agentStore,
      stores.sessionStore,
      stores.bindings,
    ]);
    return fn(stores);
  });
}

async function resolveSessionId(stores: A2AStores, options: {
  sessionId?: string;
  agentKey?: string;
  label: string;
}): Promise<string> {
  const explicitSessionId = options.sessionId?.trim();
  const explicitAgentKey = options.agentKey?.trim();

  if (explicitSessionId && explicitAgentKey) {
    const session = await stores.sessionStore.getSession(explicitSessionId);
    if (session.agentKey !== explicitAgentKey) {
      throw new Error(`${options.label} session ${explicitSessionId} belongs to ${session.agentKey}, not ${explicitAgentKey}.`);
    }

    return session.id;
  }

  if (explicitSessionId) {
    return (await stores.sessionStore.getSession(explicitSessionId)).id;
  }

  if (explicitAgentKey) {
    const session = await stores.sessionStore.getMainSession(explicitAgentKey);
    if (!session) {
      throw new Error(`Agent ${explicitAgentKey} does not have a main session.`);
    }

    return session.id;
  }

  throw new Error(`${options.label} session is required. Pass a session id or agent key.`);
}

async function bindCommand(
  fromSessionId: string | undefined,
  toSessionId: string | undefined,
  options: BindA2ACliOptions,
): Promise<void> {
  await withA2AStores(options, async (stores) => {
    const senderSessionId = await resolveSessionId(stores, {
      sessionId: fromSessionId,
      agentKey: options.fromAgent,
      label: "Sender",
    });
    const recipientSessionId = await resolveSessionId(stores, {
      sessionId: toSessionId,
      agentKey: options.toAgent,
      label: "Recipient",
    });
    if (senderSessionId === recipientSessionId) {
      throw new Error("A2A bind does not allow the same sender and recipient session.");
    }

    await stores.bindings.bindSession({
      senderSessionId,
      recipientSessionId,
    });
    if (!options.oneWay) {
      await stores.bindings.bindSession({
        senderSessionId: recipientSessionId,
        recipientSessionId: senderSessionId,
      });
    }

    process.stdout.write(
      [
        `Bound A2A ${senderSessionId} -> ${recipientSessionId}.`,
        ...(!options.oneWay ? [`Bound A2A ${recipientSessionId} -> ${senderSessionId}.`] : []),
      ].join("\n") + "\n",
    );
  });
}

async function unbindCommand(
  fromSessionId: string | undefined,
  toSessionId: string | undefined,
  options: BindA2ACliOptions,
): Promise<void> {
  await withA2AStores(options, async (stores) => {
    const senderSessionId = await resolveSessionId(stores, {
      sessionId: fromSessionId,
      agentKey: options.fromAgent,
      label: "Sender",
    });
    const recipientSessionId = await resolveSessionId(stores, {
      sessionId: toSessionId,
      agentKey: options.toAgent,
      label: "Recipient",
    });

    const removedForward = await stores.bindings.deleteBinding({
      senderSessionId,
      recipientSessionId,
    });
    let removedReverse = false;
    if (!options.oneWay) {
      removedReverse = await stores.bindings.deleteBinding({
        senderSessionId: recipientSessionId,
        recipientSessionId: senderSessionId,
      });
    }

    process.stdout.write(
      [
        `${removedForward ? "Removed" : "Did not find"} A2A ${senderSessionId} -> ${recipientSessionId}.`,
        ...(!options.oneWay
          ? [`${removedReverse ? "Removed" : "Did not find"} A2A ${recipientSessionId} -> ${senderSessionId}.`]
          : []),
      ].join("\n") + "\n",
    );
  });
}

async function listCommand(options: ListA2ACliOptions): Promise<void> {
  await withA2AStores(options, async (stores) => {
    const senderSessionId = options.fromSession || options.fromAgent
      ? await resolveSessionId(stores, {
        sessionId: options.fromSession,
        agentKey: options.fromAgent,
        label: "Sender",
      })
      : undefined;
    const recipientSessionId = options.toSession || options.toAgent
      ? await resolveSessionId(stores, {
        sessionId: options.toSession,
        agentKey: options.toAgent,
        label: "Recipient",
      })
      : undefined;
    const bindings = await stores.bindings.listBindings({
      senderSessionId,
      recipientSessionId,
    });

    if (bindings.length === 0) {
      process.stdout.write("No A2A bindings.\n");
      return;
    }

    for (const binding of bindings) {
      process.stdout.write(
        [
          `${binding.senderSessionId} -> ${binding.recipientSessionId}`,
          `  updated ${new Date(binding.updatedAt).toISOString()}`,
        ].join("\n") + "\n\n",
      );
    }
  });
}

export function registerA2ACommands(program: Command): void {
  const a2aProgram = program
    .command("a2a")
    .description("Manage Panda A2A session bindings");

  a2aProgram
    .command("bind")
    .description("Allow two sessions to message each other")
    .argument("[fromSessionId]", "Sender session id", parseSessionIdOption)
    .argument("[toSessionId]", "Recipient session id", parseSessionIdOption)
    .option("--from-agent <agentKey>", "Resolve sender from an agent's main session", parseAgentKey)
    .option("--to-agent <agentKey>", "Resolve recipient from an agent's main session", parseAgentKey)
    .option("--one-way", "Create only sender -> recipient")
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((fromSessionId: string | undefined, toSessionId: string | undefined, options: BindA2ACliOptions) => {
      return bindCommand(fromSessionId, toSessionId, options);
    });

  a2aProgram
    .command("unbind")
    .description("Remove session-to-session A2A bindings")
    .argument("[fromSessionId]", "Sender session id", parseSessionIdOption)
    .argument("[toSessionId]", "Recipient session id", parseSessionIdOption)
    .option("--from-agent <agentKey>", "Resolve sender from an agent's main session", parseAgentKey)
    .option("--to-agent <agentKey>", "Resolve recipient from an agent's main session", parseAgentKey)
    .option("--one-way", "Remove only sender -> recipient")
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((fromSessionId: string | undefined, toSessionId: string | undefined, options: BindA2ACliOptions) => {
      return unbindCommand(fromSessionId, toSessionId, options);
    });

  a2aProgram
    .command("list")
    .description("List A2A bindings")
    .option("--from-session <sessionId>", "Filter by sender session", parseSessionIdOption)
    .option("--to-session <sessionId>", "Filter by recipient session", parseSessionIdOption)
    .option("--from-agent <agentKey>", "Filter by sender agent main session", parseAgentKey)
    .option("--to-agent <agentKey>", "Filter by recipient agent main session", parseAgentKey)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((options: ListA2ACliOptions) => {
      return listCommand(options);
    });
}
