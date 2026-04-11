import {randomUUID} from "node:crypto";
import process from "node:process";

import {Command, InvalidArgumentError} from "commander";

import {parseAgentKey} from "../agents/cli.js";
import {type HomeThreadRecord, PostgresHomeThreadStore} from "../../domain/threads/home/index.js";
import {createPandaClient} from "../../app/runtime/client.js";
import {PostgresAgentStore} from "../agents/postgres.js";
import {createPandaPool, requirePandaDatabaseUrl} from "../../app/runtime/create-runtime.js";
import {PostgresIdentityStore} from "./postgres.js";
import {DEFAULT_IDENTITY_HANDLE, type IdentityRecord, normalizeIdentityHandle} from "./types.js";

interface IdentityCliOptions {
  dbUrl?: string;
}

interface CreateIdentityCliOptions extends IdentityCliOptions {
  name?: string;
  agent?: string;
}

interface SetDefaultAgentCliOptions extends IdentityCliOptions {}
interface SwitchHomeAgentCliOptions extends IdentityCliOptions {}
interface HeartbeatCliOptions extends IdentityCliOptions {
  enable?: boolean;
  disable?: boolean;
  every?: number;
}

async function withIdentityStores<T>(
  options: IdentityCliOptions,
  fn: (stores: {
    identityStore: PostgresIdentityStore;
    agentStore: PostgresAgentStore;
    homeThreadStore: PostgresHomeThreadStore;
  }) => Promise<T>,
): Promise<T> {
  const pool = createPandaPool(requirePandaDatabaseUrl(options.dbUrl));
  const identityStore = new PostgresIdentityStore({pool});
  const agentStore = new PostgresAgentStore({pool});
  const homeThreadStore = new PostgresHomeThreadStore({pool});

  try {
    await identityStore.ensureSchema();
    await agentStore.ensureSchema();
    await homeThreadStore.ensureSchema();
    return await fn({identityStore, agentStore, homeThreadStore});
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

function parseHeartbeatEveryMinutes(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError("Heartbeat interval must be a positive integer number of minutes.");
  }

  return parsed;
}

async function resolveIdentity(
  identityStore: PostgresIdentityStore,
  handle: string,
): Promise<IdentityRecord> {
  return handle === DEFAULT_IDENTITY_HANDLE
    ? identityStore.getIdentity(DEFAULT_IDENTITY_HANDLE)
    : identityStore.getIdentityByHandle(handle);
}

function formatTimestamp(value: number | undefined): string {
  return value === undefined ? "-" : new Date(value).toISOString();
}

function renderHeartbeatSummary(handle: string, home: HomeThreadRecord): string {
  return [
    `Heartbeat for ${handle}.`,
    `home thread ${home.threadId}`,
    `enabled ${home.heartbeat.enabled ? "yes" : "no"}`,
    `every ${home.heartbeat.everyMinutes} minutes`,
    `next fire ${home.heartbeat.enabled ? formatTimestamp(home.heartbeat.nextFireAt) : "-"}`,
    `last fire ${formatTimestamp(home.heartbeat.lastFireAt)}`,
    `last skip ${home.heartbeat.lastSkipReason ?? "-"}`,
  ].join("\n");
}

async function listIdentitiesCommand(options: IdentityCliOptions): Promise<void> {
  await withIdentityStores(options, async ({identityStore}) => {
    const identities = await identityStore.listIdentities();

    if (identities.length === 0) {
      process.stdout.write("No identities yet.\n");
      return;
    }

    for (const identity of identities) {
      process.stdout.write(
        [
          identity.handle,
          `  id ${identity.id} · status ${identity.status} · default agent ${identity.defaultAgentKey ?? "-"}`,
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
  await withIdentityStores(options, async ({identityStore, agentStore}) => {
    const defaultAgentKey = options.agent?.trim() || undefined;
    if (defaultAgentKey) {
      await agentStore.getAgent(defaultAgentKey);
    }

    const identity = await identityStore.createIdentity({
      id: randomUUID(),
      handle,
      displayName: options.name?.trim() || handle,
      defaultAgentKey,
    });

    process.stdout.write(
      [
        `Created identity ${identity.handle}.`,
        `id ${identity.id}`,
        `default agent ${identity.defaultAgentKey ?? "-"}`,
      ].join("\n") + "\n",
    );
  });
}

async function setDefaultAgentCommand(
  handle: string,
  agentKey: string,
  options: SetDefaultAgentCliOptions,
): Promise<void> {
  await withIdentityStores(options, async ({identityStore, agentStore}) => {
    await agentStore.getAgent(agentKey);
    const identity = await resolveIdentity(identityStore, handle);
    const updated = await identityStore.updateIdentity({
      identityId: identity.id,
      defaultAgentKey: agentKey,
    });

    process.stdout.write(
      [
        `Updated identity ${updated.handle}.`,
        `default agent ${updated.defaultAgentKey ?? "-"}`,
        "current home unchanged",
      ].join("\n") + "\n",
    );
  });
}

async function switchHomeAgentCommand(
  handle: string,
  agentKey: string,
  options: SwitchHomeAgentCliOptions,
): Promise<void> {
  await withIdentityStores(options, async ({identityStore, agentStore}) => {
    await agentStore.getAgent(agentKey);
    const identity = await resolveIdentity(identityStore, handle);

    const client = await createPandaClient({
      identity: identity.handle,
      dbUrl: options.dbUrl,
    });

    try {
      const result = await client.switchHomeAgent(agentKey);
      process.stdout.write(
        [
          `Switched identity ${identity.handle} to agent ${result.thread.agentKey}.`,
          `new home ${result.thread.id}`,
          `previous home ${result.previousThreadId ?? "-"}`,
        ].join("\n") + "\n",
      );
    } finally {
      await client.close();
    }
  });
}

async function heartbeatCommand(
  handle: string,
  options: HeartbeatCliOptions,
): Promise<void> {
  if (options.enable && options.disable) {
    throw new Error("Pick one: --enable or --disable.");
  }

  await withIdentityStores(options, async ({identityStore, homeThreadStore}) => {
    const identity = await resolveIdentity(identityStore, handle);
    const home = await homeThreadStore.resolveHomeThread({
      identityId: identity.id,
    });
    if (!home) {
      throw new Error(`Identity ${identity.handle} has no home thread yet.`);
    }

    const shouldUpdate = options.enable || options.disable || options.every !== undefined;
    const current = shouldUpdate
      ? await homeThreadStore.updateHeartbeatConfig({
        identityId: identity.id,
        enabled: options.disable ? false : options.enable ? true : undefined,
        everyMinutes: options.every,
      })
      : home;

    const summary = renderHeartbeatSummary(identity.handle, current).split("\n");
    if (shouldUpdate) {
      summary[0] = `Updated heartbeat for ${identity.handle}.`;
    }

    process.stdout.write(summary.join("\n") + "\n");
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
    .option("--agent <agentKey>", "Default agent for new home threads", parseAgentKey)
    .option("--db-url <url>", "Postgres connection string for thread persistence")
    .action((handle: string, options: CreateIdentityCliOptions) => {
      return createIdentityCommand(handle, options);
    });

  identityProgram
    .command("set-default-agent")
    .description("Set the default agent for future home threads without replacing the current home")
    .argument("<handle>", "Identity handle", parseIdentityHandle)
    .argument("<agentKey>", "Agent key", parseAgentKey)
    .option("--db-url <url>", "Postgres connection string for thread persistence")
    .action((handle: string, agentKey: string, options: SetDefaultAgentCliOptions) => {
      return setDefaultAgentCommand(handle, agentKey, options);
    });

  identityProgram
    .command("switch-home-agent")
    .description("Replace an identity's current home thread with a fresh home on another agent")
    .argument("<handle>", "Identity handle", parseIdentityHandle)
    .argument("<agentKey>", "Agent key", parseAgentKey)
    .option("--db-url <url>", "Postgres connection string for thread persistence")
    .action((handle: string, agentKey: string, options: SwitchHomeAgentCliOptions) => {
      return switchHomeAgentCommand(handle, agentKey, options);
    });

  identityProgram
    .command("heartbeat")
    .description("Inspect or update an identity's home-thread heartbeat")
    .argument("<handle>", "Identity handle", parseIdentityHandle)
    .option("--enable", "Enable heartbeat")
    .option("--disable", "Disable heartbeat")
    .option("--every <minutes>", "Set the heartbeat interval in minutes", parseHeartbeatEveryMinutes)
    .option("--db-url <url>", "Postgres connection string for thread persistence")
    .action((handle: string, options: HeartbeatCliOptions) => {
      return heartbeatCommand(handle, options);
    });
}
