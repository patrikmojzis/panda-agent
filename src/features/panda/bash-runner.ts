import {createServer, type IncomingMessage, type Server, type ServerResponse} from "node:http";
import os from "node:os";
import path from "node:path";

import {normalizeAgentKey} from "../agents/types.js";
import {ToolError} from "../agent-core/exceptions.js";
import type {JsonObject} from "../agent-core/types.js";
import type {
    BashExecutionResult,
    BashRunnerAbortRequest,
    BashRunnerAbortResponse,
    BashRunnerErrorResponse,
    BashRunnerExecRequest,
    BashRunnerExecResponse,
} from "./tools/bash-protocol.js";
import {
    PANDA_RUNNER_AGENT_KEY_HEADER,
    PANDA_RUNNER_EXPECTED_PATH_HEADER,
    PANDA_RUNNER_PATH_SCOPED_HEADER,
} from "./tools/bash-protocol.js";
import {filterRemoteShellEnv} from "./tools/bash-remote-env.js";
import {executeBashCommand} from "./tools/bash-execution.js";

const DEFAULT_RUNNER_PORT = 8080;
const DEFAULT_RUNNER_HOST = "0.0.0.0";

interface ActiveRunnerRequest {
  controller: AbortController;
}

export interface PandaBashRunnerOptions {
  agentKey: string;
  port?: number;
  host?: string;
  env?: NodeJS.ProcessEnv;
  shell?: string;
  outputDirectory?: string;
}

export interface PandaBashRunner {
  readonly agentKey: string;
  readonly port: number;
  readonly host: string;
  readonly server: Server;
  close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

function parsePort(value: string | null, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid runner port: ${value}`);
  }

  return parsed;
}

function validateEnv(value: unknown): Record<string, string> {
  if (value === undefined) {
    return {};
  }

  if (!isRecord(value)) {
    throw new ToolError("Runner env must be an object.");
  }

  const env: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw new ToolError(`Runner env value for ${key} must be a string.`);
    }
    env[key] = entry;
  }

  return env;
}

function validateExecRequest(value: unknown): BashRunnerExecRequest {
  if (!isRecord(value)) {
    throw new ToolError("Runner request body must be an object.");
  }

  const requestId = firstNonEmpty(typeof value.requestId === "string" ? value.requestId : null);
  const command = firstNonEmpty(typeof value.command === "string" ? value.command : null);
  const cwd = firstNonEmpty(typeof value.cwd === "string" ? value.cwd : null);
  const timeoutMs = typeof value.timeoutMs === "number" ? value.timeoutMs : NaN;
  const maxOutputChars = typeof value.maxOutputChars === "number" ? value.maxOutputChars : NaN;
  const noOutputExpected = value.noOutputExpected === true;
  const trackedEnvKeys = Array.isArray(value.trackedEnvKeys)
    ? value.trackedEnvKeys.filter((entry): entry is string => typeof entry === "string")
    : null;

  if (!requestId) {
    throw new ToolError("Runner requestId must not be empty.");
  }
  if (!command) {
    throw new ToolError("Runner command must not be empty.");
  }
  if (!cwd) {
    throw new ToolError("Runner cwd must not be empty.");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000) {
    throw new ToolError("Runner timeoutMs must be an integer between 100 and 300000.");
  }
  if (!Number.isInteger(maxOutputChars) || maxOutputChars < 1) {
    throw new ToolError("Runner maxOutputChars must be a positive integer.");
  }
  if (trackedEnvKeys === null) {
    throw new ToolError("Runner trackedEnvKeys must be an array of strings.");
  }

  return {
    requestId,
    command,
    cwd,
    timeoutMs,
    trackedEnvKeys,
    noOutputExpected,
    maxOutputChars,
    env: validateEnv(value.env),
  };
}

function validateAbortRequest(value: unknown): BashRunnerAbortRequest {
  if (!isRecord(value)) {
    throw new ToolError("Abort request body must be an object.");
  }

  const requestId = firstNonEmpty(typeof value.requestId === "string" ? value.requestId : null);
  if (!requestId) {
    throw new ToolError("Abort requestId must not be empty.");
  }

  return { requestId };
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ToolError("Request body must be valid JSON.");
  }
}

function writeJson(response: ServerResponse, statusCode: number, payload: BashRunnerExecResponse | BashRunnerAbortResponse | BashRunnerErrorResponse): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(payload));
}

function matchesEndpoint(rawUrl: string | undefined, endpoint: "health" | "exec" | "abort"): boolean {
  if (!rawUrl) {
    return false;
  }

  const pathname = new URL(rawUrl, "http://runner.local").pathname.replace(/\/+$/, "");
  return pathname === `/${endpoint}` || pathname.endsWith(`/${endpoint}`);
}

function readHeaderValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return firstNonEmpty(value[0]);
  }

  return firstNonEmpty(value);
}

function readRequestPathSegments(rawUrl: string | undefined): string[] {
  if (!rawUrl) {
    return [];
  }

  return new URL(rawUrl, "http://runner.local").pathname
    .replace(/\/+$/, "")
    .split("/")
    .filter(Boolean);
}

function normalizeRequestPathname(rawUrl: string | undefined): string {
  if (!rawUrl) {
    return "/";
  }

  const pathname = new URL(rawUrl, "http://runner.local").pathname.replace(/\/+$/, "");
  return pathname || "/";
}

function validateRunnerRequestTarget(
  request: IncomingMessage,
  agentKey: string,
  endpoint: "exec" | "abort",
): void {
  const requestedAgentKey = readHeaderValue(request.headers[PANDA_RUNNER_AGENT_KEY_HEADER]);
  if (!requestedAgentKey) {
    throw new ToolError("Runner request is missing the target agent key header.");
  }

  if (requestedAgentKey !== agentKey) {
    throw new ToolError(`Runner for ${agentKey} rejected request for ${requestedAgentKey}.`, {
      details: {
        agentKey,
        requestedAgentKey,
        endpoint,
      },
    });
  }

  const pathScoped = readHeaderValue(request.headers[PANDA_RUNNER_PATH_SCOPED_HEADER]) === "1";
  if (!pathScoped) {
    return;
  }

  const pathname = normalizeRequestPathname(request.url);
  if (pathname !== `/${endpoint}` && !pathname.endsWith(`/${endpoint}`)) {
    throw new ToolError("Path-scoped runner request must end with the expected endpoint.");
  }

  const expectedBasePath = readHeaderValue(request.headers[PANDA_RUNNER_EXPECTED_PATH_HEADER]);
  if (expectedBasePath) {
    const basePath = normalizeRequestPathname(pathname.slice(0, -(`/${endpoint}`).length));
    if (basePath !== expectedBasePath) {
      throw new ToolError(`Runner for ${agentKey} rejected path-scoped request for ${basePath}.`, {
        details: {
          agentKey,
          expectedBasePath,
          actualBasePath: basePath,
          endpoint,
          path: request.url ?? null,
        },
      });
    }
    return;
  }

  const segments = readRequestPathSegments(request.url);
  const pathAgentKey = segments.at(-2);
  if (pathAgentKey !== agentKey) {
    throw new ToolError(`Runner for ${agentKey} rejected path-scoped request for ${pathAgentKey ?? "unknown"}.`, {
      details: {
        agentKey,
        pathAgentKey: pathAgentKey ?? null,
        endpoint,
        path: request.url ?? null,
      },
    });
  }
}

function buildAbortedResult(request: BashRunnerExecRequest, shell: string, reason: string): BashExecutionResult {
  return {
    shell,
    finalCwd: request.cwd,
    durationMs: 0,
    timeoutMs: request.timeoutMs,
    exitCode: null,
    signal: null,
    timedOut: false,
    aborted: true,
    abortReason: reason,
    interrupted: true,
    success: false,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutChars: 0,
    stderrChars: 0,
    stdoutPersisted: false,
    stderrPersisted: false,
    noOutput: true,
    noOutputExpected: request.noOutputExpected,
    trackedEnvKeys: request.trackedEnvKeys,
    persistedEnvEntries: [],
  };
}

export function resolvePandaBashRunnerOptions(env: NodeJS.ProcessEnv = process.env): PandaBashRunnerOptions {
  const agentKey = normalizeAgentKey(firstNonEmpty(env.PANDA_RUNNER_AGENT_KEY) ?? "");
  return {
    agentKey,
    port: parsePort(firstNonEmpty(env.PANDA_RUNNER_PORT), DEFAULT_RUNNER_PORT),
    host: firstNonEmpty(env.PANDA_RUNNER_HOST) ?? DEFAULT_RUNNER_HOST,
    env,
  };
}

export async function startPandaBashRunner(options: PandaBashRunnerOptions): Promise<PandaBashRunner> {
  const agentKey = normalizeAgentKey(options.agentKey);
  const requestedPort = options.port ?? DEFAULT_RUNNER_PORT;
  const host = options.host ?? DEFAULT_RUNNER_HOST;
  const env = options.env ?? process.env;
  const shell = options.shell ?? env.SHELL ?? "/bin/zsh";
  const outputDirectory = path.resolve(options.outputDirectory ?? path.join(os.tmpdir(), "panda-runner-results"));
  const baseShellEnv = filterRemoteShellEnv(env);
  const activeRequests = new Map<string, ActiveRunnerRequest>();
  const pendingAborts = new Map<string, NodeJS.Timeout>();

  const consumePendingAbort = (requestId: string): boolean => {
    const timer = pendingAborts.get(requestId);
    if (!timer) {
      return false;
    }

    clearTimeout(timer);
    pendingAborts.delete(requestId);
    return true;
  };

  const rememberPendingAbort = (requestId: string): void => {
    const existing = pendingAborts.get(requestId);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      pendingAborts.delete(requestId);
    }, 30_000);
    timer.unref();
    pendingAborts.set(requestId, timer);
  };

  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && matchesEndpoint(request.url, "health")) {
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          ok: true,
          agentKey,
        }));
        return;
      }

      if (request.method === "POST" && matchesEndpoint(request.url, "abort")) {
        validateRunnerRequestTarget(request, agentKey, "abort");
        const parsed = validateAbortRequest(await readJsonBody(request));
        const active = activeRequests.get(parsed.requestId);
        if (active) {
          active.controller.abort(new Error("Command aborted."));
          writeJson(response, 200, {
            ok: true,
            aborted: true,
          });
          return;
        }

        rememberPendingAbort(parsed.requestId);
        writeJson(response, 200, {
          ok: true,
          aborted: true,
        });
        return;
      }

      if (request.method === "POST" && matchesEndpoint(request.url, "exec")) {
        validateRunnerRequestTarget(request, agentKey, "exec");
        const parsed = validateExecRequest(await readJsonBody(request));
        const resolvedCwd = path.resolve(parsed.cwd);

        if (consumePendingAbort(parsed.requestId)) {
          writeJson(response, 200, {
            ok: true,
            ...buildAbortedResult(parsed, shell, "Command aborted."),
          });
          return;
        }

        const controller = new AbortController();
        activeRequests.set(parsed.requestId, { controller });

        response.once("close", () => {
          if (!response.writableEnded) {
            controller.abort(new Error("Client disconnected."));
          }
        });

        try {
          // The runner owns the base env. Core only sends a one-shot overlay for
          // the current command, which keeps remote bash container-local.
          const childEnv = {
            ...baseShellEnv,
            ...filterRemoteShellEnv(parsed.env),
          };
          const outcome = await executeBashCommand({
            command: parsed.command,
            cwd: resolvedCwd,
            childEnv,
            shell,
            timeoutMs: parsed.timeoutMs,
            trackedEnvKeys: parsed.trackedEnvKeys,
            maxOutputChars: parsed.maxOutputChars,
            persistOutputThresholdChars: parsed.maxOutputChars,
            progressIntervalMs: 250,
            progressTailChars: 1_200,
            outputDirectory,
            noOutputExpected: parsed.noOutputExpected,
            persistOutputFiles: false,
            signal: controller.signal,
          });

          if (outcome.spawnErrorMessage) {
            writeJson(response, 500, {
              ok: false,
              error: `Failed to spawn shell: ${outcome.spawnErrorMessage}`,
              details: outcome.spawnErrorDetails,
            });
            return;
          }

          writeJson(response, 200, {
            ok: true,
            ...outcome.result,
          });
          return;
        } finally {
          activeRequests.delete(parsed.requestId);
        }
      }

      writeJson(response, 404, {
        ok: false,
        error: "Not found.",
      });
    } catch (error) {
      if (error instanceof ToolError) {
        writeJson(response, 400, {
          ok: false,
          error: error.message,
          details: error.details as JsonObject | undefined,
        });
        return;
      }

      const message = error instanceof Error ? error.message : "Unknown runner error.";
      writeJson(response, 500, {
        ok: false,
        error: message,
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve runner listen address.");
  }
  const port = address.port;

  return {
    agentKey,
    port,
    host,
    server,
    close: async () => {
      for (const timer of pendingAborts.values()) {
        clearTimeout(timer);
      }
      pendingAborts.clear();
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
