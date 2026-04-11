import process from "node:process";
import {mkdir} from "node:fs/promises";

import {Command, InvalidArgumentError} from "commander";

import {PostgresIdentityStore} from "../identity/postgres.js";
import {createPandaPool, requirePandaDatabaseUrl} from "../../app/runtime/create-runtime.js";
import {resolvePandaAgentDir} from "../../app/runtime/data-dir.js";
import {PostgresAgentStore} from "./postgres.js";
import {DEFAULT_AGENT_DOCUMENT_TEMPLATES} from "./templates.js";
import {normalizeAgentKey} from "./types.js";

interface AgentCliOptions {
  dbUrl?: string;
}

interface CreateAgentCliOptions extends AgentCliOptions {
  name?: string;
}

async function withAgentStore<T>(
  options: AgentCliOptions,
  fn: (store: PostgresAgentStore) => Promise<T>,
): Promise<T> {
  const pool = createPandaPool(requirePandaDatabaseUrl(options.dbUrl));
  const identityStore = new PostgresIdentityStore({ pool });
  const store = new PostgresAgentStore({ pool });

  try {
    await identityStore.ensureSchema();
    await store.ensureSchema();
    return await fn(store);
  } finally {
    await pool.end();
  }
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

export async function listAgentsCommand(options: AgentCliOptions): Promise<void> {
  await withAgentStore(options, async (store) => {
    const agents = await store.listAgents();

    if (agents.length === 0) {
      process.stdout.write("No agents yet.\n");
      return;
    }

    for (const agent of agents) {
      process.stdout.write(
        [
          agent.agentKey,
          `  name ${agent.displayName} · status ${agent.status} · created ${new Date(agent.createdAt).toISOString()}`,
        ].join("\n") + "\n\n",
      );
    }
  });
}

export async function createAgentCommand(agentKey: string, options: CreateAgentCliOptions): Promise<void> {
  await withAgentStore(options, async (store) => {
    const created = await store.bootstrapAgent({
      agentKey,
      displayName: options.name?.trim() || agentKey,
      documents: DEFAULT_AGENT_DOCUMENT_TEMPLATES,
    });
    await mkdir(resolvePandaAgentDir(created.agentKey), { recursive: true });

    process.stdout.write(
      [
        `Created agent ${created.agentKey}.`,
        `name ${created.displayName}`,
        `home ${resolvePandaAgentDir(created.agentKey)}`,
        `next: panda identity create <handle> --agent ${created.agentKey}`,
        `or:   panda identity switch-home-agent <handle> ${created.agentKey}`,
      ].join("\n") + "\n",
    );
  });
}

export function registerAgentCommands(program: Command): void {
  const agentProgram = program
    .command("agent")
    .description("Manage Panda agents");

  agentProgram
    .command("list")
    .description("List stored Panda agents")
    .option("--db-url <url>", "Postgres connection string for thread persistence")
    .action((options: AgentCliOptions) => {
      return listAgentsCommand(options);
    });

  agentProgram
    .command("create")
    .description("Create a Panda agent")
    .argument("<agentKey>", "Agent key", parseAgentKey)
    .option("--name <displayName>", "Display name to show in UIs")
    .option("--db-url <url>", "Postgres connection string for thread persistence")
    .action((agentKey: string, options: CreateAgentCliOptions) => {
      return createAgentCommand(agentKey, options);
    });
}
