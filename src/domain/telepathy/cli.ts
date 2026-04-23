import process from "node:process";

import {Command} from "commander";

import {DB_URL_OPTION_DESCRIPTION} from "../../app/cli-shared.js";
import {ensureSchemas, withPostgresPool} from "../../app/runtime/postgres-bootstrap.js";
import {parseAgentKey} from "../agents/cli.js";
import {PostgresAgentStore} from "../agents/postgres.js";
import {PostgresIdentityStore} from "../identity/postgres.js";
import {generateTelepathyToken, hashTelepathyToken} from "./crypto.js";
import {PostgresTelepathyDeviceStore} from "./postgres.js";

interface TelepathyCliOptions {
  dbUrl?: string;
  agent?: string;
  label?: string;
}

async function withTelepathyStores<T>(
  options: TelepathyCliOptions,
  fn: (stores: {
    agentStore: PostgresAgentStore;
    telepathyStore: PostgresTelepathyDeviceStore;
  }) => Promise<T>,
): Promise<T> {
  return withPostgresPool(options.dbUrl, async (pool) => {
    const identityStore = new PostgresIdentityStore({pool});
    const agentStore = new PostgresAgentStore({pool});
    const telepathyStore = new PostgresTelepathyDeviceStore({pool});
    await ensureSchemas([identityStore, agentStore, telepathyStore]);
    return await fn({agentStore, telepathyStore});
  });
}

async function registerDeviceCommand(
  deviceId: string,
  options: TelepathyCliOptions,
): Promise<void> {
  const agentKey = options.agent?.trim();
  if (!agentKey) {
    throw new Error("Use --agent to choose which Panda agent owns the device.");
  }

  await withTelepathyStores(options, async ({agentStore, telepathyStore}) => {
    await agentStore.getAgent(agentKey);
    const token = generateTelepathyToken();
    const device = await telepathyStore.registerDevice({
      agentKey,
      deviceId,
      label: options.label,
      tokenHash: hashTelepathyToken(token),
    });

    process.stdout.write([
      `Registered telepathy device ${device.deviceId} for agent ${device.agentKey}.`,
      ...(device.label ? [`label ${device.label}`] : []),
      `token ${token}`,
      "Paste that token into Panda Telepathy settings.",
    ].join("\n") + "\n");
  });
}

async function listDevicesCommand(options: TelepathyCliOptions): Promise<void> {
  const agentKey = options.agent?.trim();
  if (!agentKey) {
    throw new Error("Use --agent to choose which Panda agent to inspect.");
  }

  await withTelepathyStores(options, async ({agentStore, telepathyStore}) => {
    await agentStore.getAgent(agentKey);
    const devices = await telepathyStore.listDevices(agentKey);
    if (devices.length === 0) {
      process.stdout.write(`No telepathy devices registered for agent ${agentKey}.\n`);
      return;
    }

    for (const device of devices) {
      process.stdout.write([
        device.deviceId,
        ...(device.label ? [`  label ${device.label}`] : []),
        `  enabled ${device.enabled}`,
        `  connected ${device.connected}`,
        ...(device.connectedAt ? [`  connected ${new Date(device.connectedAt).toISOString()}`] : []),
        ...(device.lastSeenAt ? [`  last_seen ${new Date(device.lastSeenAt).toISOString()}`] : []),
        ...(device.lastDisconnectedAt ? [`  last_disconnected ${new Date(device.lastDisconnectedAt).toISOString()}`] : []),
      ].join("\n") + "\n");
    }
  });
}

async function setEnabledCommand(
  deviceId: string,
  enabled: boolean,
  options: TelepathyCliOptions,
): Promise<void> {
  const agentKey = options.agent?.trim();
  if (!agentKey) {
    throw new Error("Use --agent to choose which Panda agent owns the device.");
  }

  await withTelepathyStores(options, async ({agentStore, telepathyStore}) => {
    await agentStore.getAgent(agentKey);
    const device = await telepathyStore.setDeviceEnabled(agentKey, deviceId, enabled);
    process.stdout.write([
      `${enabled ? "Enabled" : "Disabled"} telepathy device ${device.deviceId}.`,
      `agent ${device.agentKey}`,
      `connected ${device.connected}`,
    ].join("\n") + "\n");
  });
}

export function registerTelepathyCommands(program: Command): void {
  const telepathy = program
    .command("telepathy")
    .description("Manage telepathy device registration and pairing tokens");

  telepathy
    .command("register <deviceId>")
    .description("Create or rotate a per-device telepathy token")
    .requiredOption("--agent <agentKey>", "Agent key that owns the device", parseAgentKey)
    .option("--label <label>", "Human label for the device")
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((deviceId: string, options: TelepathyCliOptions) => registerDeviceCommand(deviceId, options));

  telepathy
    .command("list")
    .description("List registered telepathy devices for one agent")
    .requiredOption("--agent <agentKey>", "Agent key to inspect", parseAgentKey)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((options: TelepathyCliOptions) => listDevicesCommand(options));

  telepathy
    .command("disable <deviceId>")
    .description("Disable a telepathy device immediately")
    .requiredOption("--agent <agentKey>", "Agent key that owns the device", parseAgentKey)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((deviceId: string, options: TelepathyCliOptions) => setEnabledCommand(deviceId, false, options));

  telepathy
    .command("enable <deviceId>")
    .description("Re-enable a telepathy device")
    .requiredOption("--agent <agentKey>", "Agent key that owns the device", parseAgentKey)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((deviceId: string, options: TelepathyCliOptions) => setEnabledCommand(deviceId, true, options));
}
