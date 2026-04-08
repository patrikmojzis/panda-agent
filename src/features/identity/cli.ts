import process from "node:process";

import { Command, InvalidArgumentError } from "commander";

import { createIdentityRuntime } from "./runtime.js";

interface IdentityCliOptions {
  dbUrl?: string;
}

interface CreateIdentityCliOptions extends IdentityCliOptions {
  name?: string;
}

async function withIdentityRuntime<T>(
  options: IdentityCliOptions,
  fn: (runtime: Awaited<ReturnType<typeof createIdentityRuntime>>) => Promise<T>,
): Promise<T> {
  const runtime = await createIdentityRuntime({
    dbUrl: options.dbUrl,
  });

  try {
    return await fn(runtime);
  } finally {
    await runtime.close();
  }
}

export function parseIdentityHandle(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    throw new InvalidArgumentError("Identity handle must not be empty.");
  }

  if (!/^[a-z0-9][a-z0-9_-]*$/.test(trimmed)) {
    throw new InvalidArgumentError("Identity handle must use lowercase letters, numbers, hyphens, or underscores.");
  }

  return trimmed;
}

export async function listIdentitiesCommand(options: IdentityCliOptions): Promise<void> {
  await withIdentityRuntime(options, async (runtime) => {
    const identities = await runtime.store.listIdentities();

    if (identities.length === 0) {
      process.stdout.write("No identities yet.\n");
      return;
    }

    for (const identity of identities) {
      process.stdout.write(
        [
          identity.handle,
          `  id ${identity.id} · status ${identity.status} · created ${new Date(identity.createdAt).toISOString()}`,
        ].join("\n") + "\n\n",
      );
    }
  });
}

export async function createIdentityCommand(
  handle: string,
  options: CreateIdentityCliOptions,
): Promise<void> {
  await withIdentityRuntime(options, async (runtime) => {
    const identity = await runtime.store.createIdentity({
      id: handle,
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
    .option("--db-url <url>", "Postgres connection string for thread persistence")
    .action((options: IdentityCliOptions) => {
      return listIdentitiesCommand(options);
    });

  identityProgram
    .command("create")
    .description("Create a Panda identity")
    .argument("<handle>", "Identity handle", parseIdentityHandle)
    .option("--name <displayName>", "Display name to show in UIs")
    .option("--db-url <url>", "Postgres connection string for thread persistence")
    .action((handle: string, options: CreateIdentityCliOptions) => {
      return createIdentityCommand(handle, options);
    });
}
