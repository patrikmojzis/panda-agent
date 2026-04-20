import process from "node:process";

import {Command, InvalidArgumentError} from "commander";

import {DB_URL_OPTION_DESCRIPTION} from "../../app/cli-shared.js";
import {ensureSchemas, withPostgresPool} from "../../app/runtime/postgres-bootstrap.js";
import {parseAgentKey} from "../agents/cli.js";
import {PostgresAgentStore} from "../agents/postgres.js";
import {resolveCredentialCrypto} from "../credentials/index.js";
import {PostgresWikiBindingStore} from "./postgres.js";
import {WikiBindingService} from "./service.js";
import {normalizeWikiNamespacePath} from "./types.js";

interface WikiCliOptions {
  dbUrl?: string;
  groupId?: number;
  namespace?: string;
  stdin?: boolean;
}

function parseWikiGroupId(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError("Wiki group id must be a positive integer.");
  }

  return parsed;
}

function parseWikiNamespacePath(value: string): string {
  try {
    return normalizeWikiNamespacePath(value);
  } catch (error) {
    if (error instanceof Error) {
      throw new InvalidArgumentError(error.message);
    }

    throw error;
  }
}

async function readToken(value: string | undefined, stdin: boolean | undefined): Promise<string> {
  if (stdin) {
    if (value !== undefined) {
      throw new Error("Pick one token input path: positional value or --stdin.");
    }

    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const token = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
    if (!token) {
      throw new Error("stdin did not provide a wiki API token.");
    }

    return token;
  }

  if (value?.trim()) {
    return value;
  }

  throw new Error("Pass the wiki API token as an argument or pipe it with --stdin.");
}

async function withWikiBindingStores<T>(
  options: WikiCliOptions,
  fn: (stores: {
    agentStore: PostgresAgentStore;
    wikiBindingStore: PostgresWikiBindingStore;
  }) => Promise<T>,
): Promise<T> {
  return withPostgresPool(options.dbUrl, async (pool) => {
    const agentStore = new PostgresAgentStore({pool});
    const wikiBindingStore = new PostgresWikiBindingStore({pool});
    await ensureSchemas([agentStore, wikiBindingStore]);
    return fn({agentStore, wikiBindingStore});
  });
}

async function withWikiBindingService<T>(
  options: WikiCliOptions,
  fn: (stores: {
    agentStore: PostgresAgentStore;
    wikiBindingService: WikiBindingService;
  }) => Promise<T>,
): Promise<T> {
  return withWikiBindingStores(options, async ({agentStore, wikiBindingStore}) => {
    const crypto = resolveCredentialCrypto();
    if (!crypto) {
      throw new Error("CREDENTIALS_MASTER_KEY is required for wiki binding commands.");
    }

    return fn({
      agentStore,
      wikiBindingService: new WikiBindingService({
        store: wikiBindingStore,
        crypto,
      }),
    });
  });
}

async function setWikiBindingCommand(
  agentKey: string,
  apiToken: string | undefined,
  options: WikiCliOptions,
): Promise<void> {
  await withWikiBindingService(options, async ({agentStore, wikiBindingService}) => {
    if (options.groupId === undefined || options.namespace === undefined) {
      throw new Error("Wiki binding set requires both --group-id and --namespace.");
    }

    const agent = await agentStore.getAgent(agentKey);
    const stored = await wikiBindingService.setBinding({
      agentKey: agent.agentKey,
      wikiGroupId: options.groupId,
      namespacePath: options.namespace,
      apiToken: await readToken(apiToken, options.stdin),
    });

    process.stdout.write(
      [
        `Stored wiki binding for ${stored.agentKey}.`,
        `group ${stored.wikiGroupId}`,
        `namespace ${stored.namespacePath}`,
        `updated ${new Date(stored.updatedAt).toISOString()}`,
      ].join("\n") + "\n",
    );
  });
}

async function showWikiBindingCommand(agentKey: string, options: WikiCliOptions): Promise<void> {
  await withWikiBindingStores(options, async ({agentStore, wikiBindingStore}) => {
    const agent = await agentStore.getAgent(agentKey);
    const binding = await wikiBindingStore.getBinding(agent.agentKey);
    if (!binding) {
      process.stdout.write(`No wiki binding stored for ${agent.agentKey}.\n`);
      return;
    }

    process.stdout.write(
      [
        `Wiki binding for ${binding.agentKey}.`,
        `group ${binding.wikiGroupId}`,
        `namespace ${binding.namespacePath}`,
        `updated ${new Date(binding.updatedAt).toISOString()}`,
      ].join("\n") + "\n",
    );
  });
}

async function clearWikiBindingCommand(agentKey: string, options: WikiCliOptions): Promise<void> {
  await withWikiBindingStores(options, async ({agentStore, wikiBindingStore}) => {
    const agent = await agentStore.getAgent(agentKey);
    const deleted = await wikiBindingStore.deleteBinding(agent.agentKey);
    process.stdout.write(
      `${deleted ? "Cleared" : "No"} wiki binding for ${agent.agentKey}.\n`,
    );
  });
}

export function registerWikiCommands(program: Command): void {
  const wikiProgram = program
    .command("wiki")
    .description("Manage Panda Wiki.js bindings");

  const bindingProgram = wikiProgram
    .command("binding")
    .description("Manage the built-in Wiki.js token binding per agent");

  bindingProgram
    .command("set")
    .description("Create or update one agent's Wiki.js binding")
    .argument("<agentKey>", "Agent key", parseAgentKey)
    .argument("[apiToken]", "Wiki.js API token")
    .requiredOption("--group-id <id>", "Wiki.js group id", parseWikiGroupId)
    .requiredOption(
      "--namespace <path>",
      "Namespace path, for example agents/panda",
      parseWikiNamespacePath,
    )
    .option("--stdin", "Read the Wiki.js API token from stdin")
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((agentKey: string, apiToken: string | undefined, options: WikiCliOptions) => {
      return setWikiBindingCommand(agentKey, apiToken, options);
    });

  bindingProgram
    .command("show")
    .description("Show one agent's Wiki.js binding metadata")
    .argument("<agentKey>", "Agent key", parseAgentKey)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((agentKey: string, options: WikiCliOptions) => {
      return showWikiBindingCommand(agentKey, options);
    });

  bindingProgram
    .command("clear")
    .description("Delete one agent's Wiki.js binding")
    .argument("<agentKey>", "Agent key", parseAgentKey)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((agentKey: string, options: WikiCliOptions) => {
      return clearWikiBindingCommand(agentKey, options);
    });
}
