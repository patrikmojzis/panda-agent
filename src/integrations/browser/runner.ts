import {createServer, type IncomingMessage, type Server, type ServerResponse} from "node:http";
import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";

import {z} from "zod";

import {normalizeAgentKey} from "../../domain/agents/types.js";
import {writeJsonResponse} from "../../lib/http.js";
import {isRecord} from "../../lib/records.js";
import {trimToNull} from "../../lib/strings.js";
import {Agent} from "../../kernel/agent/agent.js";
import {ToolError} from "../../kernel/agent/exceptions.js";
import {RunContext} from "../../kernel/agent/run-context.js";
import {readToolArtifact} from "../../kernel/agent/tool-artifacts.js";
import type {JsonObject, ToolResultPayload} from "../../kernel/agent/types.js";
import {browserActionSchema} from "../../panda/tools/browser-schema.js";
import {BrowserSessionService, type BrowserSessionServiceOptions} from "./session-service.js";
import type {
    BrowserPreviewOriginGrant,
    BrowserRunnerActionRequest,
    BrowserRunnerActionResponse,
    BrowserRunnerArtifact,
    BrowserRunnerHealthResponse,
} from "./protocol.js";

const DEFAULT_BROWSER_RUNNER_PORT = 8080;
const DEFAULT_BROWSER_RUNNER_HOST = "0.0.0.0";
const DEFAULT_PREVIEW_CONTAINER_PREFIX = "panda-env";

const browserRunnerRequestSchema = z.object({
  agentKey: z.string().trim().default(""),
  sessionId: z.string().trim().optional(),
  threadId: z.string().trim().optional(),
  action: browserActionSchema,
  previewOriginGrant: z.object({
    originalOrigin: z.string().trim().url(),
    resolvedOrigin: z.string().trim().url(),
  }).optional(),
});

const runnerAgent = new Agent({
  name: "browser-runner",
  instructions: "Internal browser runner.",
});

function logBrowserRunnerEvent(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({
    source: "browser-runner",
    event,
    timestamp: new Date().toISOString(),
    ...fields,
  }));
}

function buildActionLogFields(parsed: BrowserRunnerActionRequest): Record<string, unknown> {
  const action = parsed.action;
  return {
    agentKey: parsed.agentKey,
    sessionId: parsed.sessionId,
    threadId: parsed.threadId,
    action: action.action,
    ...("url" in action ? {url: action.url} : {}),
    ...("ref" in action ? {ref: action.ref} : {}),
    ...("selector" in action ? {selector: action.selector} : {}),
    ...("timeoutMs" in action ? {timeoutMs: action.timeoutMs} : {}),
  };
}

export interface BrowserRunnerOptions extends BrowserSessionServiceOptions {
  host?: string;
  port?: number;
  sharedSecret?: string;
}

export interface BrowserRunner {
  readonly host: string;
  readonly port: number;
  readonly server: Server;
  close(): Promise<void>;
}

function parsePort(value: string | null, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid browser runner port: ${value}`);
  }

  return parsed;
}

function parseOptionalPositiveInt(value: string | null | undefined, label: string): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }

  return parsed;
}

function validateSharedSecret(value: string | null | undefined): string {
  const trimmed = trimToNull(value);
  if (!trimmed) {
    throw new Error("Browser runner shared secret must not be empty.");
  }

  return trimmed;
}

function unauthorized(response: ServerResponse, statusCode: number, error: string): void {
  writeJsonResponse(response, statusCode, {
    ok: false,
    error,
  } satisfies BrowserRunnerActionResponse);
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ToolError(`Browser runner request body must be valid JSON: ${message}`);
  }
}

function requireAuthorization(request: IncomingMessage, sharedSecret: string): void {
  const header = trimToNull(request.headers.authorization ?? null);
  if (!header) {
    throw new ToolError("Missing Authorization header.", {details: {statusCode: 401}});
  }

  if (header !== `Bearer ${sharedSecret}`) {
    throw new ToolError("Invalid browser runner Authorization header.", {details: {statusCode: 403}});
  }
}

function normalizePreviewHostname(hostname: string): string {
  const normalized = hostname.trim().replace(/\.+$/, "").toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    return normalized.slice(1, -1);
  }
  return normalized;
}

function normalizeDockerDnsLabelPart(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || DEFAULT_PREVIEW_CONTAINER_PREFIX;
}

function isLoopbackPreviewHost(hostname: string): boolean {
  const normalized = normalizePreviewHostname(hostname);
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function isHttpPreviewOrigin(url: URL): boolean {
  return url.protocol === "http:" || url.protocol === "https:";
}

function validatePreviewOriginGrant(
  action: BrowserRunnerActionRequest["action"],
  grant: BrowserPreviewOriginGrant | undefined,
  env: NodeJS.ProcessEnv,
): BrowserPreviewOriginGrant | undefined {
  if (!grant) {
    return undefined;
  }
  if (action.action !== "navigate") {
    throw new ToolError("Browser preview origin grants are only allowed for navigate actions.");
  }

  const actionUrl = new URL(action.url);
  const originalUrl = new URL(grant.originalOrigin);
  const resolvedUrl = new URL(grant.resolvedOrigin);
  if (grant.originalOrigin !== originalUrl.origin || grant.resolvedOrigin !== resolvedUrl.origin) {
    throw new ToolError("Browser preview origin grants must contain origins, not full URLs.");
  }
  if (!isHttpPreviewOrigin(actionUrl) || !isHttpPreviewOrigin(originalUrl) || !isHttpPreviewOrigin(resolvedUrl)) {
    throw new ToolError("Browser preview origin grants only support http:// and https:// origins.");
  }
  if (!isLoopbackPreviewHost(originalUrl.hostname)) {
    throw new ToolError("Browser preview origin grants require a loopback original origin.");
  }
  if (actionUrl.origin !== resolvedUrl.origin) {
    throw new ToolError("Browser preview origin grant does not match the action URL origin.");
  }

  const prefix = normalizeDockerDnsLabelPart(trimToNull(env.PANDA_DISPOSABLE_CONTAINER_PREFIX) ?? DEFAULT_PREVIEW_CONTAINER_PREFIX);
  const resolvedHostname = normalizePreviewHostname(resolvedUrl.hostname);
  if (!resolvedHostname.startsWith(`${prefix}-`)) {
    throw new ToolError("Browser preview origin grant resolved host is not a managed disposable container.");
  }

  return {
    originalOrigin: originalUrl.origin,
    resolvedOrigin: resolvedUrl.origin,
  };
}

function validateActionRequest(
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
): BrowserRunnerActionRequest {
  const parsed = browserRunnerRequestSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => issue.message);
    throw new ToolError(
      issues.length === 1 ? issues[0] ?? "Invalid browser runner request." : `Invalid browser runner request: ${issues.join("; ")}`,
      {details: {issues}},
    );
  }

  const agentKey = parsed.data.agentKey ? normalizeAgentKey(parsed.data.agentKey) : "";
  const action = parsed.data.action as BrowserRunnerActionRequest["action"];
  const previewOriginGrant = validatePreviewOriginGrant(action, parsed.data.previewOriginGrant, env);
  return {
    agentKey,
    ...(parsed.data.sessionId ? {sessionId: parsed.data.sessionId} : {}),
    ...(parsed.data.threadId ? {threadId: parsed.data.threadId} : {}),
    action,
    ...(previewOriginGrant ? {previewOriginGrant} : {}),
  };
}

async function buildRunnerArtifact(payload: ToolResultPayload): Promise<BrowserRunnerArtifact | undefined> {
  const artifact = readToolArtifact(payload.details);
  if (!artifact) {
    return undefined;
  }

  const bytes = await readFile(artifact.path);
  return {
    kind: artifact.kind,
    mimeType: artifact.mimeType,
    data: bytes.toString("base64"),
    bytes: bytes.length,
    path: artifact.path,
  };
}

async function buildRunnerResponse(payload: ToolResultPayload): Promise<BrowserRunnerActionResponse> {
  const text = payload.content
    .filter((part): part is {type: "text"; text: string} => part.type === "text")
    .map((part) => part.text)
    .join("\n\n");
  const details = isRecord(payload.details) ? payload.details as JsonObject : undefined;
  const artifact = await buildRunnerArtifact(payload);

  return {
    ok: true,
    text,
    ...(details ? {details} : {}),
    ...(artifact ? {artifact} : {}),
  };
}

export function resolveBrowserRunnerOptions(env: NodeJS.ProcessEnv = process.env): BrowserRunnerOptions {
  return {
    env,
    host: trimToNull(env.BROWSER_RUNNER_HOST) ?? DEFAULT_BROWSER_RUNNER_HOST,
    port: parsePort(trimToNull(env.BROWSER_RUNNER_PORT), DEFAULT_BROWSER_RUNNER_PORT),
    sharedSecret: validateSharedSecret(env.BROWSER_RUNNER_SHARED_SECRET),
    dataDir: trimToNull(env.BROWSER_RUNNER_DATA_DIR) ?? undefined,
    actionTimeoutMs: parseOptionalPositiveInt(trimToNull(env.BROWSER_ACTION_TIMEOUT_MS), "BROWSER_ACTION_TIMEOUT_MS"),
    sessionIdleTtlMs: parseOptionalPositiveInt(trimToNull(env.BROWSER_SESSION_IDLE_TTL_MS), "BROWSER_SESSION_IDLE_TTL_MS"),
    sessionMaxAgeMs: parseOptionalPositiveInt(trimToNull(env.BROWSER_SESSION_MAX_AGE_MS), "BROWSER_SESSION_MAX_AGE_MS"),
  };
}

export async function startBrowserRunner(options: BrowserRunnerOptions): Promise<BrowserRunner> {
  const host = options.host ?? DEFAULT_BROWSER_RUNNER_HOST;
  const port = options.port ?? DEFAULT_BROWSER_RUNNER_PORT;
  const sharedSecret = validateSharedSecret(options.sharedSecret);
  const service = new BrowserSessionService(options);

  const server = createServer(async (request, response) => {
    try {
      if (!request.url) {
        response.statusCode = 404;
        response.end();
        return;
      }

      const requestUrl = new URL(request.url, `http://${request.headers.host ?? "runner.local"}`);
      if (request.method === "GET" && requestUrl.pathname === "/health") {
        writeJsonResponse(response, 200, {
          ok: true,
          status: "ok",
        } satisfies BrowserRunnerHealthResponse);
        return;
      }

      if (request.method !== "POST" || requestUrl.pathname !== "/action") {
        response.statusCode = 404;
        response.end();
        return;
      }

      requireAuthorization(request, sharedSecret);
      const body = await readJsonBody(request);
      const parsed = validateActionRequest(body, options.env ?? process.env);
      const requestId = randomUUID();
      const actionStartedAt = Date.now();
      const actionLogFields = buildActionLogFields(parsed);
      logBrowserRunnerEvent("browser_action_start", {
        requestId,
        ...actionLogFields,
      });
      const controller = new AbortController();
      request.on("close", () => controller.abort());

      try {
        const payload = await service.handle(parsed.action, new RunContext({
          agent: runnerAgent,
          turn: 1,
          maxTurns: 1,
          messages: [],
          signal: controller.signal,
          context: {
            agentKey: parsed.agentKey,
            sessionId: parsed.sessionId ?? "",
            threadId: parsed.threadId ?? "",
          },
        }), parsed.previewOriginGrant);
        const runnerResponse = await buildRunnerResponse(payload);
        logBrowserRunnerEvent("browser_action_end", {
          requestId,
          durationMs: Date.now() - actionStartedAt,
          ok: true,
          ...actionLogFields,
        });
        writeJsonResponse(response, 200, runnerResponse);
      } catch (error) {
        logBrowserRunnerEvent("browser_action_error", {
          requestId,
          durationMs: Date.now() - actionStartedAt,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          ...actionLogFields,
        });
        throw error;
      }
    } catch (error) {
      if (error instanceof ToolError) {
        const statusCode = isRecord(error.details) && typeof error.details.statusCode === "number"
          ? error.details.statusCode
          : 400;
        if (statusCode === 401 || statusCode === 403) {
          unauthorized(response, statusCode, error.message);
          return;
        }
        const details = isRecord(error.details) && !("statusCode" in error.details)
          ? error.details as JsonObject
          : undefined;
        writeJsonResponse(response, statusCode, {
          ok: false,
          error: error.message,
          ...(details ? {details} : {}),
        } satisfies BrowserRunnerActionResponse);
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      writeJsonResponse(response, 500, {
        ok: false,
        error: message,
      } satisfies BrowserRunnerActionResponse);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  return {
    host,
    port: address && typeof address === "object" ? address.port : port,
    server,
    async close(): Promise<void> {
      await service.close().catch(() => undefined);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }).catch(() => undefined);
    },
  };
}
