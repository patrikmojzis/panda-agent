import {createServer, type IncomingMessage} from "node:http";

import {writeJsonResponse} from "./http.js";
import {readTcpPort} from "./numbers.js";
import {trimToNull} from "./strings.js";

const DEFAULT_HEALTH_HOST = "127.0.0.1";

export interface HealthSnapshot {
  ok: boolean;
  [key: string]: unknown;
}

interface HealthServerBindingOptions {
  hostEnvKey: string;
  portEnvKey: string;
  defaultHost?: string;
  env?: NodeJS.ProcessEnv;
}

export interface HealthServerBinding {
  host: string;
  port: number;
}

interface HealthServerOptions extends HealthServerBinding {
  getSnapshot: () => HealthSnapshot | Promise<HealthSnapshot>;
}

export interface HealthServer {
  close(): Promise<void>;
}

function parsePort(value: string, label: string): number {
  const parsed = readTcpPort(value);
  if (parsed === undefined) {
    throw new Error(`Invalid ${label}: ${value}`);
  }

  return parsed;
}

function isHealthRequest(request: IncomingMessage): boolean {
  if (request.method !== "GET" || !request.url) {
    return false;
  }

  const requestUrl = new URL(request.url, `http://${request.headers.host ?? "health.local"}`);
  return requestUrl.pathname === "/health";
}

/**
 * Resolves an optional `/health` server binding from env.
 */
export function resolveOptionalHealthServerBinding(
  options: HealthServerBindingOptions,
): HealthServerBinding | null {
  const env = options.env ?? process.env;
  const portValue = trimToNull(env[options.portEnvKey]);
  if (!portValue) {
    return null;
  }

  return {
    host: trimToNull(env[options.hostEnvKey]) ?? options.defaultHost ?? DEFAULT_HEALTH_HOST,
    port: parsePort(portValue, options.portEnvKey),
  };
}

/**
 * Starts a minimal JSON `/health` server for process-style adapters.
 */
export async function startHealthServer(options: HealthServerOptions): Promise<HealthServer> {
  const server = createServer(async (request, response) => {
    try {
      if (!isHealthRequest(request)) {
        response.statusCode = 404;
        response.end();
        return;
      }

      const snapshot = await options.getSnapshot();
      writeJsonResponse(response, snapshot.ok ? 200 : 503, snapshot);
    } catch (error) {
      writeJsonResponse(response, 503, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      } satisfies HealthSnapshot);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    close: async (): Promise<void> => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },
  };
}
