import process from "node:process";

import {Command, InvalidArgumentError} from "commander";

import {DB_URL_OPTION_DESCRIPTION} from "../../app/cli-shared.js";
import {createPostgresPool, requireDatabaseUrl} from "../../app/runtime/database.js";
import {ensureSchemas, withPostgresPool} from "../../app/runtime/postgres-bootstrap.js";
import {parseAgentKey, ensureAgent} from "../agents/cli.js";
import {PostgresAgentStore} from "../agents/postgres.js";
import {parseIdentityHandle} from "../identity/cli.js";
import {PostgresIdentityStore} from "../identity/postgres.js";
import {PostgresSessionStore} from "../sessions/postgres.js";
import {PostgresThreadRuntimeStore} from "../threads/runtime/postgres.js";
import {PostgresGatewayStore, normalizeGatewaySourceId} from "./postgres.js";
import type {GatewayDeliveryMode} from "./types.js";
import {createGatewayGuardFromEnv} from "../../integrations/gateway/guard.js";
import {formatGatewayListenUrl, resolveGatewayServerOptions, startGatewayServer} from "../../integrations/gateway/http.js";
import {startGatewayWorker} from "../../integrations/gateway/worker.js";

interface GatewayCliOptions {
  dbUrl?: string;
}

interface GatewayRunOptions extends GatewayCliOptions {
  host?: string;
  port?: number;
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

function parsePort(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new InvalidArgumentError("Port must be an integer between 1 and 65535.");
  }
  return parsed;
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError("Value must be a positive integer.");
  }
  return parsed;
}

function readOptionalPositiveIntegerEnv(key: string): number | undefined {
  const raw = process.env[key]?.trim();
  if (!raw) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${key} must be a positive integer.`);
  }
  return parsed;
}

function parseDelivery(value: string): GatewayDeliveryMode {
  if (value !== "queue" && value !== "wake") {
    throw new InvalidArgumentError("Delivery must be queue or wake.");
  }
  return value;
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

async function runGateway(options: GatewayRunOptions): Promise<void> {
  const pool = createPostgresPool({
    connectionString: requireDatabaseUrl(options.dbUrl),
    applicationName: "panda/gateway",
    max: 5,
  });
  const gatewayStore = new PostgresGatewayStore({pool});
  const identityStore = new PostgresIdentityStore({pool});
  const agentStore = new PostgresAgentStore({pool});
  const sessionStore = new PostgresSessionStore({pool});
  const threadStore = new PostgresThreadRuntimeStore({pool});
  await ensureSchemas([identityStore, agentStore, sessionStore, threadStore, gatewayStore]);

  const guardTimeoutMs = readOptionalPositiveIntegerEnv("GATEWAY_GUARD_TIMEOUT_MS");
  const worker = startGatewayWorker({
    guard: createGatewayGuardFromEnv(process.env),
    ...(guardTimeoutMs !== undefined ? {guardTimeoutMs} : {}),
    store: gatewayStore,
    sessionStore,
    threadStore,
  });
  const server = await startGatewayServer({
    ...resolveGatewayServerOptions(gatewayStore, worker, process.env),
    ...(options.host ? {host: options.host} : {}),
    ...(options.port !== undefined ? {port: options.port} : {}),
  });

  const shutdown = async () => {
    await server.close().catch(() => undefined);
  };
  const handleSigint = () => {
    void shutdown();
  };
  const handleSigterm = () => {
    void shutdown();
  };
  process.once("SIGINT", handleSigint);
  process.once("SIGTERM", handleSigterm);

  try {
    process.stdout.write(`Panda gateway listening on ${formatGatewayListenUrl(server)}\n`);
    await new Promise<void>((resolve, reject) => {
      server.server.once("close", resolve);
      server.server.once("error", reject);
    });
  } finally {
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigterm);
    await worker.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    await pool.end();
  }
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

export function registerGatewayCommands(program: Command): void {
  const gateway = program
    .command("gateway")
    .description("Run and manage the public Panda gateway");

  gateway
    .command("run")
    .description("Run the public gateway HTTP service")
    .option("--host <host>", "Host to bind the gateway server")
    .option("--port <port>", "Port to bind the gateway server", parsePort)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((options: GatewayRunOptions) => runGateway(options));

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

  gateway
    .command("event-list")
    .description("List recent gateway events")
    .option("--source <sourceId>", "Filter by source id", normalizeGatewaySourceId)
    .option("--limit <count>", "Maximum events to list", parsePositiveInteger)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((options: GatewayEventListOptions) => listEvents(options));
}
