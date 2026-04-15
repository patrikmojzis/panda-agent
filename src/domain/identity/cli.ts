import {randomUUID} from "node:crypto";
import process from "node:process";

import {Command, InvalidArgumentError} from "commander";

import {PANDA_DB_URL_OPTION_DESCRIPTION} from "../../app/cli-shared.js";
import {createPandaPool, requirePandaDatabaseUrl} from "../../app/runtime/create-runtime.js";
import {PostgresIdentityStore} from "./postgres.js";
import {normalizeIdentityHandle} from "./types.js";

interface IdentityCliOptions {
  dbUrl?: string;
}

interface CreateIdentityCliOptions extends IdentityCliOptions {
  name?: string;
}

async function withIdentityStore<T>(
  options: IdentityCliOptions,
  fn: (store: PostgresIdentityStore) => Promise<T>,
): Promise<T> {
  const pool = createPandaPool(requirePandaDatabaseUrl(options.dbUrl));
  const store = new PostgresIdentityStore({pool});

  try {
    await store.ensureSchema();
    return await fn(store);
  } finally {
    await pool.end();
  }
}

export function parseIdentityHandle(value: string): string {
  try {
    return normalizeIdentityHandle(value);
  } catch (error) {
    if (error instanceof Error) {
      throw new InvalidArgumentError(error.message);
    }

    throw error;
  }
}

async function listIdentitiesCommand(options: IdentityCliOptions): Promise<void> {
  await withIdentityStore(options, async (store) => {
    const identities = await store.listIdentities();
    if (identities.length === 0) {
      process.stdout.write("No identities yet.\n");
      return;
    }

    for (const identity of identities) {
      process.stdout.write(
        [
          identity.handle,
          `  id ${identity.id} · status ${identity.status}`,
          `  created ${new Date(identity.createdAt).toISOString()}`,
        ].join("\n") + "\n\n",
      );
    }
  });
}

async function createIdentityCommand(
  handle: string,
  options: CreateIdentityCliOptions,
): Promise<void> {
  await withIdentityStore(options, async (store) => {
    const identity = await store.createIdentity({
      id: randomUUID(),
      handle,
      displayName: options.name?.trim() || handle,
    });

    process.stdout.write(
      [
        `Created identity ${identity.handle}.`,
        `id ${identity.id}`,
      ].join("\n") + "\n",
    );
  });
}

export function registerIdentityCommands(program: Command): void {
  const identityProgram = program
    .command("identity")
    .description("Manage Panda identities");

  identityProgram
    .command("list")
    .description("List stored Panda identities")
    .option("--db-url <url>", PANDA_DB_URL_OPTION_DESCRIPTION)
    .action((options: IdentityCliOptions) => {
      return listIdentitiesCommand(options);
    });

  identityProgram
    .command("create")
    .description("Create a Panda identity")
    .argument("<handle>", "Identity handle", parseIdentityHandle)
    .option("--name <displayName>", "Display name to show in UIs")
    .option("--db-url <url>", PANDA_DB_URL_OPTION_DESCRIPTION)
    .action((handle: string, options: CreateIdentityCliOptions) => {
      return createIdentityCommand(handle, options);
    });
}
