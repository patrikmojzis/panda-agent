import process from "node:process";
import {createInterface} from "node:readline/promises";

import {Command} from "commander";

import {parseAgentKey} from "../agents/cli.js";
import {PostgresAgentStore} from "../agents/postgres.js";
import {withPostgresPool} from "../../app/runtime/postgres-bootstrap.js";
import {PostgresCredentialStore} from "./postgres.js";
import {CredentialService} from "./resolver.js";
import {resolveCredentialCrypto} from "./crypto.js";
import type {CredentialListEntry} from "./types.js";
import {maskCredentialValue} from "./types.js";

interface CredentialCliOptions {
  dbUrl?: string;
  agent?: string;
  stdin?: boolean;
}

async function readSecretFromPrompt(prompt: string): Promise<string> {
  const readline = createInterface(process.stdin, process.stdout);
  const originalWrite = (readline as unknown as {_writeToOutput?: (value: string) => void})._writeToOutput;
  (readline as unknown as {_writeToOutput?: (value: string) => void})._writeToOutput = (value: string) => {
    if (value === prompt || value.includes("\n")) {
      process.stdout.write(value);
    }
  };

  try {
    const value = await readline.question(prompt);
    process.stdout.write("\n");
    return value;
  } finally {
    (readline as unknown as {_writeToOutput?: (value: string) => void})._writeToOutput = originalWrite;
    readline.close();
  }
}

async function readSecretFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

async function withCredentialStores<T>(
  options: CredentialCliOptions,
  fn: (stores: {
    agentStore: PostgresAgentStore;
    credentialStore: PostgresCredentialStore;
  }) => Promise<T>,
): Promise<T> {
  return withPostgresPool(options.dbUrl, async (pool) => {
    const agentStore = new PostgresAgentStore({pool});
    const credentialStore = new PostgresCredentialStore({pool});

    await agentStore.ensureAgentTableSchema();
    await credentialStore.ensureSchema();
    return await fn({agentStore, credentialStore});
  });
}

async function withCredentialService<T>(
  options: CredentialCliOptions,
  fn: (stores: {
    agentStore: PostgresAgentStore;
    credentialService: CredentialService;
  }) => Promise<T>,
): Promise<T> {
  return withCredentialStores(options, async ({agentStore, credentialStore}) => {
    const crypto = resolveCredentialCrypto();
    if (!crypto) {
      throw new Error("CREDENTIALS_MASTER_KEY is required for credential commands.");
    }

    const credentialService = new CredentialService({
      store: credentialStore,
      crypto,
    });

    return fn({agentStore, credentialService});
  });
}

async function resolveAgentOption(
  options: CredentialCliOptions,
  agentStore: PostgresAgentStore,
  mode: "required" | "optional",
): Promise<{agentKey: string} | null> {
  const agentKey = options.agent?.trim();

  if (!agentKey) {
    if (mode === "optional") {
      return null;
    }

    throw new Error("Pick an agent with --agent.");
  }

  return {
    agentKey: (await agentStore.getAgent(agentKey)).agentKey,
  };
}

function renderCredentialEntry(entry: CredentialListEntry): string {
  return [
    entry.envKey,
    `  agent ${entry.agentKey}`,
    `  value ${entry.valuePreview}`,
    `  updated ${new Date(entry.updatedAt).toISOString()}`,
  ].join("\n");
}

async function readCredentialValue(value: string | undefined, stdin: boolean | undefined): Promise<string> {
  if (stdin) {
    if (value !== undefined) {
      throw new Error("Pick one input path: positional value or --stdin.");
    }

    const piped = await readSecretFromStdin();
    if (!piped) {
      throw new Error("stdin did not provide a credential value.");
    }

    return piped;
  }

  if (value !== undefined) {
    return value;
  }

  if (!process.stdin.isTTY) {
    throw new Error("Pass a value, use --stdin, or run interactively for a hidden prompt.");
  }

  const prompted = await readSecretFromPrompt("Credential value: ");
  if (!prompted) {
    throw new Error("Credential value must not be empty.");
  }

  return prompted;
}

export async function setCredentialCommand(
  envKey: string,
  value: string | undefined,
  options: CredentialCliOptions,
): Promise<void> {
  await withCredentialService(options, async ({agentStore, credentialService}) => {
    const agent = await resolveAgentOption(options, agentStore, "required");
    if (!agent) {
      throw new Error("Missing credential agent.");
    }

    const stored = await credentialService.setCredential({
      envKey,
      value: await readCredentialValue(value, options.stdin),
      agentKey: agent.agentKey,
    });

    process.stdout.write(
      [
        `Stored ${stored.envKey}.`,
        `agent ${stored.agentKey}`,
        `value ${maskCredentialValue(stored.value)}`,
      ].join("\n") + "\n",
    );
  });
}

export async function clearCredentialCommand(
  envKey: string,
  options: CredentialCliOptions,
): Promise<void> {
  await withCredentialStores(options, async ({agentStore, credentialStore}) => {
    const agent = await resolveAgentOption(options, agentStore, "required");
    if (!agent) {
      throw new Error("Missing credential agent.");
    }

    const deleted = await credentialStore.deleteCredential(
      envKey,
      agent,
    );

    process.stdout.write(
      [
        deleted ? `Cleared ${envKey}.` : `No credential cleared for ${envKey}.`,
        `agent ${agent.agentKey}`,
      ].join("\n") + "\n",
    );
  });
}

export async function listCredentialsCommand(options: CredentialCliOptions): Promise<void> {
  await withCredentialService(options, async ({agentStore, credentialService}) => {
    const agent = await resolveAgentOption(options, agentStore, "optional");
    const entries = await credentialService.listCredentials(agent ?? {});

    if (entries.length === 0) {
      process.stdout.write("No credentials yet.\n");
      return;
    }

    process.stdout.write(entries.map((entry) => renderCredentialEntry(entry)).join("\n\n") + "\n");
  });
}

export async function resolveCredentialCommand(
  envKey: string,
  options: CredentialCliOptions,
): Promise<void> {
  await withCredentialService(options, async ({agentStore, credentialService}) => {
    const agent = await resolveAgentOption(options, agentStore, "required");
    if (!agent) {
      throw new Error("Missing credential agent.");
    }

    const resolved = await credentialService.resolveCredential(envKey, {
      agentKey: agent.agentKey,
    });

    if (!resolved) {
      process.stdout.write(
        [
          `No stored credential matched ${envKey}.`,
          "Note: local bash may still fall back to Panda process env.",
        ].join("\n") + "\n",
      );
      return;
    }

    process.stdout.write(
      [
        `Stored winner for ${resolved.envKey}.`,
        `agent ${resolved.agentKey}`,
        `value ${resolved.valuePreview}`,
        "Note: this inspects stored credentials only.",
      ].join("\n") + "\n",
    );
  });
}

export function registerCredentialCommands(program: Command): void {
  const credentialProgram = program
    .command("credentials")
    .description("Manage stored env credentials for Panda bash");

  credentialProgram
    .command("set")
    .description("Store a credential for an agent")
    .argument("<envKey>", "Shell env key")
    .argument("[value]", "Credential value. Prefer --stdin or the hidden prompt.")
    .option("--agent <agentKey>", "Which persona should receive it", parseAgentKey)
    .option("--stdin", "Read the credential value from stdin")
    .option("--db-url <url>", "Postgres connection string for credential persistence")
    .action((envKey: string, value: string | undefined, options: CredentialCliOptions) => {
      return setCredentialCommand(envKey, value, options);
    });

  credentialProgram
    .command("clear")
    .description("Delete an agent credential")
    .argument("<envKey>", "Shell env key")
    .option("--agent <agentKey>", "Which persona should lose it", parseAgentKey)
    .option("--db-url <url>", "Postgres connection string for credential persistence")
    .action((envKey: string, options: CredentialCliOptions) => {
      return clearCredentialCommand(envKey, options);
    });

  credentialProgram
    .command("list")
    .description("List stored credentials, optionally narrowed to one agent")
    .option("--agent <agentKey>", "Filter to one persona", parseAgentKey)
    .option("--db-url <url>", "Postgres connection string for credential persistence")
    .action((options: CredentialCliOptions) => {
      return listCredentialsCommand(options);
    });

  credentialProgram
    .command("resolve")
    .description("Show which stored credential wins in the credentials store")
    .argument("<envKey>", "Shell env key")
    .option("--agent <agentKey>", "Persona context", parseAgentKey)
    .option("--db-url <url>", "Postgres connection string for credential persistence")
    .action((envKey: string, options: CredentialCliOptions) => {
      return resolveCredentialCommand(envKey, options);
    });
}
