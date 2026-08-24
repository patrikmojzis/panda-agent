import process from "node:process";

import {Command} from "commander";

import {PostgresAgentStore} from "../../domain/agents/postgres.js";
import {
  registerGatewayManagementCommands,
} from "../../domain/gateway/cli.js";
import {PostgresGatewayStore} from "../../domain/gateway/postgres.js";
import {PostgresIdentityStore} from "../../domain/identity/postgres.js";
import {PostgresSessionStore} from "../../domain/sessions/postgres.js";
import {PostgresThreadRuntimeStore} from "../../domain/threads/runtime/postgres.js";
import {createGatewayGuardFromEnv} from "../../integrations/gateway/guard.js";
import {formatGatewayListenUrl, startGatewayServer} from "../../integrations/gateway/http.js";
import {resolveGatewayHttpConfig} from "../../integrations/gateway/http-config.js";
import {
  DEFAULT_GATEWAY_DEVICE_COMMAND_MAX_WAITERS,
  startGatewayDeviceCommandWaiter,
} from "../../integrations/gateway/device-command-waiter.js";
import {startGatewayWorker} from "../../integrations/gateway/worker.js";
import {DB_URL_OPTION_DESCRIPTION, parsePortOption} from "../../lib/cli.js";
import {createPostgresPool, requireDatabaseUrl} from "../../lib/postgres-database.js";
import {ensureSchemas} from "../../lib/postgres-bootstrap.js";

interface GatewayRunOptions {
  dbUrl?: string;
  host?: string;
  port?: number;
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

async function runGateway(options: GatewayRunOptions): Promise<void> {
  const pool = createPostgresPool({
    connectionString: requireDatabaseUrl(options.dbUrl),
    applicationName: "panda/gateway",
    max: 5,
  });
  try {
    const gatewayStore = new PostgresGatewayStore({pool});
    const identityStore = new PostgresIdentityStore({pool});
    const agentStore = new PostgresAgentStore({pool});
    const sessionStore = new PostgresSessionStore({pool});
    const threadStore = new PostgresThreadRuntimeStore({pool});
    await ensureSchemas([identityStore, agentStore, sessionStore, threadStore, gatewayStore]);

    const guardTimeoutMs = readOptionalPositiveIntegerEnv("GATEWAY_GUARD_TIMEOUT_MS");
    const maxDeviceCommandWaiters = readOptionalPositiveIntegerEnv("GATEWAY_DEVICE_COMMAND_MAX_WAITERS")
      ?? DEFAULT_GATEWAY_DEVICE_COMMAND_MAX_WAITERS;
    const gatewayConfig = resolveGatewayHttpConfig(process.env);
    const guard = createGatewayGuardFromEnv(process.env);
    const deviceCommandWaiter = await startGatewayDeviceCommandWaiter({
      maxWaiters: maxDeviceCommandWaiters,
      pool,
      store: gatewayStore,
    });
    try {
      const worker = startGatewayWorker({
        guard,
        ...(guardTimeoutMs !== undefined ? {guardTimeoutMs} : {}),
        attachmentRetentionMs: gatewayConfig.attachmentRetentionMs,
        attachmentQuarantineTtlMs: gatewayConfig.attachmentQuarantineTtlMs,
        store: gatewayStore,
        sessionStore,
        threadStore,
      });
      try {
        const server = await startGatewayServer({
          ...gatewayConfig,
          deviceCommandWaiter,
          store: gatewayStore,
          worker,
          ...(options.host ? {host: options.host} : {}),
          ...(options.port !== undefined ? {port: options.port} : {}),
        });
        const shutdown = async () => {
          await Promise.all([
            server.close().catch(() => undefined),
            deviceCommandWaiter.close().catch(() => undefined),
          ]);
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
          await server.close().catch(() => undefined);
        }
      } finally {
        await worker.close().catch(() => undefined);
      }
    } finally {
      await deviceCommandWaiter.close().catch(() => undefined);
    }
  } finally {
    await pool.end();
  }
}

export function registerGatewayCommands(program: Command): void {
  const gateway = program
    .command("gateway")
    .description("Run and manage the public Panda gateway");

  gateway
    .command("run")
    .description("Run the public gateway HTTP service")
    .option("--host <host>", "Host to bind the gateway server")
    .option("--port <port>", "Port to bind the gateway server", parsePortOption)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((options: GatewayRunOptions) => runGateway(options));

  registerGatewayManagementCommands(gateway);
}
