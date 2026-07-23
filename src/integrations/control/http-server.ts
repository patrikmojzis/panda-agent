import {createReadStream} from "node:fs";
import {access, stat} from "node:fs/promises";
import {createServer, type IncomingMessage, type Server, type ServerResponse} from "node:http";
import path from "node:path";

import {readJsonHttpBody} from "../http-body.js";
import {writeJsonResponse} from "../../lib/http.js";
import {DEFAULT_CONTROL_REMEMBERED_SESSION_TTL_MS, type PostgresControlAuthService} from "../../domain/control/auth.js";
import type {ControlReadService} from "../../domain/control/read-service.js";
import type {ControlHomeService} from "../../domain/control/home-service.js";
import type {ControlMcpService} from "../../domain/control/mcp-service.js";
import type {
    ControlA2ABindingTableInput,
    ControlAgentPairingTableInput,
    ControlBindingTableInput,
    ControlChannelActorPairingSource,
    ControlChannelActorPairingTableInput,
    ControlConnectorTableInput,
    ControlDiscordActorPairingTableInput,
    ControlEmailAllowedRecipientTableInput,
    ControlEmailRouteTableInput,
    ControlGatewayDeviceTableInput,
    ControlIdentityTableInput,
    ControlOperatorService,
    ControlSessionTableInput,
    ControlSkillTableInput,
    ControlSortDirection,
    ControlSubagentTableInput,
    ControlTableInput,
    ControlWorkFailureKind,
    ControlWorkFailureTableInput,
} from "../../domain/control/operator-service.js";
import type {ControlBriefingService} from "../../domain/control/briefing-service.js";
import type {ControlHeartbeatService} from "../../domain/control/heartbeat-service.js";
import type {
    ControlScheduledTaskLifecycleStatus,
    ControlScheduledTasksService,
    GetScheduledTasksInput,
} from "../../domain/control/scheduled-tasks-service.js";
import type {
    ControlWatchesService,
    ControlWatchLifecycleStatus,
    ControlWatchSourceKind,
    GetWatchesInput,
} from "../../domain/control/watches-service.js";
import type {
    ControlRuntimeActivityService,
    ControlRuntimeActivityTableInput,
    ControlRuntimeFailureCategory,
} from "../../domain/control/runtime-activity-service.js";
import type {ControlConnectorAccountsService} from "../../domain/control/connector-accounts-service.js";
import type {ControlModelCallTraceService} from "../../domain/control/model-call-trace-service.js";
import type {ModelCallTraceMode, ModelCallTraceStatus} from "../../domain/model-call-traces/types.js";
import type {ControlGrantRecord, ControlGrantRole, ControlSessionRecord} from "../../domain/control/types.js";
import type {IdentityStore} from "../../domain/identity/store.js";

export const CONTROL_SESSION_COOKIE = "panda_control_session";
export const CONTROL_CSRF_COOKIE = "panda_control_csrf";

const DEFAULT_CONTROL_UI_STATIC_DIR = path.resolve(process.cwd(), "apps/control-ui/dist");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

async function directoryExists(directory: string): Promise<boolean> {
  try {
    return (await stat(directory)).isDirectory();
  } catch {
    return false;
  }
}

function resolveStaticFile(root: string, requestPath: string): string | null {
  const decoded = decodeURIComponent(requestPath.split("?")[0] ?? "/");
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const resolved = path.resolve(root, relative);
  const normalizedRoot = path.resolve(root);
  if (resolved !== normalizedRoot && !resolved.startsWith(`${normalizedRoot}${path.sep}`)) return null;
  return resolved;
}

async function serveStaticAsset(request: IncomingMessage, response: ServerResponse, root: string, requestPath: string): Promise<boolean> {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  if (!(await directoryExists(root))) return false;

  const candidate = resolveStaticFile(root, requestPath);
  if (!candidate) {
    writeJsonResponse(response, 404, {error: "not_found"});
    return true;
  }

  let filePath = candidate;
  try {
    const info = await stat(filePath);
    if (info.isDirectory()) filePath = path.join(filePath, "index.html");
  } catch {
    filePath = path.join(root, "index.html");
  }

  try {
    await access(filePath);
  } catch {
    writeJsonResponse(response, 404, {error: "not_found"});
    return true;
  }

  response.statusCode = 200;
  response.setHeader("content-type", CONTENT_TYPES[path.extname(filePath)] ?? "application/octet-stream");
  if (request.method === "HEAD") {
    response.end();
    return true;
  }
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.once("error", reject);
    response.once("finish", resolve);
    stream.pipe(response);
  });
  return true;
}

class ControlHttpError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

export interface ControlHttpServer {
  server: Server;
  host: string;
  port: number;
  close(): Promise<void>;
}

export interface StartControlServerOptions {
  host: string;
  port: number;
  auth: PostgresControlAuthService;
  reads: ControlReadService;
  home: ControlHomeService;
  operator: ControlOperatorService;
  mcp: ControlMcpService;
  briefings: ControlBriefingService;
  heartbeats: ControlHeartbeatService;
  scheduledTasks: ControlScheduledTasksService;
  watches: ControlWatchesService;
  runtimeActivity: ControlRuntimeActivityService;
  connectorAccounts: ControlConnectorAccountsService;
  modelCallTraces: ControlModelCallTraceService;
  identityStore: Pick<IdentityStore, "getIdentity" | "getIdentityByHandle" | "listIdentities">;
  env?: NodeJS.ProcessEnv;
  uiStaticDir?: string;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (!rawName || rawValue.length === 0) continue;
    cookies[rawName] = decodeURIComponent(rawValue.join("="));
  }
  return cookies;
}

function setCookie(response: ServerResponse, name: string, value: string, options = "HttpOnly; SameSite=Strict; Path=/api/control"): void {
  const next = `${name}=${encodeURIComponent(value)}; ${options}`;
  const existing = response.getHeader("set-cookie");
  const values = Array.isArray(existing) ? existing.map(String) : existing ? [String(existing)] : [];
  response.setHeader("set-cookie", [...values, next]);
}

function clearCookie(response: ServerResponse, name: string, options = "HttpOnly; SameSite=Strict; Path=/api/control; Max-Age=0"): void {
  setCookie(response, name, "", options);
}

function rememberCookieMaxAgeSeconds(): number {
  return Math.floor(DEFAULT_CONTROL_REMEMBERED_SESSION_TTL_MS / 1000);
}

function publicSession(session: ControlSessionRecord): Record<string, unknown> {
  return {
    id: session.id,
    identityId: session.identityId,
    role: session.role,
    expiresAt: new Date(session.expiresAt).toISOString(),
  };
}

function publicControlGrant(grant: ControlGrantRecord): Record<string, unknown> {
  return {
    id: grant.id,
    identityId: grant.identityId,
    role: grant.role,
    ...(grant.agentKey ? {agentKey: grant.agentKey} : {}),
    ...(grant.label ? {label: grant.label} : {}),
    active: grant.active,
    loginTokenExpiresAt: new Date(grant.loginTokenExpiresAt).toISOString(),
    ...(grant.loginTokenConsumedAt ? {loginTokenConsumedAt: new Date(grant.loginTokenConsumedAt).toISOString()} : {}),
    createdAt: new Date(grant.createdAt).toISOString(),
    updatedAt: new Date(grant.updatedAt).toISOString(),
  };
}

function parseGrantRole(value: unknown): ControlGrantRole {
  if (value === "admin" || value === "scoped") return value;
  throw new ControlHttpError(400, "Control grant role must be admin or scoped.");
}

function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function envFlagEnabled(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function devLoginStatus(env: NodeJS.ProcessEnv, request: IncomingMessage): "enabled" | "disabled" | "production" | "remote" {
  if ((env.NODE_ENV ?? "").trim().toLowerCase() === "production") return "production";
  if (!envFlagEnabled(env.PANDA_CONTROL_DEV_LOGIN_ENABLED)) return "disabled";
  if (envFlagEnabled(env.PANDA_CONTROL_DEV_LOGIN_ALLOW_REMOTE)) return "enabled";
  const address = request.socket.remoteAddress ?? "";
  if (address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1") return "enabled";
  return "remote";
}

function parseControlRole(value: unknown): "admin" | "scoped" {
  if (value === undefined || value === null || value === "") return "admin";
  if (value === "admin" || value === "scoped") return value;
  throw new ControlHttpError(400, "Control dev login role must be admin or scoped.");
}

async function resolveDevLoginIdentity(
  identityStore: Pick<IdentityStore, "getIdentity" | "getIdentityByHandle" | "listIdentities">,
  hint: string | undefined,
): Promise<{id: string; handle: string}> {
  const trimmed = hint?.trim();
  if (trimmed) {
    try {
      const identity = await identityStore.getIdentity(trimmed);
      return {id: identity.id, handle: identity.handle};
    } catch {
      try {
        const identity = await identityStore.getIdentityByHandle(trimmed);
        return {id: identity.id, handle: identity.handle};
      } catch {
        throw new ControlHttpError(400, "Control dev login identity was not found.");
      }
    }
  }

  const identities = (await identityStore.listIdentities()).filter((identity) => identity.status === "active");
  if (identities.length === 1) {
    return {id: identities[0]!.id, handle: identities[0]!.handle};
  }
  throw new ControlHttpError(400, "Control dev login identity is required.");
}

async function resolveControlGrantIdentity(
  identityStore: Pick<IdentityStore, "getIdentity" | "getIdentityByHandle">,
  input: Record<string, unknown>,
): Promise<{id: string; handle: string}> {
  const identityId = optionalNonEmptyString(input.identityId);
  const identityHandle = optionalNonEmptyString(input.identityHandle ?? input.identity);
  if (!identityId && !identityHandle) {
    throw new ControlHttpError(400, "Control grant identity is required.");
  }
  if (identityId && identityHandle) {
    throw new ControlHttpError(400, "Pass either identity id or identity handle, not both.");
  }

  try {
    const identity = identityId
      ? await identityStore.getIdentity(identityId)
      : await identityStore.getIdentityByHandle(identityHandle!);
    return {id: identity.id, handle: identity.handle};
  } catch {
    throw new ControlHttpError(400, "Control grant identity was not found.");
  }
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readJsonHttpBody(request, {
    maxBytes: 16 * 1024,
    tooLargeMessage: "Control request body is too large.",
    invalidJsonPrefix: "Invalid Control JSON body",
    createError: (status, message) => new ControlHttpError(status, message),
  });
  return typeof body === "object" && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : {};
}

async function authenticate(request: IncomingMessage, auth: PostgresControlAuthService): Promise<ControlSessionRecord> {
  const token = parseCookies(request.headers.cookie)[CONTROL_SESSION_COOKIE];
  if (!token) throw new ControlHttpError(401, "Control authentication required.");
  const session = await auth.getSessionByToken(token);
  if (!session) throw new ControlHttpError(401, "Control authentication required.");
  return session;
}


function parseConnectorAccountsLimit(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) throw new ControlHttpError(400, "Control connector accounts limit must be a positive integer.");
  return Math.min(100, limit);
}

function parsePositiveInt(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ControlHttpError(400, "Control table pagination values must be positive integers.");
  }
  return parsed;
}

function parseSortDirection(value: string | null): ControlSortDirection | undefined {
  if (value === null || value.trim() === "") return undefined;
  if (value === "asc" || value === "desc") return value;
  throw new ControlHttpError(400, "Control table sort_direction must be asc or desc.");
}

function parseTableInput(params: URLSearchParams): ControlTableInput {
  return {
    page: parsePositiveInt(params.get("page")),
    perPage: parsePositiveInt(params.get("per_page")),
    sortBy: params.get("sort_by") ?? undefined,
    sortDirection: parseSortDirection(params.get("sort_direction")),
    search: params.get("search") ?? undefined,
  };
}

function parseSkillTableInput(params: URLSearchParams): ControlSkillTableInput {
  const tag = params.get("tag")?.trim();
  return {
    ...parseTableInput(params),
    ...(tag ? {tag} : {}),
  };
}

function parseSessionKind(value: string | null): ControlSessionTableInput["kind"] | undefined {
  if (value === null || value.trim() === "") return undefined;
  if (value === "main" || value === "branch") return value;
  throw new ControlHttpError(400, "Control session kind filter must be main or branch.");
}

function parseSessionVisibility(value: string | null): ControlSessionTableInput["visibility"] | undefined {
  if (value === null || value.trim() === "") return undefined;
  if (value === "primary" || value === "subagent" || value === "all") return value;
  throw new ControlHttpError(400, "Control session visibility filter must be primary, subagent, or all.");
}

function parseSessionTableInput(params: URLSearchParams): ControlSessionTableInput {
  return {
    ...parseTableInput(params),
    kind: parseSessionKind(params.get("kind")),
    visibility: parseSessionVisibility(params.get("visibility")),
  };
}

function parseConnectorSource(value: string | null): ControlConnectorTableInput["source"] | undefined {
  if (value === null || value.trim() === "") return undefined;
  if (value === "discord" || value === "email" || value === "telegram") return value;
  throw new ControlHttpError(400, "Control connector source filter must be discord, email, or telegram.");
}

function parseConnectorStatus(value: string | null): ControlConnectorTableInput["status"] | undefined {
  if (value === null || value.trim() === "") return undefined;
  if (value === "enabled" || value === "disabled" || value === "error" || value === "revoked") return value;
  throw new ControlHttpError(400, "Control connector status filter is unsupported.");
}

function parseConnectorTableInput(params: URLSearchParams): ControlConnectorTableInput {
  return {
    ...parseTableInput(params),
    source: parseConnectorSource(params.get("source")),
    status: parseConnectorStatus(params.get("status")),
  };
}

function parseBindingSource(value: string | null): ControlBindingTableInput["source"] | undefined {
  if (value === null || value.trim() === "") return undefined;
  if (value === "discord" || value === "email" || value === "telegram") return value;
  throw new ControlHttpError(400, "Control binding source filter must be discord, email, or telegram.");
}

function parseBindingSessionId(value: string | null): string | undefined {
  if (value === null || value.trim() === "") return undefined;
  return value;
}

function parseBindingTableInput(params: URLSearchParams): ControlBindingTableInput {
  return {
    ...parseTableInput(params),
    source: parseBindingSource(params.get("source")),
    sessionId: parseBindingSessionId(params.get("session_id")),
  };
}

function parseEmailRouteTableInput(params: URLSearchParams): ControlEmailRouteTableInput {
  const accountKey = params.get("accountKey")?.trim();
  return {
    ...parseTableInput(params),
    ...(accountKey ? {accountKey} : {}),
  };
}

function parseEmailAllowedRecipientTableInput(params: URLSearchParams): ControlEmailAllowedRecipientTableInput {
  const accountKey = params.get("accountKey")?.trim();
  return {
    ...parseTableInput(params),
    ...(accountKey ? {accountKey} : {}),
  };
}

function parseDiscordActorPairingTableInput(params: URLSearchParams): ControlDiscordActorPairingTableInput {
  const accountKey = params.get("accountKey")?.trim();
  return {
    ...parseTableInput(params),
    ...(accountKey ? {accountKey} : {}),
  };
}

function parseChannelActorPairingSource(value: string | null): ControlChannelActorPairingSource | undefined {
  if (value === null || value.trim() === "") return undefined;
  if (value === "telegram" || value === "whatsapp") return value;
  throw new ControlHttpError(400, "Control channel actor pairing source must be telegram or whatsapp.");
}

function parseChannelActorPairingTableInput(params: URLSearchParams): ControlChannelActorPairingTableInput {
  const connectorKey = params.get("connectorKey")?.trim();
  return {
    ...parseTableInput(params),
    source: parseChannelActorPairingSource(params.get("source")),
    ...(connectorKey ? {connectorKey} : {}),
  };
}

function parseAgentPairingTableInput(params: URLSearchParams): ControlAgentPairingTableInput {
  return {
    ...parseTableInput(params),
    status: parseIdentityStatus(params.get("status")),
  };
}

function parseIdentityTableInput(params: URLSearchParams): ControlIdentityTableInput {
  return {
    ...parseTableInput(params),
    status: parseIdentityStatus(params.get("status")),
  };
}

function parseA2ABindingDirection(value: string | null): ControlA2ABindingTableInput["direction"] {
  if (value === null || value === "") return undefined;
  if (value === "outbound" || value === "inbound") return value;
  throw new ControlHttpError(400, "Control A2A binding direction must be inbound or outbound.");
}

function parseA2ABindingTableInput(params: URLSearchParams): ControlA2ABindingTableInput {
  return {
    ...parseTableInput(params),
    direction: parseA2ABindingDirection(params.get("direction")),
  };
}

function parseIdentityStatus(value: string | null): ControlAgentPairingTableInput["status"] | undefined {
  if (value === null || value.trim() === "") return undefined;
  if (value === "active" || value === "deleted") return value;
  throw new ControlHttpError(400, "Control identity status filter must be active or deleted.");
}

function parseBooleanFilter(value: string | null, label: string): boolean | undefined {
  if (value === null || value.trim() === "") return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ControlHttpError(400, `Control ${label} filter must be true or false.`);
}

function parseSubagentSource(value: string | null): ControlSubagentTableInput["source"] | undefined {
  if (value === null || value.trim() === "") return undefined;
  if (value === "builtin" || value === "custom") return value;
  throw new ControlHttpError(400, "Control subagent source filter must be builtin or custom.");
}

function parseSubagentToolGroups(params: URLSearchParams): readonly string[] | undefined {
  const values = params.getAll("toolGroups").map((value) => value.trim()).filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function parseSubagentTableInput(params: URLSearchParams): ControlSubagentTableInput {
  return {
    ...parseTableInput(params),
    enabled: parseBooleanFilter(params.get("enabled"), "subagent enabled"),
    source: parseSubagentSource(params.get("source")),
    toolGroups: parseSubagentToolGroups(params),
  };
}

function parseGatewayDeviceCapabilities(params: URLSearchParams): readonly string[] | undefined {
  const values = params.getAll("capabilities").map((value) => value.trim()).filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function parseGatewayDeviceTableInput(params: URLSearchParams): ControlGatewayDeviceTableInput {
  return {
    ...parseTableInput(params),
    enabled: parseBooleanFilter(params.get("enabled"), "gateway device enabled"),
    capabilities: parseGatewayDeviceCapabilities(params),
  };
}

function parseWatchLifecycleStatus(value: string | null): ControlWatchLifecycleStatus | undefined {
  if (value === null || value.trim() === "") return undefined;
  if (value === "enabled" || value === "disabled" || value === "cooldown" || value === "running") return value;
  throw new ControlHttpError(400, "Control watch status filter is unsupported.");
}

function parseWatchSourceKind(value: string | null): ControlWatchSourceKind | undefined {
  if (value === null || value.trim() === "") return undefined;
  if (value === "mongodb_query" || value === "sql_query" || value === "http_json" || value === "http_html" || value === "imap_mailbox") return value;
  throw new ControlHttpError(400, "Control watch source filter is unsupported.");
}

function parseWatchesTableInput(params: URLSearchParams): GetWatchesInput {
  return {
    ...parseTableInput(params),
    lifecycleStatus: parseWatchLifecycleStatus(params.get("lifecycleStatus")),
    sourceKind: parseWatchSourceKind(params.get("sourceKind")),
    limit: parsePositiveInt(params.get("limit")),
  };
}

function parseRuntimeActivityStatus(value: string | null): string | undefined {
  if (value === null || value.trim() === "") return undefined;
  return value;
}

function parseRuntimeActivityFailureCategory(value: string | null): ControlRuntimeFailureCategory | undefined {
  if (value === null || value.trim() === "") return undefined;
  if (
    value === "provider_abort"
    || value === "provider_timeout"
    || value === "provider_server_error"
    || value === "provider_transport_terminated"
    || value === "provider_transport_network"
    || value === "provider_error"
  ) {
    return value;
  }
  throw new ControlHttpError(400, "Control runtime activity failure_category filter is unsupported.");
}

function parseRuntimeActivityTableInput(params: URLSearchParams): ControlRuntimeActivityTableInput {
  return {
    ...parseTableInput(params),
    status: parseRuntimeActivityStatus(params.get("status")),
    failureCategory: parseRuntimeActivityFailureCategory(params.get("failure_category")),
    limit: parsePositiveInt(params.get("limit")),
  };
}

function parseModelCallTraceStatus(value: string | null): ModelCallTraceStatus | undefined {
  if (value === null || value.trim() === "") return undefined;
  if (value === "completed" || value === "failed") return value;
  throw new ControlHttpError(400, "Control model call trace status filter is unsupported.");
}

function parseModelCallTraceMode(value: string | null): ModelCallTraceMode | undefined {
  if (value === null || value.trim() === "") return undefined;
  if (value === "complete" || value === "stream") return value;
  throw new ControlHttpError(400, "Control model call trace mode filter is unsupported.");
}

function parseModelCallTraceTableInput(params: URLSearchParams) {
  return {
    ...parseTableInput(params),
    status: parseModelCallTraceStatus(params.get("status")),
    mode: parseModelCallTraceMode(params.get("mode")),
    runId: params.get("run_id") ?? undefined,
    sessionId: params.get("session_id") ?? undefined,
    agentKey: params.get("agent_key") ?? undefined,
  };
}

function parseModelCallUsageInput(params: URLSearchParams) {
  return {
    rangeHours: parsePositiveInt(params.get("range_hours")),
    bucketMinutes: parsePositiveInt(params.get("bucket_minutes")),
  };
}

function parseScheduledTaskStatus(value: string | null): ControlScheduledTaskLifecycleStatus | undefined {
  if (value === null || value.trim() === "") return undefined;
  if (value === "scheduled" || value === "disabled" || value === "running" || value === "completed" || value === "cancelled") return value;
  throw new ControlHttpError(400, "Control scheduled task status filter is unsupported.");
}

function parseScheduledTasksTableInput(params: URLSearchParams): GetScheduledTasksInput {
  return {
    ...parseTableInput(params),
    lifecycleStatus: parseScheduledTaskStatus(params.get("lifecycleStatus")),
    enabled: parseBooleanFilter(params.get("enabled"), "scheduled task enabled"),
    limit: parsePositiveInt(params.get("limit")),
  };
}

function parseWorkFailureSeverity(value: string | null): ControlWorkFailureTableInput["severity"] | undefined {
  if (value === null || value.trim() === "") return undefined;
  if (value === "warning" || value === "critical") return value;
  throw new ControlHttpError(400, "Control work failure severity filter must be warning or critical.");
}

function parseWorkFailureKind(value: string | null): ControlWorkFailureKind | undefined {
  if (value === null || value.trim() === "") return undefined;
  if (
    value === "runtime_run"
    || value === "scheduled_task_run"
    || value === "outbound_delivery"
    || value === "gateway_event"
    || value === "gateway_device_command"
    || value === "connector_account"
  ) {
    return value;
  }
  throw new ControlHttpError(400, "Control work failure kind filter is unsupported.");
}

function parseWorkFailureTableInput(params: URLSearchParams): ControlWorkFailureTableInput {
  return {
    ...parseTableInput(params),
    severity: parseWorkFailureSeverity(params.get("severity")),
    kind: parseWorkFailureKind(params.get("kind")),
  };
}

function matchAgentPath(path: string): {agentKey: string} | null {
  const match = /^\/agents\/([^/]+)$/.exec(path);
  if (!match) return null;
  return {agentKey: decodeURIComponent(match[1]!)};
}

function matchAgentResourcePath(path: string, resource: string): {agentKey: string} | null {
  const match = new RegExp(`^/agents/([^/]+)/${resource}$`).exec(path);
  if (!match) return null;
  return {agentKey: decodeURIComponent(match[1]!)};
}

function matchAgentMcpServerPath(path: string): {agentKey: string; serverName: string} | null {
  const match = /^\/agents\/([^/]+)\/mcp-servers\/([^/]+)$/.exec(path);
  if (!match) return null;
  return {agentKey: decodeURIComponent(match[1]!), serverName: decodeURIComponent(match[2]!)};
}

function matchAgentMcpOAuthPath(path: string): {agentKey: string; serverName: string; action?: "discover" | "start"} | null {
  const match = /^\/agents\/([^/]+)\/mcp-servers\/([^/]+)\/oauth(?:\/(discover|start))?$/.exec(path);
  if (!match) return null;
  return {
    agentKey: decodeURIComponent(match[1]!),
    serverName: decodeURIComponent(match[2]!),
    ...(match[3] ? {action: match[3] as "discover" | "start"} : {}),
  };
}

function writeOAuthCallbackPage(response: ServerResponse, status: 200 | 400, success: boolean): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
  });
  response.end(`<!doctype html><html><head><meta charset="utf-8"><title>Panda MCP OAuth</title><style>body{font-family:system-ui;margin:3rem;max-width:42rem}</style></head><body><h1>${success ? "MCP connected" : "MCP connection failed"}</h1><p>${success ? "Authorization completed. You can close this tab and return to Panda Control." : "The authorization response was invalid, expired, or could not be exchanged. Return to Panda Control and try again."}</p></body></html>`);
}

function matchAgentCredentialPath(path: string): {agentKey: string; envKey: string} | null {
  const match = /^\/agents\/([^/]+)\/credentials\/([^/]+)$/.exec(path);
  if (!match) return null;
  return {agentKey: decodeURIComponent(match[1]!), envKey: decodeURIComponent(match[2]!)};
}

function matchAgentSkillPath(path: string): {agentKey: string; skillKey: string} | null {
  const match = /^\/agents\/([^/]+)\/skills\/([^/]+)$/.exec(path);
  if (!match) return null;
  return {agentKey: decodeURIComponent(match[1]!), skillKey: decodeURIComponent(match[2]!)};
}

function matchAgentSubagentPath(path: string): {agentKey: string; slug: string} | null {
  const match = /^\/agents\/([^/]+)\/subagents\/([^/]+)$/.exec(path);
  if (!match) return null;
  return {agentKey: decodeURIComponent(match[1]!), slug: decodeURIComponent(match[2]!)};
}

function matchSessionPath(path: string): {agentKey: string; sessionId: string} | null {
  const match = /^\/agents\/([^/]+)\/sessions\/([^/]+)$/.exec(path);
  if (!match) return null;
  return {agentKey: decodeURIComponent(match[1]!), sessionId: decodeURIComponent(match[2]!)};
}

function matchSessionActionPath(path: string, action: string): {agentKey: string; sessionId: string} | null {
  const match = new RegExp(`^/agents/([^/]+)/sessions/([^/]+)/${action}$`).exec(path);
  if (!match) return null;
  return {agentKey: decodeURIComponent(match[1]!), sessionId: decodeURIComponent(match[2]!)};
}

function matchSessionTargetPath(path: string): {agentKey: string; sessionId: string; alias: string} | null {
  const match = /^\/agents\/([^/]+)\/sessions\/([^/]+)\/targets\/([^/]+)$/.exec(path);
  if (!match) return null;
  return {
    agentKey: decodeURIComponent(match[1]!),
    sessionId: decodeURIComponent(match[2]!),
    alias: decodeURIComponent(match[3]!),
  };
}

function matchSessionA2ABindingPath(path: string): {agentKey: string; sessionId: string; recipientSessionId: string} | null {
  const match = /^\/agents\/([^/]+)\/sessions\/([^/]+)\/a2a-bindings\/([^/]+)$/.exec(path);
  if (!match) return null;
  return {
    agentKey: decodeURIComponent(match[1]!),
    sessionId: decodeURIComponent(match[2]!),
    recipientSessionId: decodeURIComponent(match[3]!),
  };
}

function matchConnectorStatusPath(path: string): {agentKey: string; source: string; accountKey: string} | null {
  const match = /^\/agents\/([^/]+)\/connectors\/([^/]+)\/([^/]+)\/status$/.exec(path);
  if (!match) return null;
  return {agentKey: decodeURIComponent(match[1]!), source: decodeURIComponent(match[2]!), accountKey: decodeURIComponent(match[3]!)};
}

function matchTelegramSetupStatusPath(path: string): {agentKey: string} | null {
  const match = /^\/agents\/([^/]+)\/telegram\/setup-status$/.exec(path);
  if (!match) return null;
  return {agentKey: decodeURIComponent(match[1]!)};
}

function matchBindingPath(path: string): {agentKey: string; source: string; connectorKey: string; externalConversationId: string} | null {
  const match = /^\/agents\/([^/]+)\/bindings\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(path);
  if (!match) return null;
  return {
    agentKey: decodeURIComponent(match[1]!),
    source: decodeURIComponent(match[2]!),
    connectorKey: decodeURIComponent(match[3]!),
    externalConversationId: decodeURIComponent(match[4]!),
  };
}

function matchEmailRoutePath(path: string): {agentKey: string; accountKey: string} | null {
  const match = /^\/agents\/([^/]+)\/email\/routes\/([^/]+)$/.exec(path);
  if (!match) return null;
  return {agentKey: decodeURIComponent(match[1]!), accountKey: decodeURIComponent(match[2]!)};
}

function matchEmailAllowedRecipientPath(path: string): {agentKey: string; accountKey: string; address: string} | null {
  const match = /^\/agents\/([^/]+)\/email\/allowlist\/([^/]+)\/([^/]+)$/.exec(path);
  if (!match) return null;
  return {
    agentKey: decodeURIComponent(match[1]!),
    accountKey: decodeURIComponent(match[2]!),
    address: decodeURIComponent(match[3]!),
  };
}

function matchDiscordActorPairingPath(path: string): {agentKey: string; accountKey: string; externalActorId: string} | null {
  const match = /^\/agents\/([^/]+)\/discord\/actor-pairings\/([^/]+)\/([^/]+)$/.exec(path);
  if (!match) return null;
  return {
    agentKey: decodeURIComponent(match[1]!),
    accountKey: decodeURIComponent(match[2]!),
    externalActorId: decodeURIComponent(match[3]!),
  };
}

function matchChannelActorPairingPath(path: string): {agentKey: string; source: string; connectorKey: string; externalActorId: string} | null {
  const match = /^\/agents\/([^/]+)\/channel-actor-pairings\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(path);
  if (!match) return null;
  return {
    agentKey: decodeURIComponent(match[1]!),
    source: decodeURIComponent(match[2]!),
    connectorKey: decodeURIComponent(match[3]!),
    externalActorId: decodeURIComponent(match[4]!),
  };
}

function matchAgentPairingPath(path: string): {agentKey: string; identityId: string} | null {
  const match = /^\/agents\/([^/]+)\/pairings\/([^/]+)$/.exec(path);
  if (!match) return null;
  return {
    agentKey: decodeURIComponent(match[1]!),
    identityId: decodeURIComponent(match[2]!),
  };
}

function matchIdentityPath(path: string): {identityId: string} | null {
  const match = /^\/identities\/([^/]+)$/.exec(path);
  if (!match) return null;
  return {identityId: decodeURIComponent(match[1]!)};
}

function matchGatewaySourcePath(path: string): {agentKey: string; sourceId: string} | null {
  const match = /^\/agents\/([^/]+)\/gateway\/sources\/([^/]+)$/.exec(path);
  if (!match) return null;
  return {agentKey: decodeURIComponent(match[1]!), sourceId: decodeURIComponent(match[2]!)};
}

function matchGatewaySourceActionPath(path: string, action: string): {agentKey: string; sourceId: string} | null {
  const match = new RegExp(`^/agents/([^/]+)/gateway/sources/([^/]+)/${action}$`).exec(path);
  if (!match) return null;
  return {agentKey: decodeURIComponent(match[1]!), sourceId: decodeURIComponent(match[2]!)};
}

function matchGatewayDevicePath(path: string): {agentKey: string; sourceId: string; deviceId: string} | null {
  const match = /^\/agents\/([^/]+)\/gateway\/sources\/([^/]+)\/devices\/([^/]+)$/.exec(path);
  if (!match) return null;
  return {agentKey: decodeURIComponent(match[1]!), sourceId: decodeURIComponent(match[2]!), deviceId: decodeURIComponent(match[3]!)};
}

function matchGatewayEventTypePath(path: string): {agentKey: string; sourceId: string; type: string} | null {
  const match = /^\/agents\/([^/]+)\/gateway\/sources\/([^/]+)\/event-types\/([^/]+)$/.exec(path);
  if (!match) return null;
  return {agentKey: decodeURIComponent(match[1]!), sourceId: decodeURIComponent(match[2]!), type: decodeURIComponent(match[3]!)};
}

function matchSessionHeartbeatPath(path: string): {agentKey: string; sessionId: string} | null {
  const match = /^\/agents\/([^/]+)\/sessions\/([^/]+)\/heartbeat$/.exec(path);
  if (!match) return null;
  return {agentKey: decodeURIComponent(match[1]!), sessionId: decodeURIComponent(match[2]!)};
}

function matchSessionWatchesPath(path: string): {agentKey: string; sessionId: string} | null {
  const match = /^\/agents\/([^/]+)\/sessions\/([^/]+)\/watches$/.exec(path);
  if (!match) return null;
  return {agentKey: decodeURIComponent(match[1]!), sessionId: decodeURIComponent(match[2]!)};
}

function matchSessionWatchPath(path: string): {agentKey: string; sessionId: string; watchId: string} | null {
  const match = /^\/agents\/([^/]+)\/sessions\/([^/]+)\/watches\/([^/]+)$/.exec(path);
  if (!match) return null;
  return {agentKey: decodeURIComponent(match[1]!), sessionId: decodeURIComponent(match[2]!), watchId: decodeURIComponent(match[3]!)};
}

function matchSessionRuntimeActivityPath(path: string): {agentKey: string; sessionId: string} | null {
  const match = /^\/agents\/([^/]+)\/sessions\/([^/]+)\/runtime-activity$/.exec(path);
  if (!match) return null;
  return {agentKey: decodeURIComponent(match[1]!), sessionId: decodeURIComponent(match[2]!)};
}

function matchAgentConnectorsPath(path: string): {agentKey: string} | null {
  const match = /^\/agents\/([^/]+)\/connectors$/.exec(path);
  if (!match) return null;
  return {agentKey: decodeURIComponent(match[1]!)};
}

function matchModelCallTracePath(path: string): {traceId: string} | null {
  const match = /^\/model-call-traces\/([^/]+)$/.exec(path);
  if (!match) return null;
  return {traceId: decodeURIComponent(match[1]!)};
}

function matchSessionScheduledTasksPath(path: string): {agentKey: string; sessionId: string} | null {
  const match = /^\/agents\/([^/]+)\/sessions\/([^/]+)\/scheduled-tasks$/.exec(path);
  if (!match) return null;
  return {agentKey: decodeURIComponent(match[1]!), sessionId: decodeURIComponent(match[2]!)};
}

function matchSessionScheduledTaskPath(path: string): {agentKey: string; sessionId: string; taskId: string} | null {
  const match = /^\/agents\/([^/]+)\/sessions\/([^/]+)\/scheduled-tasks\/([^/]+)$/.exec(path);
  if (!match) return null;
  return {agentKey: decodeURIComponent(match[1]!), sessionId: decodeURIComponent(match[2]!), taskId: decodeURIComponent(match[3]!)};
}

function matchSessionBriefingPath(path: string): {agentKey: string; sessionId: string} | null {
  const match = /^\/agents\/([^/]+)\/sessions\/([^/]+)\/briefing$/.exec(path);
  if (!match) return null;
  return {agentKey: decodeURIComponent(match[1]!), sessionId: decodeURIComponent(match[2]!)};
}

function matchSessionPromptsPath(path: string): {agentKey: string; sessionId: string} | null {
  const match = /^\/agents\/([^/]+)\/sessions\/([^/]+)\/prompts$/.exec(path);
  if (!match) return null;
  return {agentKey: decodeURIComponent(match[1]!), sessionId: decodeURIComponent(match[2]!)};
}

function matchSessionPromptPath(path: string): {agentKey: string; sessionId: string; slug: string} | null {
  const match = /^\/agents\/([^/]+)\/sessions\/([^/]+)\/prompts\/([^/]+)$/.exec(path);
  if (!match) return null;
  return {
    agentKey: decodeURIComponent(match[1]!),
    sessionId: decodeURIComponent(match[2]!),
    slug: decodeURIComponent(match[3]!),
  };
}

async function recordHeartbeatAudit(auth: PostgresControlAuthService, session: ControlSessionRecord, metadata: unknown): Promise<void> {
  await auth.recordAudit({
    identityId: session.identityId,
    sessionId: session.id,
    eventType: "session_heartbeat_config_write",
    metadata,
  });
}

async function recordBriefingAudit(auth: PostgresControlAuthService, session: ControlSessionRecord, metadata: unknown): Promise<void> {
  await auth.recordAudit({
    identityId: session.identityId,
    sessionId: session.id,
    eventType: "session_briefing_write",
    metadata,
  });
}

async function recordSessionPromptAudit(auth: PostgresControlAuthService, session: ControlSessionRecord, metadata: unknown): Promise<void> {
  await auth.recordAudit({
    identityId: session.identityId,
    sessionId: session.id,
    eventType: "session_prompt_write",
    metadata,
  });
}

async function recordScheduledTaskAudit(auth: PostgresControlAuthService, session: ControlSessionRecord, metadata: unknown): Promise<void> {
  await auth.recordAudit({
    identityId: session.identityId,
    sessionId: session.id,
    eventType: "session_scheduled_task_write",
    metadata,
  });
}

async function recordWatchAudit(auth: PostgresControlAuthService, session: ControlSessionRecord, metadata: unknown): Promise<void> {
  await auth.recordAudit({
    identityId: session.identityId,
    sessionId: session.id,
    eventType: "session_watch_config_write",
    metadata,
  });
}

async function recordOperatorAudit(auth: PostgresControlAuthService, session: ControlSessionRecord, metadata: unknown): Promise<void> {
  await auth.recordAudit({
    identityId: session.identityId,
    sessionId: session.id,
    eventType: "control_operator_write",
    metadata,
  });
}

function requireCsrf(request: IncomingMessage, auth: PostgresControlAuthService, session: ControlSessionRecord): void {
  const token = request.headers["x-control-csrf"] ?? request.headers["x-csrf-token"];
  const value = Array.isArray(token) ? token[0] : token;
  if (!value || !auth.verifyCsrfToken(session, value)) {
    throw new ControlHttpError(403, "Valid Control CSRF token required.");
  }
}

export async function startControlServer(options: StartControlServerOptions): Promise<ControlHttpServer> {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      const isControlApiPath = url.pathname === "/api/control" || url.pathname.startsWith("/api/control/");
      if (!isControlApiPath) {
        if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
          writeJsonResponse(response, 404, {error: "not_found"});
          return;
        }
        const served = await serveStaticAsset(request, response, options.uiStaticDir ?? DEFAULT_CONTROL_UI_STATIC_DIR, url.pathname);
        if (!served) writeJsonResponse(response, 404, {error: "not_found"});
        return;
      }
      const path = url.pathname.replace(/^\/api\/control\/?/, "/");

      if (request.method === "GET" && path === "/health") {
        writeJsonResponse(response, 200, {ok: true});
        return;
      }
      if (request.method === "GET" && path === "/bootstrap") {
        writeJsonResponse(response, 200, {hasGrant: await options.auth.hasAnyGrant()});
        return;
      }
      if (request.method === "POST" && path === "/dev-login") {
        const env = options.env ?? process.env;
        const status = devLoginStatus(env, request);
        if (status === "disabled") {
          throw new ControlHttpError(404, "Control dev login is not available in this environment.");
        }
        if (status === "production" || status === "remote") {
          throw new ControlHttpError(403, "Control dev login is not allowed in this environment.");
        }

        const body = await readBody(request);
        const bodyIdentity = [body.identity, body.identityId, body.handle].find((value): value is string => typeof value === "string");
        const identity = await resolveDevLoginIdentity(options.identityStore, bodyIdentity ?? env.PANDA_CONTROL_DEV_LOGIN_IDENTITY);
        const role = parseControlRole(typeof body.role === "string" ? body.role : env.PANDA_CONTROL_DEV_LOGIN_ROLE);
        const bodyAgentKey = typeof body.agentKey === "string" ? body.agentKey.trim() : "";
        const envAgentKey = env.PANDA_CONTROL_DEV_LOGIN_AGENT_KEY?.trim() ?? "";
        const agentKey = bodyAgentKey || envAgentKey || undefined;
        if (role === "scoped" && !agentKey) {
          throw new ControlHttpError(400, "Scoped Control dev login requires an agent key.");
        }

        const grant = await options.auth.createGrant({
          identityId: identity.id,
          role,
          ...(role === "scoped" ? {agentKey} : {}),
          label: `Control dev login (${identity.handle})`,
          loginTokenTtlMs: 30_000,
        });
        const login = await options.auth.loginWithToken(grant.loginToken);
        await options.auth.recordAudit({
          identityId: login.session.identityId,
          sessionId: login.session.id,
          eventType: "control_dev_login",
          metadata: {
            identityHandle: identity.handle,
            role,
            ...(role === "scoped" ? {agentKey} : {}),
          },
        });
        setCookie(response, CONTROL_SESSION_COOKIE, login.sessionToken);
        setCookie(response, CONTROL_CSRF_COOKIE, login.csrfToken, "SameSite=Strict; Path=/");
        writeJsonResponse(response, 200, {session: publicSession(login.session), csrfToken: login.csrfToken});
        return;
      }
      if (request.method === "POST" && path === "/login") {
        const body = await readBody(request);
        const token = typeof body.token === "string" ? body.token : "";
        const remember = body.remember === true;
        let login;
        try {
          login = await options.auth.loginWithToken(token, {remember});
        } catch {
          throw new ControlHttpError(401, "Control login token is invalid, expired, or already used.");
        }
        const maxAge = remember ? `; Max-Age=${rememberCookieMaxAgeSeconds()}` : "";
        setCookie(response, CONTROL_SESSION_COOKIE, login.sessionToken, `HttpOnly; SameSite=Strict; Path=/api/control${maxAge}`);
        setCookie(response, CONTROL_CSRF_COOKIE, login.csrfToken, `SameSite=Strict; Path=/${maxAge}`);
        writeJsonResponse(response, 200, {session: publicSession(login.session), csrfToken: login.csrfToken});
        return;
      }

      if (request.method === "GET" && path === "/mcp/oauth/callback") {
        const state = url.searchParams.get("state") ?? "";
        const code = url.searchParams.get("code") ?? "";
        const oauthError = url.searchParams.get("error");
        if (!state) {
          writeOAuthCallbackPage(response, 400, false);
          return;
        }
        if (oauthError || !code) {
          try {
            const result = await options.mcp.failOAuth(state, oauthError ? "authorization_denied" : "missing_code");
            await options.auth.recordAudit({identityId: result.identityId, sessionId: result.sessionId, eventType: "control_operator_write", metadata: result.audit});
          } catch {
            // The generic failure page intentionally does not reveal state validity.
          }
          writeOAuthCallbackPage(response, 400, false);
          return;
        }
        try {
          const result = await options.mcp.finishOAuth(state, code);
          await options.auth.recordAudit({identityId: result.identityId, sessionId: result.sessionId, eventType: "control_operator_write", metadata: result.audit});
          writeOAuthCallbackPage(response, result.completed ? 200 : 400, result.completed);
        } catch {
          writeOAuthCallbackPage(response, 400, false);
        }
        return;
      }

      const session = await authenticate(request, options.auth);
      if (request.method === "GET" && path === "/me") {
        writeJsonResponse(response, 200, {session: publicSession(session)});
        return;
      }
      if (request.method === "POST" && path === "/logout") {
        requireCsrf(request, options.auth, session);
        await options.auth.revokeSession(session.id);
        await options.auth.recordAudit({identityId: session.identityId, sessionId: session.id, eventType: "logout"});
        clearCookie(response, CONTROL_SESSION_COOKIE);
        clearCookie(response, CONTROL_CSRF_COOKIE, "SameSite=Strict; Path=/; Max-Age=0");
        writeJsonResponse(response, 200, {ok: true});
        return;
      }
      if (request.method === "GET" && path === "/overview") {
        writeJsonResponse(response, 200, await options.reads.getOverview(session));
        return;
      }
      if (request.method === "GET" && path === "/home") {
        writeJsonResponse(response, 200, {home: await options.home.getHome(session)});
        return;
      }
      if (request.method === "GET" && path === "/work-failures") {
        writeJsonResponse(response, 200, await options.operator.listWorkFailures(session, parseWorkFailureTableInput(url.searchParams)));
        return;
      }
      if (request.method === "GET" && path === "/model-call-traces") {
        try {
          const traces = await options.modelCallTraces.listModelCallTraces(session, parseModelCallTraceTableInput(url.searchParams));
          writeJsonResponse(response, 200, {modelCallTraces: traces});
        } catch (error) {
          const message = error instanceof Error ? error.message : "Control model call trace read failed.";
          if (message === "Control model call traces require admin access.") throw new ControlHttpError(403, message);
          if (message.includes("model call trace") || message.includes("pagination")) throw new ControlHttpError(400, message);
          throw error;
        }
        return;
      }
      if (request.method === "GET" && path === "/model-call-usage") {
        try {
          const usage = await options.modelCallTraces.getModelCallUsage(session, parseModelCallUsageInput(url.searchParams));
          writeJsonResponse(response, 200, {modelCallUsage: usage});
        } catch (error) {
          const message = error instanceof Error ? error.message : "Control model call usage read failed.";
          if (message === "Control model call traces require admin access.") throw new ControlHttpError(403, message);
          if (message.includes("model call usage")) throw new ControlHttpError(400, message);
          throw error;
        }
        return;
      }
      const modelCallTracePath = matchModelCallTracePath(path);
      if (modelCallTracePath && request.method === "GET") {
        try {
          const trace = await options.modelCallTraces.getModelCallTrace(session, modelCallTracePath.traceId);
          if (!trace) throw new ControlHttpError(404, "Control model call trace was not found.");
          writeJsonResponse(response, 200, {modelCallTrace: trace});
        } catch (error) {
          if (error instanceof ControlHttpError) throw error;
          const message = error instanceof Error ? error.message : "Control model call trace read failed.";
          if (message === "Control model call traces require admin access.") throw new ControlHttpError(403, message);
          throw new ControlHttpError(400, message);
        }
        return;
      }
      if (request.method === "GET" && path === "/search") {
        writeJsonResponse(response, 200, await options.operator.search(session, parseTableInput(url.searchParams)));
        return;
      }
      if (request.method === "GET" && path === "/agents") {
        writeJsonResponse(response, 200, await options.operator.listAgents(session, parseTableInput(url.searchParams)));
        return;
      }
      if (request.method === "GET" && path === "/identities") {
        writeJsonResponse(response, 200, await options.operator.listIdentities(session, parseIdentityTableInput(url.searchParams)));
        return;
      }
      if (request.method === "POST" && path === "/identities") {
        requireCsrf(request, options.auth, session);
        try {
          const result = await options.operator.createIdentity(session, await readBody(request));
          await recordOperatorAudit(options.auth, session, result.audit);
          writeJsonResponse(response, 201, {identity: result.identity});
        } catch (error) {
          const message = error instanceof Error ? error.message : "Control identity create failed.";
          throw new ControlHttpError(message === "Control identity management requires admin access." ? 403 : 400, message);
        }
        return;
      }
      if (request.method === "POST" && path === "/control-grants") {
        requireCsrf(request, options.auth, session);
        if (session.role !== "admin") {
          throw new ControlHttpError(403, "Control grant issuance requires admin access.");
        }
        const body = await readBody(request);
        const role = parseGrantRole(body.role);
        const identity = await resolveControlGrantIdentity(options.identityStore, body);
        const agentKey = optionalNonEmptyString(body.agentKey);
        if (role === "admin" && agentKey) {
          throw new ControlHttpError(400, "Admin Control grants must not specify an agent.");
        }
        if (role === "scoped") {
          if (!agentKey) {
            throw new ControlHttpError(400, "Scoped Control grants require an agent.");
          }
          try {
            await options.operator.getAgent(session, agentKey);
          } catch {
            throw new ControlHttpError(404, "Control grant target agent was not found or is not visible.");
          }
        }
        const created = await options.auth.createGrant({
          identityId: identity.id,
          role,
          ...(agentKey ? {agentKey} : {}),
          label: optionalNonEmptyString(body.label),
        });
        const grant = publicControlGrant(created.grant);
        await recordOperatorAudit(options.auth, session, {
          action: "issue_control_grant",
          grantId: created.grant.id,
          identityId: identity.id,
          identityHandle: identity.handle,
          role,
          ...(created.grant.agentKey ? {agentKey: created.grant.agentKey} : {}),
          ...(created.grant.label ? {label: created.grant.label} : {}),
          loginTokenExpiresAt: grant.loginTokenExpiresAt,
        });
        writeJsonResponse(response, 201, {grant, loginToken: created.loginToken});
        return;
      }
      const identityPath = matchIdentityPath(path);
      if (identityPath && request.method === "PATCH") {
        requireCsrf(request, options.auth, session);
        try {
          const result = await options.operator.updateIdentity(session, identityPath.identityId, await readBody(request));
          await recordOperatorAudit(options.auth, session, result.audit);
          writeJsonResponse(response, 200, {identity: result.identity});
        } catch (error) {
          const message = error instanceof Error ? error.message : "Control identity update failed.";
          throw new ControlHttpError(message === "Control identity management requires admin access." ? 403 : 400, message);
        }
        return;
      }
      if (identityPath && request.method === "DELETE") {
        requireCsrf(request, options.auth, session);
        try {
          const result = await options.operator.disableIdentity(session, identityPath.identityId);
          await recordOperatorAudit(options.auth, session, result.audit);
          writeJsonResponse(response, 200, {identity: result.identity});
        } catch (error) {
          const message = error instanceof Error ? error.message : "Control identity disable failed.";
          throw new ControlHttpError(message === "Control identity management requires admin access." ? 403 : 400, message);
        }
        return;
      }
      const agentPath = matchAgentPath(path);
      if (agentPath && request.method === "GET") {
        try {
          writeJsonResponse(response, 200, {agent: await options.operator.getAgent(session, agentPath.agentKey)});
        } catch {
          throw new ControlHttpError(404, "Control target agent was not found or is not visible.");
        }
        return;
      }
      const mcpServersPath = matchAgentResourcePath(path, "mcp-servers");
      if (mcpServersPath && request.method === "GET") {
        try {
          writeJsonResponse(response, 200, await options.mcp.listServers(session, mcpServersPath.agentKey));
        } catch {
          throw new ControlHttpError(404, "Control MCP target agent was not found or is not visible.");
        }
        return;
      }
      const mcpServerPath = matchAgentMcpServerPath(path);
      const mcpOAuthPath = matchAgentMcpOAuthPath(path);
      if (mcpOAuthPath?.action === "discover" && request.method === "POST") {
        requireCsrf(request, options.auth, session);
        try {
          const result = await options.mcp.discoverOAuth(session, mcpOAuthPath.agentKey, mcpOAuthPath.serverName);
          await recordOperatorAudit(options.auth, session, result.audit);
          writeJsonResponse(response, 200, {discovery: result.discovery});
        } catch (error) {
          await recordOperatorAudit(options.auth, session, {action: "fail_mcp_oauth", agentKey: mcpOAuthPath.agentKey, serverName: mcpOAuthPath.serverName, reason: "discovery_failed"});
          throw new ControlHttpError(400, error instanceof Error ? error.message : "Control MCP OAuth discovery failed.");
        }
        return;
      }
      if (mcpOAuthPath?.action === "start" && request.method === "POST") {
        requireCsrf(request, options.auth, session);
        try {
          const body = await readBody(request);
          const result = await options.mcp.startOAuth(session, mcpOAuthPath.agentKey, mcpOAuthPath.serverName, {manualClient: body.manualClient});
          await recordOperatorAudit(options.auth, session, result.audit);
          writeJsonResponse(response, 200, {authorizationUrl: result.authorizationUrl, expiresAt: result.expiresAt});
        } catch (error) {
          await recordOperatorAudit(options.auth, session, {action: "fail_mcp_oauth", agentKey: mcpOAuthPath.agentKey, serverName: mcpOAuthPath.serverName, reason: "connect_start_failed"});
          throw new ControlHttpError(400, error instanceof Error ? error.message : "Control MCP OAuth start failed.");
        }
        return;
      }
      if (mcpOAuthPath && !mcpOAuthPath.action && request.method === "DELETE") {
        requireCsrf(request, options.auth, session);
        try {
          const result = await options.mcp.disconnectOAuth(session, mcpOAuthPath.agentKey, mcpOAuthPath.serverName);
          await recordOperatorAudit(options.auth, session, result.audit);
          writeJsonResponse(response, 200, {disconnected: result.disconnected});
        } catch (error) {
          throw new ControlHttpError(400, error instanceof Error ? error.message : "Control MCP OAuth disconnect failed.");
        }
        return;
      }
      if (mcpServerPath && request.method === "PUT") {
        requireCsrf(request, options.auth, session);
        try {
          const result = await options.mcp.putServer(session, mcpServerPath.agentKey, mcpServerPath.serverName, await readBody(request));
          await recordOperatorAudit(options.auth, session, result.audit);
          writeJsonResponse(response, 200, {server: result.server});
        } catch (error) {
          const message = error instanceof Error ? error.message : "Control MCP server update failed.";
          throw new ControlHttpError(message === "Control target agent was not found or is not visible." ? 404 : 400, message);
        }
        return;
      }
      if (mcpServerPath && request.method === "DELETE") {
        requireCsrf(request, options.auth, session);
        try {
          const result = await options.mcp.deleteServer(session, mcpServerPath.agentKey, mcpServerPath.serverName);
          await recordOperatorAudit(options.auth, session, result.audit);
          writeJsonResponse(response, 200, {deleted: result.deleted});
        } catch (error) {
          const message = error instanceof Error ? error.message : "Control MCP server delete failed.";
          throw new ControlHttpError(message === "Control target agent was not found or is not visible." ? 404 : 400, message);
        }
        return;
      }

      if (request.method === "GET" && path === "/credentials") {
        writeJsonResponse(response, 200, {credentials: await options.reads.listCredentials(session)});
        return;
      }
      if (request.method === "GET" && path === "/audit-events") {
        const audit = await options.operator.listAuditEvents(session, {
          ...parseTableInput(url.searchParams),
          eventType: url.searchParams.get("eventType") ?? undefined,
          agentKey: url.searchParams.get("agentKey") ?? undefined,
          targetSessionId: url.searchParams.get("targetSessionId") ?? undefined,
        });
        writeJsonResponse(response, 200, {...audit, auditEvents: audit.data});
        return;
      }

      const agentPairingsPath = matchAgentResourcePath(path, "pairings");
      if (agentPairingsPath && request.method === "GET") {
        const tableInput = parseAgentPairingTableInput(url.searchParams);
        try {
          writeJsonResponse(response, 200, await options.operator.listAgentPairings(session, agentPairingsPath.agentKey, tableInput));
        } catch (error) {
          const message = error instanceof Error ? error.message : "Control agent pairing read failed.";
          if (message === "Control table pagination values must be positive integers.") {
            throw new ControlHttpError(400, message);
          }
          throw new ControlHttpError(404, "Control pairing target agent was not found or is not visible.");
        }
        return;
      }
      if (agentPairingsPath && request.method === "POST") {
        requireCsrf(request, options.auth, session);
        try {
          const result = await options.operator.pairAgentIdentity(session, agentPairingsPath.agentKey, await readBody(request));
          await recordOperatorAudit(options.auth, session, result.audit);
          writeJsonResponse(response, 200, {pairing: result.pairing});
        } catch (error) {
          throw new ControlHttpError(400, error instanceof Error ? error.message : "Control agent pairing write failed.");
        }
        return;
      }
      const agentPairingPath = matchAgentPairingPath(path);
      if (agentPairingPath && request.method === "DELETE") {
        requireCsrf(request, options.auth, session);
        try {
          const result = await options.operator.deleteAgentPairing(session, agentPairingPath.agentKey, agentPairingPath.identityId);
          await recordOperatorAudit(options.auth, session, result.audit);
          writeJsonResponse(response, 200, {deleted: result.deleted});
        } catch (error) {
          throw new ControlHttpError(400, error instanceof Error ? error.message : "Control agent pairing delete failed.");
        }
        return;
      }

      const sessionsPath = matchAgentResourcePath(path, "sessions");
      if (sessionsPath && request.method === "GET") {
        const tableInput = parseSessionTableInput(url.searchParams);
        try {
          writeJsonResponse(response, 200, await options.operator.listSessions(session, sessionsPath.agentKey, tableInput));
        } catch {
          throw new ControlHttpError(404, "Control target agent was not found or is not visible.");
        }
        return;
      }
      if (sessionsPath && request.method === "POST") {
        requireCsrf(request, options.auth, session);
        try {
          const result = await options.operator.createSession(session, sessionsPath.agentKey, await readBody(request));
          await recordOperatorAudit(options.auth, session, result.audit);
          writeJsonResponse(response, 201, {session: result.session});
        } catch (error) {
          throw new ControlHttpError(400, error instanceof Error ? error.message : "Control session create failed.");
        }
        return;
      }

      const sessionPath = matchSessionPath(path);
      if (sessionPath && request.method === "GET") {
        try {
          writeJsonResponse(response, 200, {session: await options.operator.getSession(session, sessionPath.agentKey, sessionPath.sessionId)});
        } catch {
          throw new ControlHttpError(404, "Control target session was not found or is not visible.");
        }
        return;
      }
      const sessionTargetsPath = matchSessionActionPath(path, "targets");
      if (sessionTargetsPath && request.method === "GET") {
        try {
          writeJsonResponse(response, 200, await options.operator.listSessionExecutionTargets(
            session,
            sessionTargetsPath.agentKey,
            sessionTargetsPath.sessionId,
          ));
          return;
        } catch {
          throw new ControlHttpError(404, "Control target session was not found or is not visible.");
        }
      }
      if (sessionTargetsPath && request.method === "POST") {
        requireCsrf(request, options.auth, session);
        try {
          const result = await options.operator.bindSessionExecutionTarget(
            session,
            sessionTargetsPath.agentKey,
            sessionTargetsPath.sessionId,
            await readBody(request),
          );
          await recordOperatorAudit(options.auth, session, result.audit);
          writeJsonResponse(response, 200, {target: result.target, targets: result.targets});
          return;
        } catch (error) {
          throw new ControlHttpError(400, error instanceof Error ? error.message : "Control execution target bind failed.");
        }
      }
      const sessionTargetPath = matchSessionTargetPath(path);
      if (sessionTargetPath && request.method === "DELETE") {
        requireCsrf(request, options.auth, session);
        try {
          const result = await options.operator.deleteSessionExecutionTarget(
            session,
            sessionTargetPath.agentKey,
            sessionTargetPath.sessionId,
            sessionTargetPath.alias,
          );
          await recordOperatorAudit(options.auth, session, result.audit);
          writeJsonResponse(response, 200, {deleted: result.deleted, targets: result.targets});
          return;
        } catch (error) {
          throw new ControlHttpError(400, error instanceof Error ? error.message : "Control execution target detach failed.");
        }
      }

      if (sessionPath && request.method === "PATCH") {
        requireCsrf(request, options.auth, session);
        try {
          const result = await options.operator.updateSessionLabel(session, sessionPath.agentKey, sessionPath.sessionId, await readBody(request));
          await recordOperatorAudit(options.auth, session, result.audit);
          writeJsonResponse(response, 200, {session: result.session});
        } catch (error) {
          throw new ControlHttpError(400, error instanceof Error ? error.message : "Control session update failed.");
        }
        return;
      }
      const sessionResetPath = matchSessionActionPath(path, "reset");
      if (sessionResetPath && request.method === "POST") {
        requireCsrf(request, options.auth, session);
        try {
          const result = await options.operator.resetSession(session, sessionResetPath.agentKey, sessionResetPath.sessionId);
          await recordOperatorAudit(options.auth, session, result.audit);
          writeJsonResponse(response, 200, {session: result.session, previousThreadId: result.previousThreadId});
        } catch (error) {
          throw new ControlHttpError(400, error instanceof Error ? error.message : "Control session reset failed.");
        }
        return;
      }
      const sessionRuntimeConfigPath = matchSessionActionPath(path, "runtime-config");
      if (sessionRuntimeConfigPath && request.method === "PATCH") {
        requireCsrf(request, options.auth, session);
        const body = await readBody(request);
        const allowed = new Set(["model", "thinking"]);
        const unknown = Object.keys(body).filter((key) => !allowed.has(key));
        if (unknown.length > 0) {
          throw new ControlHttpError(400, `Unsupported session runtime config field: ${unknown[0]}.`);
        }
        try {
          const result = await options.operator.updateSessionRuntimeConfig(
            session,
            sessionRuntimeConfigPath.agentKey,
            sessionRuntimeConfigPath.sessionId,
            body,
          );
          await recordOperatorAudit(options.auth, session, result.audit);
          writeJsonResponse(response, 200, {session: result.session});
        } catch (error) {
          throw new ControlHttpError(400, error instanceof Error ? error.message : "Control session runtime config update failed.");
        }
        return;
      }
      const sessionA2ABindingsPath = matchSessionActionPath(path, "a2a-bindings");
      if (sessionA2ABindingsPath && request.method === "GET") {
        try {
          writeJsonResponse(
            response,
            200,
            await options.operator.listSessionA2ABindings(
              session,
              sessionA2ABindingsPath.agentKey,
              sessionA2ABindingsPath.sessionId,
              parseA2ABindingTableInput(url.searchParams),
            ),
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : "Control A2A bindings read failed.";
          if (message === "Control A2A binding direction must be inbound or outbound.") throw new ControlHttpError(400, message);
          throw new ControlHttpError(404, "Control A2A target session was not found or is not visible.");
        }
        return;
      }
      if (sessionA2ABindingsPath && request.method === "POST") {
        requireCsrf(request, options.auth, session);
        try {
          const result = await options.operator.bindA2ASession(
            session,
            sessionA2ABindingsPath.agentKey,
            sessionA2ABindingsPath.sessionId,
            await readBody(request),
          );
          await recordOperatorAudit(options.auth, session, result.audit);
          writeJsonResponse(response, 200, {bindings: result.bindings});
        } catch (error) {
          throw new ControlHttpError(400, error instanceof Error ? error.message : "Control A2A binding write failed.");
        }
        return;
      }
      const sessionA2ABindingPath = matchSessionA2ABindingPath(path);
      if (sessionA2ABindingPath && request.method === "DELETE") {
        requireCsrf(request, options.auth, session);
        try {
          const result = await options.operator.deleteA2ABinding(
            session,
            sessionA2ABindingPath.agentKey,
            sessionA2ABindingPath.sessionId,
            sessionA2ABindingPath.recipientSessionId,
            await readBody(request),
          );
          await recordOperatorAudit(options.auth, session, result.audit);
          writeJsonResponse(response, 200, {deleted: result.deleted, reverseDeleted: result.reverseDeleted});
        } catch (error) {
          throw new ControlHttpError(400, error instanceof Error ? error.message : "Control A2A binding delete failed.");
        }
        return;
      }

      const agentCredentialsPath = matchAgentResourcePath(path, "credentials");
      if (agentCredentialsPath && request.method === "GET") {
        try {
          writeJsonResponse(response, 200, await options.operator.listCredentials(session, agentCredentialsPath.agentKey, parseTableInput(url.searchParams)));
        } catch {
          throw new ControlHttpError(404, "Control credential target agent was not found or is not visible.");
        }
        return;
      }
      if (agentCredentialsPath && request.method === "POST") {
        requireCsrf(request, options.auth, session);
        try {
          const result = await options.operator.setCredential(session, agentCredentialsPath.agentKey, await readBody(request));
          await recordOperatorAudit(options.auth, session, result.audit);
          writeJsonResponse(response, 200, {credential: result.credential});
        } catch (error) {
          throw new ControlHttpError(400, error instanceof Error ? error.message : "Control credential write failed.");
        }
        return;
      }
      const credentialPath = matchAgentCredentialPath(path);
      if (credentialPath && request.method === "DELETE") {
        requireCsrf(request, options.auth, session);
        try {
          const result = await options.operator.deleteCredential(session, credentialPath.agentKey, credentialPath.envKey);
          await recordOperatorAudit(options.auth, session, result.audit);
          writeJsonResponse(response, 200, {deleted: result.deleted});
        } catch (error) {
          throw new ControlHttpError(400, error instanceof Error ? error.message : "Control credential delete failed.");
        }
        return;
      }

      const wikiBindingPath = matchAgentResourcePath(path, "wiki-binding");
      if (wikiBindingPath && request.method === "GET") {
        try {
          writeJsonResponse(response, 200, {binding: await options.operator.getWikiBinding(session, wikiBindingPath.agentKey)});
        } catch {
          throw new ControlHttpError(404, "Control wiki binding target agent was not found or is not visible.");
        }
        return;
      }
      if (wikiBindingPath && request.method === "PUT") {
        requireCsrf(request, options.auth, session);
        try {
          const result = await options.operator.setWikiBinding(session, wikiBindingPath.agentKey, await readBody(request));
          await recordOperatorAudit(options.auth, session, result.audit);
          writeJsonResponse(response, 200, {binding: result.binding});
        } catch (error) {
          throw new ControlHttpError(400, error instanceof Error ? error.message : "Control wiki binding write failed.");
        }
        return;
      }
      if (wikiBindingPath && request.method === "DELETE") {
        requireCsrf(request, options.auth, session);
        try {
          const result = await options.operator.clearWikiBinding(session, wikiBindingPath.agentKey);
          await recordOperatorAudit(options.auth, session, result.audit);
          writeJsonResponse(response, 200, {deleted: result.deleted});
        } catch (error) {
          throw new ControlHttpError(400, error instanceof Error ? error.message : "Control wiki binding clear failed.");
        }
        return;
      }

      const telegramSetupStatusPath = matchTelegramSetupStatusPath(path);
      if (telegramSetupStatusPath && request.method === "GET") {
        try {
          const accountKey = url.searchParams.get("account_key") ?? url.searchParams.get("accountKey") ?? "main";
          const status = await options.operator.getTelegramSetupStatus(session, telegramSetupStatusPath.agentKey, {accountKey}, options.env ?? process.env);
          writeJsonResponse(response, 200, {status});
        } catch (error) {
          throw new ControlHttpError(400, error instanceof Error ? error.message : "Control Telegram setup status read failed.");
        }
        return;
      }

      const connectorsResourcePath = matchAgentResourcePath(path, "connectors");
      if (connectorsResourcePath && request.method === "GET") {
        const tableInput = parseConnectorTableInput(url.searchParams);
        try {
          const table = await options.operator.listConnectors(session, connectorsResourcePath.agentKey, tableInput);
          const connectors = await options.connectorAccounts.getConnectorAccounts(session, connectorsResourcePath.agentKey, {
            limit: parseConnectorAccountsLimit(url.searchParams.get("limit")),
          });
          writeJsonResponse(response, 200, {...table, connectors});
        } catch (error) {
          const message = error instanceof Error ? error.message : "Control connector accounts read failed.";
          if (message === "Control connector accounts limit must be a positive integer.") throw new ControlHttpError(400, message);
          throw new ControlHttpError(404, "Control connector target agent was not found or is not visible.");
        }
        return;
      }
      if (connectorsResourcePath && request.method === "POST") {
        requireCsrf(request, options.auth, session);
        try {
          const result = await options.operator.upsertConnector(session, connectorsResourcePath.agentKey, await readBody(request));
          await recordOperatorAudit(options.auth, session, result.audit);
          writeJsonResponse(response, 200, {connector: result.connector});
        } catch (error) {
          throw new ControlHttpError(400, error instanceof Error ? error.message : "Control connector write failed.");
        }
        return;
      }
      const connectorStatusPath = matchConnectorStatusPath(path);
      if (connectorStatusPath && request.method === "PATCH") {
        requireCsrf(request, options.auth, session);
        const body = await readBody(request);
        try {
          const result = await options.operator.setConnectorEnabled(session, connectorStatusPath.agentKey, connectorStatusPath.source, connectorStatusPath.accountKey, body.enabled !== false);
          await recordOperatorAudit(options.auth, session, result.audit);
          writeJsonResponse(response, 200, {connector: result.connector});
        } catch (error) {
          throw new ControlHttpError(400, error instanceof Error ? error.message : "Control connector status update failed.");
        }
        return;
      }

      const discordActorPairingsPath = matchAgentResourcePath(path, "discord/actor-pairings");
      if (discordActorPairingsPath && request.method === "GET") {
        try {
          writeJsonResponse(response, 200, await options.operator.listDiscordActorPairings(session, discordActorPairingsPath.agentKey, parseDiscordActorPairingTableInput(url.searchParams)));
        } catch (error) {
          const message = error instanceof Error ? error.message : "Control Discord actor pairing read failed.";
          if (message === "Control table pagination values must be positive integers.") throw new ControlHttpError(400, message);
          throw new ControlHttpError(404, "Control Discord pairing target agent was not found or is not visible.");
        }
        return;
      }
      if (discordActorPairingsPath && request.method === "POST") {
        requireCsrf(request, options.auth, session);
        try {
          const result = await options.operator.pairDiscordActor(session, discordActorPairingsPath.agentKey, await readBody(request));
          await recordOperatorAudit(options.auth, session, result.audit);
          writeJsonResponse(response, 200, {pairing: result.pairing});
        } catch (error) {
          throw new ControlHttpError(400, error instanceof Error ? error.message : "Control Discord actor pairing write failed.");
        }
        return;
      }
      const discordActorPairingPath = matchDiscordActorPairingPath(path);
      if (discordActorPairingPath && request.method === "DELETE") {
        requireCsrf(request, options.auth, session);
        try {
          const result = await options.operator.deleteDiscordActorPairing(session, discordActorPairingPath.agentKey, discordActorPairingPath.accountKey, discordActorPairingPath.externalActorId);
          await recordOperatorAudit(options.auth, session, result.audit);
          writeJsonResponse(response, 200, {deleted: result.deleted});
        } catch (error) {
          throw new ControlHttpError(400, error instanceof Error ? error.message : "Control Discord actor pairing delete failed.");
        }
        return;
      }

      const channelActorPairingsPath = matchAgentResourcePath(path, "channel-actor-pairings");
      if (channelActorPairingsPath && request.method === "GET") {
        try {
          writeJsonResponse(response, 200, await options.operator.listChannelActorPairings(session, channelActorPairingsPath.agentKey, parseChannelActorPairingTableInput(url.searchParams)));
        } catch (error) {
          const message = error instanceof Error ? error.message : "Control channel actor pairing read failed.";
          if (
            message === "Control table pagination values must be positive integers."
            || message === "Control channel actor pairing source must be telegram or whatsapp."
          ) throw new ControlHttpError(400, message);
          throw new ControlHttpError(404, "Control channel actor pairing target agent was not found or is not visible.");
        }
        return;
      }
      if (channelActorPairingsPath && request.method === "POST") {
        requireCsrf(request, options.auth, session);
        try {
          const result = await options.operator.pairChannelActor(session, channelActorPairingsPath.agentKey, await readBody(request));
          await recordOperatorAudit(options.auth, session, result.audit);
          writeJsonResponse(response, 200, {pairing: result.pairing});
        } catch (error) {
          throw new ControlHttpError(400, error instanceof Error ? error.message : "Control channel actor pairing write failed.");
        }
        return;
      }
      const channelActorPairingPath = matchChannelActorPairingPath(path);
      if (channelActorPairingPath && request.method === "DELETE") {
        requireCsrf(request, options.auth, session);
        try {
          const result = await options.operator.deleteChannelActorPairing(session, channelActorPairingPath.agentKey, channelActorPairingPath.source, channelActorPairingPath.connectorKey, channelActorPairingPath.externalActorId);
          await recordOperatorAudit(options.auth, session, result.audit);
          writeJsonResponse(response, 200, {deleted: result.deleted});
        } catch (error) {
          throw new ControlHttpError(400, error instanceof Error ? error.message : "Control channel actor pairing delete failed.");
        }
        return;
      }

      const bindingsPath = matchAgentResourcePath(path, "bindings");
      if (bindingsPath && request.method === "GET") {
        const tableInput = parseBindingTableInput(url.searchParams);
        try {
          writeJsonResponse(response, 200, await options.operator.listBindings(session, bindingsPath.agentKey, tableInput));
        } catch {
          throw new ControlHttpError(404, "Control binding target agent was not found or is not visible.");
        }
        return;
      }
      if (bindingsPath && request.method === "POST") {
        requireCsrf(request, options.auth, session);
        try {
          const result = await options.operator.bindConversation(session, bindingsPath.agentKey, await readBody(request));
          await recordOperatorAudit(options.auth, session, result.audit);
          writeJsonResponse(response, 200, {binding: result.binding, previousSessionId: result.previousSessionId ?? null});
        } catch (error) {
          throw new ControlHttpError(400, error instanceof Error ? error.message : "Control binding write failed.");
        }
        return;
      }
      const bindingPath = matchBindingPath(path);
      if (bindingPath && request.method === "DELETE") {
        requireCsrf(request, options.auth, session);
        try {
          const result = await options.operator.deleteBinding(session, bindingPath.agentKey, bindingPath.source, bindingPath.connectorKey, bindingPath.externalConversationId);
          await recordOperatorAudit(options.auth, session, result.audit);
          writeJsonResponse(response, 200, {deleted: result.deleted});
        } catch (error) {
          throw new ControlHttpError(400, error instanceof Error ? error.message : "Control binding delete failed.");
        }
        return;
      }

      const emailRoutesPath = matchAgentResourcePath(path, "email/routes");
      if (emailRoutesPath && request.method === "GET") {
        try {
          writeJsonResponse(response, 200, await options.operator.listEmailRoutes(session, emailRoutesPath.agentKey, parseEmailRouteTableInput(url.searchParams)));
        } catch (error) {
          const message = error instanceof Error ? error.message : "Control email route read failed.";
          if (message === "Control table pagination values must be positive integers.") throw new ControlHttpError(400, message);
          throw new ControlHttpError(404, "Control email route target agent was not found or is not visible.");
        }
        return;
      }
      if (emailRoutesPath && request.method === "POST") {
        requireCsrf(request, options.auth, session);
        try {
          const result = await options.operator.setEmailRoute(session, emailRoutesPath.agentKey, await readBody(request));
          await recordOperatorAudit(options.auth, session, result.audit);
          writeJsonResponse(response, 200, {route: result.route});
        } catch (error) {
          throw new ControlHttpError(400, error instanceof Error ? error.message : "Control email route write failed.");
        }
        return;
      }
      const emailRoutePath = matchEmailRoutePath(path);
      if (emailRoutePath && request.method === "DELETE") {
        requireCsrf(request, options.auth, session);
        const body = await readBody(request);
        const mailbox = typeof body.mailbox === "string" ? body.mailbox : url.searchParams.get("mailbox") ?? undefined;
        try {
          const result = await options.operator.deleteEmailRoute(session, emailRoutePath.agentKey, emailRoutePath.accountKey, mailbox);
          await recordOperatorAudit(options.auth, session, result.audit);
          writeJsonResponse(response, 200, {deleted: result.deleted});
        } catch (error) {
          throw new ControlHttpError(400, error instanceof Error ? error.message : "Control email route delete failed.");
        }
        return;
      }

      const emailAllowlistPath = matchAgentResourcePath(path, "email/allowlist");
      if (emailAllowlistPath && request.method === "GET") {
        try {
          writeJsonResponse(response, 200, await options.operator.listEmailAllowedRecipients(session, emailAllowlistPath.agentKey, parseEmailAllowedRecipientTableInput(url.searchParams)));
        } catch (error) {
          const message = error instanceof Error ? error.message : "Control email allowlist read failed.";
          if (message === "Control table pagination values must be positive integers.") throw new ControlHttpError(400, message);
          throw new ControlHttpError(404, "Control email allowlist target agent was not found or is not visible.");
        }
        return;
      }
      if (emailAllowlistPath && request.method === "POST") {
        requireCsrf(request, options.auth, session);
        try {
          const result = await options.operator.addEmailAllowedRecipient(session, emailAllowlistPath.agentKey, await readBody(request));
          await recordOperatorAudit(options.auth, session, result.audit);
          writeJsonResponse(response, 200, {recipient: result.recipient});
        } catch (error) {
          throw new ControlHttpError(400, error instanceof Error ? error.message : "Control email allowlist write failed.");
        }
        return;
      }
      const emailAllowedRecipientPath = matchEmailAllowedRecipientPath(path);
      if (emailAllowedRecipientPath && request.method === "DELETE") {
        requireCsrf(request, options.auth, session);
        try {
          const result = await options.operator.deleteEmailAllowedRecipient(session, emailAllowedRecipientPath.agentKey, emailAllowedRecipientPath.accountKey, emailAllowedRecipientPath.address);
          await recordOperatorAudit(options.auth, session, result.audit);
          writeJsonResponse(response, 200, {deleted: result.deleted});
        } catch (error) {
          throw new ControlHttpError(400, error instanceof Error ? error.message : "Control email allowlist delete failed.");
        }
        return;
      }

      const skillsPath = matchAgentResourcePath(path, "skills");
      if (skillsPath && request.method === "GET") {
        try {
          writeJsonResponse(response, 200, await options.operator.listSkills(session, skillsPath.agentKey, parseSkillTableInput(url.searchParams)));
        } catch {
          throw new ControlHttpError(404, "Control skill target agent was not found or is not visible.");
        }
        return;
      }
      if (skillsPath && request.method === "POST") {
        requireCsrf(request, options.auth, session);
        try {
          const result = await options.operator.setSkill(session, skillsPath.agentKey, await readBody(request));
          await recordOperatorAudit(options.auth, session, result.audit);
          writeJsonResponse(response, 200, {skill: result.skill});
        } catch (error) {
          throw new ControlHttpError(400, error instanceof Error ? error.message : "Control skill write failed.");
        }
        return;
      }
      const skillPath = matchAgentSkillPath(path);
      if (skillPath && request.method === "GET") {
        try {
          writeJsonResponse(response, 200, {skill: await options.operator.getSkill(session, skillPath.agentKey, skillPath.skillKey)});
        } catch {
          throw new ControlHttpError(404, "Control skill was not found or is not visible.");
        }
        return;
      }
      if (skillPath && request.method === "DELETE") {
        requireCsrf(request, options.auth, session);
        try {
          const result = await options.operator.deleteSkill(session, skillPath.agentKey, skillPath.skillKey);
          await recordOperatorAudit(options.auth, session, result.audit);
          writeJsonResponse(response, 200, {deleted: result.deleted});
        } catch (error) {
          throw new ControlHttpError(400, error instanceof Error ? error.message : "Control skill delete failed.");
        }
        return;
      }

      const subagentsPath = matchAgentResourcePath(path, "subagents");
      if (subagentsPath && request.method === "GET") {
        try {
          writeJsonResponse(response, 200, await options.operator.listSubagents(session, subagentsPath.agentKey, parseSubagentTableInput(url.searchParams)));
        } catch {
          throw new ControlHttpError(404, "Control subagent target agent was not found or is not visible.");
        }
        return;
      }
      if (subagentsPath && request.method === "POST") {
        requireCsrf(request, options.auth, session);
        try {
          const result = await options.operator.setSubagent(session, subagentsPath.agentKey, await readBody(request));
          await recordOperatorAudit(options.auth, session, result.audit);
          writeJsonResponse(response, 200, {subagent: result.subagent});
        } catch (error) {
          throw new ControlHttpError(400, error instanceof Error ? error.message : "Control subagent write failed.");
        }
        return;
      }
      const subagentPath = matchAgentSubagentPath(path);
      if (subagentPath && request.method === "GET") {
        try {
          writeJsonResponse(response, 200, {subagent: await options.operator.getSubagent(session, subagentPath.agentKey, subagentPath.slug)});
        } catch {
          throw new ControlHttpError(404, "Control subagent was not found or is not visible.");
        }
        return;
      }
      if (subagentPath && request.method === "PATCH") {
        requireCsrf(request, options.auth, session);
        const body = await readBody(request);
        try {
          const result = await options.operator.setSubagentEnabled(session, subagentPath.agentKey, subagentPath.slug, body.enabled !== false);
          await recordOperatorAudit(options.auth, session, result.audit);
          writeJsonResponse(response, 200, {subagent: result.subagent});
        } catch (error) {
          throw new ControlHttpError(400, error instanceof Error ? error.message : "Control subagent update failed.");
        }
        return;
      }

      const gatewaySourcesPath = matchAgentResourcePath(path, "gateway/sources");
      if (gatewaySourcesPath && request.method === "GET") {
        try {
          writeJsonResponse(response, 200, await options.operator.listGatewaySources(session, gatewaySourcesPath.agentKey, parseTableInput(url.searchParams)));
        } catch {
          throw new ControlHttpError(404, "Control gateway target agent was not found or is not visible.");
        }
        return;
      }
      if (gatewaySourcesPath && request.method === "POST") {
        requireCsrf(request, options.auth, session);
        try {
          const result = await options.operator.createGatewaySource(session, gatewaySourcesPath.agentKey, await readBody(request));
          await recordOperatorAudit(options.auth, session, result.audit);
          writeJsonResponse(response, 201, result.result);
        } catch (error) {
          throw new ControlHttpError(400, error instanceof Error ? error.message : "Control gateway source create failed.");
        }
        return;
      }
      const gatewaySourcePath = matchGatewaySourcePath(path);
      if (gatewaySourcePath && request.method === "PATCH") {
        requireCsrf(request, options.auth, session);
        const body = await readBody(request);
        try {
          const result = await options.operator.setGatewaySourceSuspended(session, gatewaySourcePath.agentKey, gatewaySourcePath.sourceId, body.suspended === true, typeof body.reason === "string" ? body.reason : undefined);
          await recordOperatorAudit(options.auth, session, result.audit);
          writeJsonResponse(response, 200, {source: result.source});
        } catch (error) {
          throw new ControlHttpError(400, error instanceof Error ? error.message : "Control gateway source update failed.");
        }
        return;
      }
      const gatewayRotatePath = matchGatewaySourceActionPath(path, "rotate-secret");
      if (gatewayRotatePath && request.method === "POST") {
        requireCsrf(request, options.auth, session);
        try {
          const result = await options.operator.rotateGatewaySource(session, gatewayRotatePath.agentKey, gatewayRotatePath.sourceId);
          await recordOperatorAudit(options.auth, session, result.audit);
          writeJsonResponse(response, 200, result.result);
        } catch (error) {
          throw new ControlHttpError(400, error instanceof Error ? error.message : "Control gateway source rotation failed.");
        }
        return;
      }
      const gatewayDevicesPath = matchGatewaySourceActionPath(path, "devices");
      if (gatewayDevicesPath && request.method === "GET") {
        try {
          writeJsonResponse(
            response,
            200,
            await options.operator.listGatewayDevices(
              session,
              gatewayDevicesPath.agentKey,
              gatewayDevicesPath.sourceId,
              parseGatewayDeviceTableInput(url.searchParams),
            ),
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : "Control gateway device read failed.";
          if (
            message === "Control table pagination values must be positive integers."
            || message === "Control table sort_direction must be asc or desc."
            || message === "Control gateway device enabled filter must be true or false."
          ) throw new ControlHttpError(400, message);
          throw new ControlHttpError(404, "Control gateway source was not found or is not visible.");
        }
        return;
      }
      if (gatewayDevicesPath && request.method === "POST") {
        requireCsrf(request, options.auth, session);
        try {
          const result = await options.operator.registerGatewayDevice(session, gatewayDevicesPath.agentKey, gatewayDevicesPath.sourceId, await readBody(request));
          await recordOperatorAudit(options.auth, session, result.audit);
          writeJsonResponse(response, 201, {device: result.device, token: result.token});
        } catch (error) {
          throw new ControlHttpError(400, error instanceof Error ? error.message : "Control gateway device register failed.");
        }
        return;
      }
      const gatewayDevicePath = matchGatewayDevicePath(path);
      if (gatewayDevicePath && request.method === "PATCH") {
        requireCsrf(request, options.auth, session);
        const body = await readBody(request);
        try {
          const result = await options.operator.setGatewayDeviceEnabled(session, gatewayDevicePath.agentKey, gatewayDevicePath.sourceId, gatewayDevicePath.deviceId, body.enabled !== false);
          await recordOperatorAudit(options.auth, session, result.audit);
          writeJsonResponse(response, 200, {device: result.device});
        } catch (error) {
          throw new ControlHttpError(400, error instanceof Error ? error.message : "Control gateway device update failed.");
        }
        return;
      }
      const gatewayEventTypesPath = matchGatewaySourceActionPath(path, "event-types");
      if (gatewayEventTypesPath && request.method === "GET") {
        try {
          writeJsonResponse(response, 200, await options.operator.listGatewayEventTypes(session, gatewayEventTypesPath.agentKey, gatewayEventTypesPath.sourceId, parseTableInput(url.searchParams)));
        } catch {
          throw new ControlHttpError(404, "Control gateway source was not found or is not visible.");
        }
        return;
      }
      if (gatewayEventTypesPath && request.method === "POST") {
        requireCsrf(request, options.auth, session);
        try {
          const result = await options.operator.upsertGatewayEventType(session, gatewayEventTypesPath.agentKey, gatewayEventTypesPath.sourceId, await readBody(request));
          await recordOperatorAudit(options.auth, session, result.audit);
          writeJsonResponse(response, 200, {eventType: result.eventType});
        } catch (error) {
          throw new ControlHttpError(400, error instanceof Error ? error.message : "Control gateway event type update failed.");
        }
        return;
      }
      const gatewayEventTypePath = matchGatewayEventTypePath(path);
      if (gatewayEventTypePath && request.method === "DELETE") {
        requireCsrf(request, options.auth, session);
        try {
          const result = await options.operator.deleteGatewayEventType(session, gatewayEventTypePath.agentKey, gatewayEventTypePath.sourceId, gatewayEventTypePath.type);
          await recordOperatorAudit(options.auth, session, result.audit);
          writeJsonResponse(response, 200, {deleted: result.deleted});
        } catch (error) {
          throw new ControlHttpError(400, error instanceof Error ? error.message : "Control gateway event type delete failed.");
        }
        return;
      }
      const gatewayEventsPath = matchAgentResourcePath(path, "gateway/events");
      if (gatewayEventsPath && request.method === "GET") {
        try {
          writeJsonResponse(response, 200, await options.operator.listGatewayEvents(session, gatewayEventsPath.agentKey, {
            ...parseTableInput(url.searchParams),
            sourceId: url.searchParams.get("sourceId") ?? undefined,
          }));
        } catch {
          throw new ControlHttpError(404, "Control gateway target agent was not found or is not visible.");
        }
        return;
      }
      const sessionGatewayEventsPath = matchSessionActionPath(path, "gateway-events");
      if (sessionGatewayEventsPath && request.method === "GET") {
        try {
          writeJsonResponse(response, 200, await options.operator.listGatewayEvents(session, sessionGatewayEventsPath.agentKey, {
            ...parseTableInput(url.searchParams),
            sessionId: sessionGatewayEventsPath.sessionId,
          }));
        } catch {
          throw new ControlHttpError(404, "Control gateway target session was not found or is not visible.");
        }
        return;
      }

      const connectorsPath = matchAgentConnectorsPath(path);
      if (connectorsPath && request.method === "GET") {
        try {
          const connectors = await options.connectorAccounts.getConnectorAccounts(session, connectorsPath.agentKey, {
            limit: parseConnectorAccountsLimit(url.searchParams.get("limit")),
          });
          writeJsonResponse(response, 200, {connectors});
        } catch (error) {
          const message = error instanceof Error ? error.message : "Control connector accounts read failed.";
          if (message === "Control connector accounts limit must be a positive integer.") throw new ControlHttpError(400, message);
          throw new ControlHttpError(404, "Control connector accounts target agent was not found or is not visible.");
        }
        return;
      }


      const watchesPath = matchSessionWatchesPath(path);
      if (watchesPath && request.method === "GET") {
        try {
          const watches = await options.watches.getWatches(
            session,
            watchesPath.agentKey,
            watchesPath.sessionId,
            parseWatchesTableInput(url.searchParams),
          );
          writeJsonResponse(response, 200, {watches});
        } catch (error) {
          const message = error instanceof Error ? error.message : "Control watches read failed.";
          if (
            message === "Control watches limit must be a positive integer."
            || message === "Control watches page must be a positive integer."
            || message === "Control watches per_page must be a positive integer."
            || message === "Control table pagination values must be positive integers."
            || message === "Control watch status filter is unsupported."
            || message === "Control watch source filter is unsupported."
          ) throw new ControlHttpError(400, message);
          throw new ControlHttpError(404, "Control watches target session was not found or is not visible.");
        }
        return;
      }
      const watchPath = matchSessionWatchPath(path);
      if (watchPath && request.method === "PATCH") {
        requireCsrf(request, options.auth, session);
        let result;
        try {
          result = await options.watches.updateWatch(
            session,
            watchPath.agentKey,
            watchPath.sessionId,
            watchPath.watchId,
            await readBody(request),
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : "Control watch update failed.";
          if (message.includes("not found") || message.includes("not visible") || message.includes("Unknown watch")) {
            throw new ControlHttpError(404, "Control watch was not found or is not visible.");
          }
          throw new ControlHttpError(400, message);
        }
        await recordWatchAudit(options.auth, session, result.audit);
        writeJsonResponse(response, 200, {watch: result.watch});
        return;
      }
      if (watchPath && request.method === "DELETE") {
        requireCsrf(request, options.auth, session);
        let result;
        try {
          result = await options.watches.disableWatch(
            session,
            watchPath.agentKey,
            watchPath.sessionId,
            watchPath.watchId,
            await readBody(request),
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : "Control watch disable failed.";
          if (message.includes("not found") || message.includes("not visible") || message.includes("Unknown watch")) {
            throw new ControlHttpError(404, "Control watch was not found or is not visible.");
          }
          throw new ControlHttpError(400, message);
        }
        await recordWatchAudit(options.auth, session, result.audit);
        writeJsonResponse(response, 200, {watch: result.watch});
        return;
      }

      const runtimeActivityPath = matchSessionRuntimeActivityPath(path);
      if (runtimeActivityPath && request.method === "GET") {
        const tableInput = parseRuntimeActivityTableInput(url.searchParams);
        try {
          const runtimeActivity = await options.runtimeActivity.getRuntimeActivity(session, runtimeActivityPath.agentKey, runtimeActivityPath.sessionId, tableInput);
          writeJsonResponse(response, 200, {runtimeActivity});
        } catch (error) {
          const message = error instanceof Error ? error.message : "Control runtime activity read failed.";
          if (
            message === "Control runtime activity page must be a positive integer."
            || message === "Control runtime activity per_page must be a positive integer."
            || message === "Control table pagination values must be positive integers."
          ) throw new ControlHttpError(400, message);
          throw new ControlHttpError(404, "Control runtime activity target session was not found or is not visible.");
        }
        return;
      }

      const scheduledTasksPath = matchSessionScheduledTasksPath(path);
      if (scheduledTasksPath && request.method === "GET") {
        try {
          const scheduledTasks = await options.scheduledTasks.getScheduledTasks(
            session,
            scheduledTasksPath.agentKey,
            scheduledTasksPath.sessionId,
            parseScheduledTasksTableInput(url.searchParams),
          );
          writeJsonResponse(response, 200, {scheduledTasks});
        } catch (error) {
          const message = error instanceof Error ? error.message : "Control scheduled tasks read failed.";
          if (
            message === "Control scheduled tasks limit must be a positive integer."
            || message === "Control scheduled tasks page must be a positive integer."
            || message === "Control scheduled tasks per_page must be a positive integer."
            || message === "Control table pagination values must be positive integers."
          ) throw new ControlHttpError(400, message);
          throw new ControlHttpError(404, "Control scheduled tasks target session was not found or is not visible.");
        }
        return;
      }
      if (scheduledTasksPath && request.method === "POST") {
        requireCsrf(request, options.auth, session);
        let result;
        try {
          result = await options.scheduledTasks.createScheduledTask(
            session,
            scheduledTasksPath.agentKey,
            scheduledTasksPath.sessionId,
            await readBody(request),
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : "Control scheduled task create failed.";
          if (message.includes("not found") || message.includes("not visible")) {
            throw new ControlHttpError(404, "Control scheduled tasks target session was not found or is not visible.");
          }
          throw new ControlHttpError(400, message);
        }
        await recordScheduledTaskAudit(options.auth, session, result.audit);
        writeJsonResponse(response, 201, {scheduledTask: result.scheduledTask});
        return;
      }

      const scheduledTaskPath = matchSessionScheduledTaskPath(path);
      if (scheduledTaskPath && request.method === "PATCH") {
        requireCsrf(request, options.auth, session);
        let result;
        try {
          result = await options.scheduledTasks.updateScheduledTask(
            session,
            scheduledTaskPath.agentKey,
            scheduledTaskPath.sessionId,
            scheduledTaskPath.taskId,
            await readBody(request),
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : "Control scheduled task update failed.";
          if (message.includes("not found") || message.includes("not visible")) {
            throw new ControlHttpError(404, "Control scheduled task was not found or is not visible.");
          }
          throw new ControlHttpError(400, message);
        }
        await recordScheduledTaskAudit(options.auth, session, result.audit);
        writeJsonResponse(response, 200, {scheduledTask: result.scheduledTask});
        return;
      }
      if (scheduledTaskPath && request.method === "DELETE") {
        requireCsrf(request, options.auth, session);
        let result;
        try {
          result = await options.scheduledTasks.cancelScheduledTask(
            session,
            scheduledTaskPath.agentKey,
            scheduledTaskPath.sessionId,
            scheduledTaskPath.taskId,
            await readBody(request),
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : "Control scheduled task cancel failed.";
          if (message.includes("not found") || message.includes("not visible")) {
            throw new ControlHttpError(404, "Control scheduled task was not found or is not visible.");
          }
          throw new ControlHttpError(400, message);
        }
        await recordScheduledTaskAudit(options.auth, session, result.audit);
        writeJsonResponse(response, 200, {scheduledTask: result.scheduledTask});
        return;
      }

      const heartbeatPath = matchSessionHeartbeatPath(path);
      if (heartbeatPath && request.method === "GET") {
        try {
          const heartbeat = await options.heartbeats.getHeartbeat(session, heartbeatPath.agentKey, heartbeatPath.sessionId);
          writeJsonResponse(response, 200, {heartbeat});
        } catch {
          throw new ControlHttpError(404, "Control heartbeat target session was not found or is not visible.");
        }
        return;
      }
      if (heartbeatPath && request.method === "PATCH") {
        requireCsrf(request, options.auth, session);
        const body = await readBody(request);
        const allowed = new Set(["enabled", "everyMinutes", "confirm"]);
        const unknown = Object.keys(body).filter((key) => !allowed.has(key));
        if (unknown.length > 0) {
          throw new ControlHttpError(400, `Unsupported heartbeat field: ${unknown[0]}.`);
        }
        if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
          throw new ControlHttpError(400, "Control heartbeat enabled must be a boolean.");
        }
        if (body.everyMinutes !== undefined && typeof body.everyMinutes !== "number") {
          throw new ControlHttpError(400, "Control heartbeat cadence must be a number.");
        }
        if (body.confirm !== undefined && typeof body.confirm !== "string") {
          throw new ControlHttpError(400, "Control heartbeat confirm must be a string.");
        }
        const input = {
          ...(body.enabled !== undefined ? {enabled: body.enabled} : {}),
          ...(body.everyMinutes !== undefined ? {everyMinutes: body.everyMinutes} : {}),
          ...(body.confirm !== undefined ? {confirm: body.confirm} : {}),
        };
        let result;
        try {
          result = await options.heartbeats.updateHeartbeat(session, heartbeatPath.agentKey, heartbeatPath.sessionId, input);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Control heartbeat update failed.";
          if (message.includes("not found") || message.includes("not visible")) {
            throw new ControlHttpError(404, "Control heartbeat target session was not found or is not visible.");
          }
          throw new ControlHttpError(400, message);
        }
        await recordHeartbeatAudit(options.auth, session, result.audit);
        writeJsonResponse(response, 200, {heartbeat: result.heartbeat});
        return;
      }

      const sessionPromptsPath = matchSessionPromptsPath(path);
      if (sessionPromptsPath && request.method === "GET") {
        try {
          const prompts = await options.briefings.listPrompts(session, sessionPromptsPath.agentKey, sessionPromptsPath.sessionId);
          writeJsonResponse(response, 200, {prompts});
        } catch {
          throw new ControlHttpError(404, "Control session prompt target session was not found or is not visible.");
        }
        return;
      }

      const sessionPromptPath = matchSessionPromptPath(path);
      if (sessionPromptPath && request.method === "GET") {
        try {
          const prompt = await options.briefings.getPrompt(session, sessionPromptPath.agentKey, sessionPromptPath.sessionId, sessionPromptPath.slug);
          writeJsonResponse(response, 200, {prompt});
        } catch (error) {
          const message = error instanceof Error ? error.message : "Control session prompt read failed.";
          if (message.includes("Unsupported session prompt slug")) throw new ControlHttpError(400, message);
          throw new ControlHttpError(404, "Control session prompt target session was not found or is not visible.");
        }
        return;
      }
      if (sessionPromptPath && request.method === "PUT") {
        requireCsrf(request, options.auth, session);
        const body = await readBody(request);
        const content = typeof body.content === "string" ? body.content : "";
        let result;
        try {
          result = await options.briefings.setPrompt(session, sessionPromptPath.agentKey, sessionPromptPath.sessionId, sessionPromptPath.slug, content);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Control session prompt update failed.";
          if (message.includes("Unsupported session prompt slug") || message.includes("blank")) throw new ControlHttpError(400, message);
          throw new ControlHttpError(404, "Control session prompt target session was not found or is not visible.");
        }
        await recordSessionPromptAudit(options.auth, session, result.audit);
        writeJsonResponse(response, 200, {prompt: result.prompt});
        return;
      }
      if (sessionPromptPath && request.method === "DELETE") {
        requireCsrf(request, options.auth, session);
        const body = await readBody(request);
        if (body.confirm !== "clear-session-prompt") {
          throw new ControlHttpError(400, "DELETE requires confirm: \"clear-session-prompt\".");
        }
        let result;
        try {
          result = await options.briefings.deletePrompt(session, sessionPromptPath.agentKey, sessionPromptPath.sessionId, sessionPromptPath.slug);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Control session prompt delete failed.";
          if (message.includes("Unsupported session prompt slug")) throw new ControlHttpError(400, message);
          throw new ControlHttpError(404, "Control session prompt target session was not found or is not visible.");
        }
        await recordSessionPromptAudit(options.auth, session, result.audit);
        writeJsonResponse(response, 200, {prompt: result.prompt});
        return;
      }

      const briefingPath = matchSessionBriefingPath(path);
      if (briefingPath && request.method === "GET") {
        try {
          const briefing = await options.briefings.getBriefing(session, briefingPath.agentKey, briefingPath.sessionId);
          writeJsonResponse(response, 200, {briefing});
        } catch {
          throw new ControlHttpError(404, "Control briefing target session was not found or is not visible.");
        }
        return;
      }
      if (briefingPath && request.method === "PUT") {
        requireCsrf(request, options.auth, session);
        const body = await readBody(request);
        const content = typeof body.content === "string" ? body.content : "";
        let result;
        try {
          result = await options.briefings.setBriefing(session, briefingPath.agentKey, briefingPath.sessionId, content);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Control briefing update failed.";
          if (message.includes("blank")) throw new ControlHttpError(400, message);
          throw new ControlHttpError(404, "Control briefing target session was not found or is not visible.");
        }
        await recordBriefingAudit(options.auth, session, result.audit);
        writeJsonResponse(response, 200, {briefing: result.briefing});
        return;
      }
      if (briefingPath && request.method === "DELETE") {
        requireCsrf(request, options.auth, session);
        const body = await readBody(request);
        if (body.confirm !== "clear-session-briefing") {
          throw new ControlHttpError(400, "DELETE requires confirm: \"clear-session-briefing\".");
        }
        let result;
        try {
          result = await options.briefings.deleteBriefing(session, briefingPath.agentKey, briefingPath.sessionId);
        } catch {
          throw new ControlHttpError(404, "Control briefing target session was not found or is not visible.");
        }
        await recordBriefingAudit(options.auth, session, result.audit);
        writeJsonResponse(response, 200, {briefing: result.briefing});
        return;
      }
      writeJsonResponse(response, 404, {error: "not_found"});
    } catch (error) {
      if (error instanceof ControlHttpError) {
        writeJsonResponse(response, error.statusCode, {error: error.message});
        return;
      }
      console.error("Control HTTP request failed", {error: "internal_error"});
      writeJsonResponse(response, 500, {error: "internal_error"});
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : options.port;
  return {
    server,
    host: options.host,
    port: actualPort,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
