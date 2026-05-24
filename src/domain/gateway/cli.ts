import process from "node:process";

import {Command, InvalidArgumentError} from "commander";

import {DB_URL_OPTION_DESCRIPTION, parsePositiveIntegerOption} from "../../lib/cli.js";
import {generateOpaqueToken, hashOpaqueToken} from "../../lib/opaque-tokens.js";
import {ensureSchemas, withPostgresPool} from "../../lib/postgres-bootstrap.js";
import {parseAgentKey, ensureAgent} from "../agents/cli.js";
import {PostgresAgentStore} from "../agents/postgres.js";
import {parseIdentityHandle} from "../identity/cli.js";
import {PostgresIdentityStore} from "../identity/postgres.js";
import {PostgresSessionStore} from "../sessions/postgres.js";
import {PostgresThreadRuntimeStore} from "../threads/runtime/postgres.js";
import {PostgresGatewayStore} from "./postgres.js";
import {normalizeGatewayDeviceId, normalizeGatewaySourceId} from "./postgres-rows.js";
import type {GatewayDeliveryMode, GatewayDeviceCapability} from "./types.js";

interface GatewayCliOptions {
  dbUrl?: string;
}

interface GatewaySourceCreateOptions extends GatewayCliOptions {
  agent: string;
  identity: string;
  name?: string;
  session?: string;
}

interface GatewayAllowTypeOptions extends GatewayCliOptions {
  delivery?: GatewayDeliveryMode;
}

interface GatewayEventListOptions extends GatewayCliOptions {
  limit?: number;
  source?: string;
}

interface GatewayAttachmentScrubOptions extends GatewayCliOptions {
  limit?: number;
}

interface GatewayDeviceRegisterOptions extends GatewayCliOptions {
  label?: string;
  capability?: string[];
}

function parseDelivery(value: string): GatewayDeliveryMode {
  if (value !== "queue" && value !== "wake") {
    throw new InvalidArgumentError("Delivery must be queue or wake.");
  }
  return value;
}

const GATEWAY_DEVICE_TOKEN_PREFIX = "pgd";
const GATEWAY_DEVICE_TOKEN_BYTES = 24;

function collectCapability(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function parseDeviceCapability(value: string): GatewayDeviceCapability {
  if (
    value === "push_context"
    || value === "upload_attachments"
    || value === "claim_commands"
    || value === "screenshot.capture"
  ) {
    return value;
  }

  throw new InvalidArgumentError(`Unsupported gateway device capability ${value}.`);
}

const DEFAULT_GATEWAY_DEVICE_CAPABILITIES: readonly GatewayDeviceCapability[] = [
  "push_context",
  "upload_attachments",
];

function parseDeviceCapabilities(options: GatewayDeviceRegisterOptions): readonly GatewayDeviceCapability[] | undefined {
  const raw = options.capability ?? [];
  if (raw.length === 0) {
    return undefined;
  }

  return raw.map((capability) => parseDeviceCapability(capability));
}

async function withGatewayStores<T>(
  options: GatewayCliOptions,
  fn: (stores: {
    agentStore: PostgresAgentStore;
    gatewayStore: PostgresGatewayStore;
    identityStore: PostgresIdentityStore;
    sessionStore: PostgresSessionStore;
    threadStore: PostgresThreadRuntimeStore;
  }) => Promise<T>,
): Promise<T> {
  return withPostgresPool(options.dbUrl, async (pool) => {
    const stores = {
      agentStore: new PostgresAgentStore({pool}),
      gatewayStore: new PostgresGatewayStore({pool}),
      identityStore: new PostgresIdentityStore({pool}),
      sessionStore: new PostgresSessionStore({pool}),
      threadStore: new PostgresThreadRuntimeStore({pool}),
    };
    await ensureSchemas([
      stores.identityStore,
      stores.agentStore,
      stores.sessionStore,
      stores.threadStore,
      stores.gatewayStore,
    ]);
    return fn(stores);
  });
}

async function createSource(sourceId: string, options: GatewaySourceCreateOptions): Promise<void> {
  await withGatewayStores(options, async ({agentStore, gatewayStore, identityStore, sessionStore, threadStore}) => {
    const identity = await identityStore.getIdentityByHandle(options.identity);
    const ensured = await ensureAgent(
      {agentStore, sessionStore, threadStore},
      options.agent,
      {env: process.env},
    );
    await agentStore.ensurePairing(ensured.agentKey, identity.id);
    const result = await gatewayStore.createSource({
      sourceId,
      name: options.name,
      agentKey: ensured.agentKey,
      identityId: identity.id,
      sessionId: options.session,
    });
    process.stdout.write([
      `Created gateway source ${result.source.sourceId}.`,
      `agent ${result.source.agentKey}`,
      `identity ${identity.handle} (${identity.id})`,
      `client_id ${result.source.clientId}`,
      `client_secret ${result.clientSecret}`,
    ].join("\n") + "\n");
  });
}

async function allowType(sourceId: string, type: string, options: GatewayAllowTypeOptions): Promise<void> {
  await withGatewayStores(options, async ({gatewayStore}) => {
    const record = await gatewayStore.upsertEventType({
      sourceId,
      type,
      delivery: options.delivery ?? "queue",
    });
    process.stdout.write(
      `Allowed ${record.type} for ${record.sourceId} with max delivery ${record.delivery}.\n`,
    );
  });
}

async function listSources(options: GatewayCliOptions): Promise<void> {
  await withGatewayStores(options, async ({gatewayStore}) => {
    const sources = await gatewayStore.listSources();
    if (sources.length === 0) {
      process.stdout.write("No gateway sources.\n");
      return;
    }
    for (const source of sources) {
      const types = await gatewayStore.listEventTypes(source.sourceId);
      process.stdout.write([
        source.sourceId,
        `  name ${source.name}`,
        `  status ${source.status}`,
        `  agent ${source.agentKey}`,
        `  identity ${source.identityId}`,
        `  client_id ${source.clientId}`,
        `  event types ${types.map((type) => `${type.type}:${type.delivery}`).join(", ") || "-"}`,
      ].join("\n") + "\n\n");
    }
  });
}

async function rotateSecret(sourceId: string, options: GatewayCliOptions): Promise<void> {
  await withGatewayStores(options, async ({gatewayStore}) => {
    const result = await gatewayStore.rotateSourceSecret(sourceId);
    process.stdout.write([
      `Rotated gateway source ${result.source.sourceId}.`,
      `client_id ${result.source.clientId}`,
      `client_secret ${result.clientSecret}`,
    ].join("\n") + "\n");
  });
}

async function suspendSource(sourceId: string, reason: string | undefined, options: GatewayCliOptions): Promise<void> {
  await withGatewayStores(options, async ({gatewayStore}) => {
    const source = await gatewayStore.suspendSource(sourceId, reason ?? "manual suspension");
    process.stdout.write(`Suspended gateway source ${source.sourceId}.\n`);
  });
}

async function resumeSource(sourceId: string, options: GatewayCliOptions): Promise<void> {
  await withGatewayStores(options, async ({gatewayStore}) => {
    const result = await gatewayStore.resumeSource(sourceId);
    process.stdout.write([
      `Resumed gateway source ${result.source.sourceId} and rotated its client secret.`,
      `client_id ${result.source.clientId}`,
      `client_secret ${result.clientSecret}`,
    ].join("\n") + "\n");
  });
}

async function registerDevice(
  sourceId: string,
  deviceId: string,
  options: GatewayDeviceRegisterOptions,
): Promise<void> {
  await withGatewayStores(options, async ({gatewayStore}) => {
    const token = generateOpaqueToken(GATEWAY_DEVICE_TOKEN_PREFIX, GATEWAY_DEVICE_TOKEN_BYTES);
    const device = await gatewayStore.registerDevice({
      sourceId,
      deviceId,
      label: options.label,
      capabilities: parseDeviceCapabilities(options) ?? DEFAULT_GATEWAY_DEVICE_CAPABILITIES,
      tokenHash: hashOpaqueToken(token),
    });

    process.stdout.write([
      `Registered gateway device ${device.deviceId} for source ${device.sourceId}.`,
      ...(device.label ? [`label ${device.label}`] : []),
      `capabilities ${device.capabilities.join(", ") || "-"}`,
      `token ${token}`,
      "Paste that token into the device configuration.",
    ].join("\n") + "\n");
  });
}

async function rotateDeviceToken(
  sourceId: string,
  deviceId: string,
  options: GatewayDeviceRegisterOptions,
): Promise<void> {
  await withGatewayStores(options, async ({gatewayStore}) => {
    const token = generateOpaqueToken(GATEWAY_DEVICE_TOKEN_PREFIX, GATEWAY_DEVICE_TOKEN_BYTES);
    const device = await gatewayStore.registerDevice({
      sourceId,
      deviceId,
      label: options.label,
      capabilities: parseDeviceCapabilities(options),
      tokenHash: hashOpaqueToken(token),
    });

    process.stdout.write([
      `Rotated token for gateway device ${device.deviceId} on source ${device.sourceId}.`,
      `token ${token}`,
    ].join("\n") + "\n");
  });
}

async function listDevices(sourceId: string, options: GatewayCliOptions): Promise<void> {
  await withGatewayStores(options, async ({gatewayStore}) => {
    const devices = await gatewayStore.listDevices({sourceId});
    if (devices.length === 0) {
      process.stdout.write(`No gateway devices registered for source ${sourceId}.\n`);
      return;
    }

    for (const device of devices) {
      process.stdout.write([
        device.deviceId,
        ...(device.label ? [`  label ${device.label}`] : []),
        `  enabled ${device.enabled}`,
        `  capabilities ${device.capabilities.join(", ") || "-"}`,
        ...(device.lastSeenAt ? [`  last_seen ${new Date(device.lastSeenAt).toISOString()}`] : []),
      ].join("\n") + "\n");
    }
  });
}

async function setDeviceEnabled(
  sourceId: string,
  deviceId: string,
  enabled: boolean,
  options: GatewayCliOptions,
): Promise<void> {
  await withGatewayStores(options, async ({gatewayStore}) => {
    const device = await gatewayStore.setDeviceEnabled({
      sourceId,
      deviceId,
      enabled,
    });
    process.stdout.write([
      `${enabled ? "Enabled" : "Disabled"} gateway device ${device.deviceId}.`,
      `source ${device.sourceId}`,
    ].join("\n") + "\n");
  });
}

async function listEvents(options: GatewayEventListOptions): Promise<void> {
  await withGatewayStores(options, async ({gatewayStore}) => {
    const events = await gatewayStore.listEvents({
      sourceId: options.source,
      limit: options.limit,
    });
    if (events.length === 0) {
      process.stdout.write("No gateway events.\n");
      return;
    }
    for (const event of events) {
      process.stdout.write([
        `${event.id} ${event.status}`,
        `  source ${event.sourceId}`,
        `  type ${event.type}`,
        `  delivery ${event.deliveryRequested}->${event.deliveryEffective}`,
        `  bytes ${String(event.textBytes)}`,
        `  risk ${event.riskScore?.toFixed(3) ?? "-"}`,
        `  created ${new Date(event.createdAt).toISOString()}`,
      ].join("\n") + "\n\n");
    }
  });
}
async function scrubExpiredAttachments(options: GatewayAttachmentScrubOptions): Promise<void> {
  await withGatewayStores(options, async ({gatewayStore}) => {
    const result = await gatewayStore.scrubExpiredAttachments({limit: options.limit});
    process.stdout.write(`Scrubbed ${String(result.scrubbed)} expired gateway attachment(s).\n`);
  });
}

export function registerGatewayManagementCommands(gateway: Command): void {
  const source = gateway
    .command("source")
    .description("Manage gateway sources");

  source
    .command("create")
    .description("Create a gateway source and print its one-time client secret")
    .argument("<sourceId>", "Gateway source id", normalizeGatewaySourceId)
    .requiredOption("--agent <agentKey>", "Agent key this source routes to", parseAgentKey)
    .requiredOption("--identity <handle>", "Identity handle this source acts as", parseIdentityHandle)
    .option("--name <name>", "Human-readable source name")
    .option("--session <sessionId>", "Specific session id to route to instead of the agent main session")
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((sourceId: string, options: GatewaySourceCreateOptions) => createSource(sourceId, options));

  source
    .command("allow-type")
    .description("Allow an event type for a source")
    .argument("<sourceId>", "Gateway source id", normalizeGatewaySourceId)
    .argument("<type>", "Event type")
    .option("--delivery <queue|wake>", "Maximum delivery mode for this event type", parseDelivery, "queue")
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((sourceId: string, type: string, options: GatewayAllowTypeOptions) => allowType(sourceId, type, options));

  source
    .command("list")
    .description("List gateway sources")
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((options: GatewayCliOptions) => listSources(options));

  source
    .command("rotate-secret")
    .description("Rotate a source client secret and print the new one-time secret")
    .argument("<sourceId>", "Gateway source id", normalizeGatewaySourceId)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((sourceId: string, options: GatewayCliOptions) => rotateSecret(sourceId, options));

  source
    .command("suspend")
    .description("Suspend a source")
    .argument("<sourceId>", "Gateway source id", normalizeGatewaySourceId)
    .option("--reason <reason>", "Suspension reason")
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((sourceId: string, options: GatewayCliOptions & {reason?: string}) => {
      return suspendSource(sourceId, options.reason, options);
    });

  source
    .command("resume")
    .description("Resume a source")
    .argument("<sourceId>", "Gateway source id", normalizeGatewaySourceId)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((sourceId: string, options: GatewayCliOptions) => resumeSource(sourceId, options));

  const device = gateway
    .command("device")
    .description("Manage gateway devices registered under a source");

  device
    .command("register")
    .description("Create or rotate a per-device gateway token")
    .argument("<sourceId>", "Gateway source id", normalizeGatewaySourceId)
    .argument("<deviceId>", "Device id", normalizeGatewayDeviceId)
    .option("--label <label>", "Human label for the device")
    .option("--capability <capability>", "Capability to grant; repeatable", collectCapability, [])
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((sourceId: string, deviceId: string, options: GatewayDeviceRegisterOptions) => registerDevice(sourceId, deviceId, options));

  device
    .command("list")
    .description("List devices registered for one gateway source")
    .argument("<sourceId>", "Gateway source id", normalizeGatewaySourceId)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((sourceId: string, options: GatewayCliOptions) => listDevices(sourceId, options));

  device
    .command("disable")
    .description("Disable a gateway device token immediately")
    .argument("<sourceId>", "Gateway source id", normalizeGatewaySourceId)
    .argument("<deviceId>", "Device id", normalizeGatewayDeviceId)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((sourceId: string, deviceId: string, options: GatewayCliOptions) => setDeviceEnabled(sourceId, deviceId, false, options));

  device
    .command("enable")
    .description("Re-enable a gateway device")
    .argument("<sourceId>", "Gateway source id", normalizeGatewaySourceId)
    .argument("<deviceId>", "Device id", normalizeGatewayDeviceId)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((sourceId: string, deviceId: string, options: GatewayCliOptions) => setDeviceEnabled(sourceId, deviceId, true, options));

  device
    .command("rotate-token")
    .description("Rotate a gateway device token and print the new one-time token")
    .argument("<sourceId>", "Gateway source id", normalizeGatewaySourceId)
    .argument("<deviceId>", "Device id", normalizeGatewayDeviceId)
    .option("--label <label>", "Optional new device label")
    .option("--capability <capability>", "Optional capability to grant; repeatable", collectCapability, [])
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((sourceId: string, deviceId: string, options: GatewayDeviceRegisterOptions) => rotateDeviceToken(sourceId, deviceId, options));

  gateway
    .command("event-list")
    .description("List recent gateway events")
    .option("--source <sourceId>", "Filter by source id", normalizeGatewaySourceId)
    .option("--limit <count>", "Maximum events to list", parsePositiveIntegerOption)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((options: GatewayEventListOptions) => listEvents(options));

  gateway
    .command("attachment-scrub-expired")
    .description("Delete expired gateway attachment bytes while keeping metadata")
    .option("--limit <count>", "Maximum attachments to scrub", parsePositiveIntegerOption)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((options: GatewayAttachmentScrubOptions) => scrubExpiredAttachments(options));
}

export function registerGatewayCommands(program: Command): void {
  const gateway = program
    .command("gateway")
    .description("Run and manage the public Panda gateway");

  registerGatewayManagementCommands(gateway);
}
