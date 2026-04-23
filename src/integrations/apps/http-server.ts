import {randomUUID} from "node:crypto";
import {createServer, type IncomingMessage, type Server} from "node:http";
import path from "node:path";
import {access, readFile} from "node:fs/promises";

import type {IdentityStore} from "../../domain/identity/store.js";
import type {SessionRecord} from "../../domain/sessions/types.js";
import type {SessionStore} from "../../domain/sessions/store.js";
import {stringToUserMessage} from "../../kernel/agent/helpers/input.js";
import {writeJsonResponse} from "../../lib/http.js";
import {trimToNull} from "../../lib/strings.js";
import type {ThreadRuntimeCoordinator} from "../../domain/threads/runtime/coordinator.js";
import {readAgentAppRequiredInputKeys} from "../../domain/apps/types.js";
import {
  buildAgentAppCookieNames,
  DEFAULT_APP_SESSION_TTL_MS,
  type AgentAppAuthService,
  type AgentAppSessionRecord,
} from "../../domain/apps/auth.js";
import {AgentAppService} from "./sqlite-service.js";

export const DEFAULT_APPS_HOST = "127.0.0.1";
export const DEFAULT_APPS_PORT = 8092;
const WILDCARD_APP_HOSTS = new Set(["0.0.0.0", "::"]);
const APP_CSRF_HEADER = "x-panda-app-csrf";
const MAX_APP_JSON_BODY_BYTES = 256 * 1024;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_KEYS = 10_000;

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
};

class AgentAppRequestError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "AgentAppRequestError";
  }
}

function parsePort(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(`Invalid ${label}: ${value}`);
  }

  return parsed;
}

function splitPathname(pathname: string): string[] {
  return pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
}

function contentTypeForFile(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function ensureContainedPath(baseDir: string, relativePath: string): string {
  const resolved = path.resolve(baseDir, relativePath);
  const relative = path.relative(baseDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path escapes the app public directory.");
  }

  return resolved;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const declaredLength = request.headers["content-length"];
  const contentLength = Array.isArray(declaredLength) ? declaredLength[0] : declaredLength;
  if (contentLength) {
    const parsedLength = Number(contentLength);
    if (Number.isFinite(parsedLength) && parsedLength > MAX_APP_JSON_BODY_BYTES) {
      throw new AgentAppRequestError(413, "App request body is too large.");
    }
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_APP_JSON_BODY_BYTES) {
      throw new AgentAppRequestError(413, "App request body is too large.");
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Request body must be valid JSON: ${message}`);
  }
}

function trimString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function formatHostForUrl(host: string): string {
  const normalized = host.trim();
  const visibleHost = WILDCARD_APP_HOSTS.has(normalized) ? "127.0.0.1" : normalized;
  return visibleHost.includes(":") && !visibleHost.startsWith("[")
    ? `[${visibleHost}]`
    : visibleHost;
}

function ensureBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (!url.pathname.endsWith("/")) {
    url.pathname = `${url.pathname}/`;
  }
  return url.toString();
}

function joinBaseUrl(baseUrl: string, relativePath: string): string {
  return new URL(relativePath.replace(/^\/+/, ""), ensureBaseUrl(baseUrl)).toString();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderLaunchInterstitial(token: string): string {
  const action = escapeHtml(buildAgentAppOpenPath(token));
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Open Panda App</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 16px ui-sans-serif, system-ui; background: #f6f1e8; color: #17140f; }
    main { width: min(420px, calc(100vw - 32px)); padding: 28px; border: 1px solid #d8cbb8; border-radius: 20px; background: #fffaf2; box-shadow: 0 24px 80px rgb(31 23 13 / 12%); }
    h1 { margin: 0 0 8px; font-size: 28px; line-height: 1.05; }
    p { margin: 0 0 22px; color: #675c4d; line-height: 1.45; }
    button { width: 100%; border: 0; border-radius: 999px; padding: 13px 18px; background: #1c5d46; color: white; font: inherit; font-weight: 700; cursor: pointer; }
  </style>
</head>
<body>
  <main>
    <h1>Open Panda app</h1>
    <p>This one-time link will sign this browser into the app.</p>
    <form method="post" action="${action}">
      <button type="submit">Continue</button>
    </form>
  </main>
</body>
</html>`;
}

export function buildAgentAppPath(agentKey: string, appSlug: string): string {
  return `/${encodeURIComponent(agentKey)}/apps/${encodeURIComponent(appSlug)}/`;
}

export function buildAgentAppOpenPath(token: string): string {
  return `/apps/open?token=${encodeURIComponent(token)}`;
}

function buildAgentAppCookiePath(agentKey: string, appSlug: string): string {
  return buildAgentAppPath(agentKey, appSlug).replace(/\/$/, "") || "/";
}

export function resolveAgentAppAuthMode(env: NodeJS.ProcessEnv = process.env): AgentAppAuthMode {
  const raw = (trimToNull(env.PANDA_APPS_AUTH) ?? trimToNull(env.PANDA_APPS_AUTH_MODE))?.toLowerCase();
  if (!raw) {
    return trimToNull(env.PANDA_APPS_BASE_URL) ? "required" : "off";
  }

  if (["required", "on", "true", "1"].includes(raw)) {
    return "required";
  }
  if (["off", "false", "0", "dev"].includes(raw)) {
    return "off";
  }

  throw new Error(`Invalid PANDA_APPS_AUTH value: ${raw}`);
}

function resolveCookieSecure(env: NodeJS.ProcessEnv): boolean {
  const raw = trimToNull(env.PANDA_APPS_COOKIE_SECURE)?.toLowerCase();
  if (raw) {
    if (["true", "1", "on"].includes(raw)) {
      return true;
    }
    if (["false", "0", "off"].includes(raw)) {
      return false;
    }
    throw new Error(`Invalid PANDA_APPS_COOKIE_SECURE value: ${raw}`);
  }

  return trimToNull(env.PANDA_APPS_BASE_URL)?.startsWith("https://") ?? false;
}

function resolveSessionTtlMs(env: NodeJS.ProcessEnv): number {
  const raw = trimToNull(env.PANDA_APPS_SESSION_TTL_HOURS);
  if (!raw) {
    return DEFAULT_APP_SESSION_TTL_MS;
  }

  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new Error(`Invalid PANDA_APPS_SESSION_TTL_HOURS value: ${raw}`);
  }

  return Math.floor(hours * 60 * 60 * 1000);
}

function resolveRateLimitPerMinute(env: NodeJS.ProcessEnv): number {
  const raw = trimToNull(env.PANDA_APPS_RATE_LIMIT_PER_MINUTE);
  if (!raw) {
    return 300;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid PANDA_APPS_RATE_LIMIT_PER_MINUTE value: ${raw}`);
  }

  return parsed;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseAppUiPath(parts: readonly string[]): {
  agentKey: string;
  appSlug: string;
  relativeAssetPath: string;
} | null {
  if (parts.length < 3 || parts[0] === "api" || parts[1] !== "apps") {
    return null;
  }

  return {
    agentKey: parts[0] ?? "",
    appSlug: parts[2] ?? "",
    relativeAssetPath: parts.slice(3).join("/"),
  };
}

function setAppSecurityHeaders(response: import("node:http").ServerResponse): void {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader(
    "content-security-policy",
    [
      "default-src 'self'",
      "connect-src 'self'",
      "img-src 'self' data: blob:",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self' data:",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
    ].join("; "),
  );
}

function parseCookies(header: string | string[] | undefined): Record<string, string> {
  const raw = Array.isArray(header) ? header.join(";") : header;
  if (!raw) {
    return {};
  }

  const cookies: Record<string, string> = {};
  for (const part of raw.split(";")) {
    const [name, ...valueParts] = part.split("=");
    const trimmedName = name?.trim();
    if (!trimmedName) {
      continue;
    }

    const rawValue = valueParts.join("=");
    try {
      cookies[trimmedName] = decodeURIComponent(rawValue);
    } catch {
      cookies[trimmedName] = rawValue;
    }
  }

  return cookies;
}

function serializeCookie(input: {
  name: string;
  path: string;
  value: string;
  expiresAt: number;
  httpOnly: boolean;
  secure: boolean;
}): string {
  return [
    `${input.name}=${encodeURIComponent(input.value)}`,
    `Path=${input.path}`,
    `Expires=${new Date(input.expiresAt).toUTCString()}`,
    "SameSite=Lax",
    input.httpOnly ? "HttpOnly" : "",
    input.secure ? "Secure" : "",
  ].filter(Boolean).join("; ");
}

function readClientKey(request: IncomingMessage): string {
  const forwarded = request.headers["x-forwarded-for"];
  const forwardedValue = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  // Caddy is configured to overwrite X-Forwarded-For with one remote host.
  // If a proxy appends a chain instead, fall back to the socket address rather
  // than trusting a client-controlled first value.
  const forwardedAddress = forwardedValue?.trim();
  if (forwardedAddress && !forwardedAddress.includes(",")) {
    return forwardedAddress;
  }
  return request.socket.remoteAddress || "unknown";
}

function createRateLimiter(maxPerMinute: number): (key: string) => boolean {
  if (maxPerMinute === 0) {
    return () => true;
  }

  const hits = new Map<string, {count: number; resetAt: number}>();
  let requestsSincePrune = 0;
  const pruneExpired = (now: number): void => {
    for (const [key, bucket] of hits) {
      if (bucket.resetAt <= now) {
        hits.delete(key);
      }
    }
  };

  return (key: string): boolean => {
    const now = Date.now();
    requestsSincePrune += 1;
    if (requestsSincePrune >= 1000 || hits.size > RATE_LIMIT_MAX_KEYS) {
      requestsSincePrune = 0;
      pruneExpired(now);
    }

    const current = hits.get(key);
    if (!current || current.resetAt <= now) {
      if (!current && hits.size >= RATE_LIMIT_MAX_KEYS) {
        return false;
      }
      hits.set(key, {count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS});
      return true;
    }

    current.count += 1;
    return current.count <= maxPerMinute;
  };
}

function buildSdkScript(): string {
  return `(() => {
  const trim = (value) => typeof value === "string" && value.trim() ? value.trim() : undefined;
  const cookieSuffix = (agentKey, appSlug) => \`\${agentKey}_\${appSlug}\`.replace(/[^A-Za-z0-9_-]/g, "_");
  const readCookie = (name) => {
    const prefix = \`\${name}=\`;
    const match = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix));
    return match ? decodeURIComponent(match.slice(prefix.length)) : undefined;
  };
  const url = new URL(window.location.href);
  const parts = url.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
  const route = parts[0] === "apps" && parts[1] && parts[2]
    ? {agentKey: parts[1], appSlug: parts[2]}
    : parts[1] === "apps" && parts[0] && parts[2]
      ? {agentKey: parts[0], appSlug: parts[2]}
      : null;
  if (!route) {
    return;
  }

  const apiBase = \`/api/apps/\${encodeURIComponent(route.agentKey)}/\${encodeURIComponent(route.appSlug)}\`;
  const csrfCookieName = \`panda_app_csrf_\${cookieSuffix(route.agentKey, route.appSlug)}\`;
  let context = {
    identityId: trim(url.searchParams.get("identityId")),
    identityHandle: trim(url.searchParams.get("identityHandle")),
    sessionId: trim(url.searchParams.get("sessionId")),
  };

  const withContext = (payload = {}) => ({
    ...payload,
    ...(context.identityId ? {identityId: context.identityId} : {}),
    ...(context.identityHandle ? {identityHandle: context.identityHandle} : {}),
    ...(context.sessionId ? {sessionId: context.sessionId} : {}),
  });

  const requestJson = async (requestPath, options = {}) => {
    const method = options.method ?? "GET";
    const csrfToken = readCookie(csrfCookieName);
    const response = await fetch(requestPath, {
      credentials: "same-origin",
      ...options,
      method,
      headers: {
        ...(method === "GET" ? {} : {"content-type": "application/json"}),
        ...(csrfToken ? {"${APP_CSRF_HEADER}": csrfToken} : {}),
        ...(options.headers ?? {}),
      },
    });
    const raw = await response.text();
    const data = raw ? JSON.parse(raw) : null;
    if (!response.ok) {
      throw new Error((data && data.error) || \`Request failed (\${response.status})\`);
    }

    return data;
  };

  window.panda = {
    agentKey: route.agentKey,
    appSlug: route.appSlug,
    getContext() {
      return {...context};
    },
    setContext(next) {
      context = {
        ...context,
        ...(next && typeof next === "object" ? next : {}),
      };
      return {...context};
    },
    bootstrap() {
      const search = new URLSearchParams(withContext());
      return requestJson(\`\${apiBase}/bootstrap?\${search.toString()}\`);
    },
    view(viewName, options = {}) {
      return requestJson(\`\${apiBase}/views/\${encodeURIComponent(viewName)}\`, {
        method: "POST",
        body: JSON.stringify(withContext({
          params: options.params ?? {},
          pageSize: options.pageSize,
          offset: options.offset,
        })),
      });
    },
    action(actionName, input = {}) {
      return requestJson(\`\${apiBase}/actions/\${encodeURIComponent(actionName)}\`, {
        method: "POST",
        body: JSON.stringify(withContext({input})),
      });
    },
  };
})();`;
}

export interface AgentAppServerBindingOptions {
  hostEnvKey: string;
  portEnvKey: string;
  defaultHost?: string;
  defaultPort?: number;
  env?: NodeJS.ProcessEnv;
}

export interface AgentAppServerBinding {
  host: string;
  port: number;
}

export interface AgentAppServerOptions extends AgentAppServerBinding {
  service: AgentAppService;
  auth?: AgentAppAuthService;
  authMode?: AgentAppAuthMode;
  cookieSecure?: boolean;
  env?: NodeJS.ProcessEnv;
  rateLimitPerMinute?: number;
  sessionTtlMs?: number;
  identityStore?: Pick<IdentityStore, "getIdentityByHandle">;
  sessionStore?: Pick<SessionStore, "getMainSession" | "getSession">;
  coordinator?: Pick<ThreadRuntimeCoordinator, "submitInput">;
}

export interface AgentAppServer {
  readonly host: string;
  readonly port: number;
  readonly server: Server;
  close(): Promise<void>;
}

export interface AgentAppUrls {
  appPath: string;
  appUrl: string;
  localAppUrl: string;
  internalAppUrl?: string;
  publicAppUrl?: string;
}

export type AgentAppAuthMode = "off" | "required";

function readAgentAppRequestStatus(error: unknown): number {
  return error instanceof AgentAppRequestError ? error.statusCode : 500;
}

async function resolveAppHttpSession(input: {
  auth?: AgentAppAuthService;
  authMode: AgentAppAuthMode;
  request: IncomingMessage;
  agentKey: string;
  appSlug: string;
}): Promise<AgentAppSessionRecord | null> {
  if (input.authMode === "off") {
    return null;
  }

  if (!input.auth) {
    throw new AgentAppRequestError(500, "App auth is required but no auth service is configured.");
  }

  const cookies = parseCookies(input.request.headers.cookie);
  const cookieNames = buildAgentAppCookieNames(input.agentKey, input.appSlug);
  const sessionToken = cookies[cookieNames.session];
  if (!sessionToken) {
    throw new AgentAppRequestError(401, "Open this app from a fresh app_link_create link.");
  }

  const session = await input.auth.getSessionByToken(sessionToken);
  if (!session) {
    throw new AgentAppRequestError(401, "App session expired. Ask the agent for a fresh app link.");
  }
  if (session.agentKey !== input.agentKey || session.appSlug !== input.appSlug) {
    throw new AgentAppRequestError(403, "App session is not valid for this app.");
  }

  return session;
}

function assertAppCsrf(input: {
  auth?: AgentAppAuthService;
  authMode: AgentAppAuthMode;
  request: IncomingMessage;
  session: AgentAppSessionRecord | null;
}): void {
  if (input.authMode === "off") {
    return;
  }
  if (!input.auth || !input.session) {
    throw new AgentAppRequestError(401, "App session required.");
  }

  const csrfHeader = input.request.headers[APP_CSRF_HEADER];
  const csrfToken = Array.isArray(csrfHeader) ? csrfHeader[0] : csrfHeader;
  if (!csrfToken || !input.auth.verifyCsrfToken(input.session, csrfToken)) {
    throw new AgentAppRequestError(403, "Invalid or missing app CSRF token.");
  }
}

function isUnknownSessionError(error: unknown, sessionId: string): boolean {
  return error instanceof Error && error.message === `Unknown session ${sessionId}`;
}

async function resolveRequestIdentity(input: {
  identityId?: string;
  identityHandle?: string;
  identityStore?: Pick<IdentityStore, "getIdentityByHandle">;
}): Promise<{
  identityId?: string;
  identityHandle?: string;
}> {
  if (input.identityId) {
    return {
      identityId: input.identityId,
      identityHandle: input.identityHandle,
    };
  }

  if (!input.identityHandle) {
    return {};
  }

  if (!input.identityStore) {
    throw new Error("App requests using identityHandle require an identity store.");
  }

  const identity = await input.identityStore.getIdentityByHandle(input.identityHandle);
  return {
    identityId: identity.id,
    identityHandle: identity.handle,
  };
}

async function resolveExplicitRequestSession(input: {
  agentKey: string;
  requestedSessionId?: string;
  sessionStore?: Pick<SessionStore, "getSession">;
}): Promise<SessionRecord | undefined> {
  if (!input.requestedSessionId) {
    return undefined;
  }
  if (!input.sessionStore) {
    throw new AgentAppRequestError(500, "App requests using sessionId require a session store.");
  }

  let session: SessionRecord;
  try {
    session = await input.sessionStore.getSession(input.requestedSessionId);
  } catch (error) {
    if (isUnknownSessionError(error, input.requestedSessionId)) {
      throw new AgentAppRequestError(404, `Unknown session ${input.requestedSessionId}.`);
    }
    throw error;
  }

  if (session.agentKey !== input.agentKey) {
    throw new AgentAppRequestError(
      400,
      `Session ${session.id} belongs to ${session.agentKey}, not ${input.agentKey}.`,
    );
  }

  return session;
}

export function resolveOptionalAgentAppServerBinding(
  options: AgentAppServerBindingOptions,
): AgentAppServerBinding | null {
  const env = options.env ?? process.env;
  const portValue = trimToNull(env[options.portEnvKey]);
  if (!portValue && options.defaultPort === undefined) {
    return null;
  }

  return {
    host: trimToNull(env[options.hostEnvKey]) ?? options.defaultHost ?? DEFAULT_APPS_HOST,
    port: portValue ? parsePort(portValue, options.portEnvKey) : options.defaultPort!,
  };
}

export function resolveAgentAppUrls(input: {
  agentKey: string;
  appSlug: string;
  env?: NodeJS.ProcessEnv;
  binding?: AgentAppServerBinding;
}): AgentAppUrls {
  const env = input.env ?? process.env;
  const binding = input.binding ?? resolveOptionalAgentAppServerBinding({
    hostEnvKey: "PANDA_APPS_HOST",
    portEnvKey: "PANDA_APPS_PORT",
    defaultHost: DEFAULT_APPS_HOST,
    defaultPort: DEFAULT_APPS_PORT,
    env,
  });
  if (!binding) {
    throw new Error("Agent app URLs require an app server binding.");
  }

  const appPath = buildAgentAppPath(input.agentKey, input.appSlug);
  const localBaseUrl = `http://${formatHostForUrl(binding.host)}:${binding.port}`;
  const publicBaseUrl = trimToNull(env.PANDA_APPS_BASE_URL);
  const internalBaseUrl = trimToNull(env.PANDA_APPS_INTERNAL_BASE_URL);
  const localAppUrl = joinBaseUrl(localBaseUrl, appPath);
  const publicAppUrl = publicBaseUrl ? joinBaseUrl(publicBaseUrl, appPath) : undefined;
  const internalAppUrl = internalBaseUrl ? joinBaseUrl(internalBaseUrl, appPath) : undefined;

  return {
    appPath,
    appUrl: publicAppUrl ?? internalAppUrl ?? localAppUrl,
    localAppUrl,
    ...(internalAppUrl ? {internalAppUrl} : {}),
    ...(publicAppUrl ? {publicAppUrl} : {}),
  };
}

export async function startAgentAppServer(options: AgentAppServerOptions): Promise<AgentAppServer> {
  const env = options.env ?? process.env;
  const authMode = options.authMode ?? resolveAgentAppAuthMode(env);
  if (authMode === "required" && !options.auth) {
    throw new Error("PANDA_APPS_AUTH requires an app auth service.");
  }
  const cookieSecure = options.cookieSecure ?? resolveCookieSecure(env);
  const rateLimitAllows = createRateLimiter(options.rateLimitPerMinute ?? resolveRateLimitPerMinute(env));
  const sessionTtlMs = options.sessionTtlMs ?? resolveSessionTtlMs(env);

  const server = createServer(async (request, response) => {
    try {
      setAppSecurityHeaders(response);
      if (!rateLimitAllows(readClientKey(request))) {
        throw new AgentAppRequestError(429, "Too many app requests. Try again in a minute.");
      }
      const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "apps.local"}`);
      const parts = splitPathname(requestUrl.pathname);

      if (request.method === "GET" && requestUrl.pathname === "/health") {
        writeJsonResponse(response, 200, {ok: true});
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/panda-app-sdk.js") {
        response.writeHead(200, {"content-type": "text/javascript; charset=utf-8"});
        response.end(buildSdkScript());
        return;
      }

      if (parts[0] === "apps" && parts[1] === "open") {
        if (!options.auth) {
          throw new AgentAppRequestError(404, "App launch links are not configured.");
        }

        const token = trimString(requestUrl.searchParams.get("token"));
        if (!token) {
          throw new AgentAppRequestError(400, "Missing app launch token.");
        }

        if (request.method === "GET") {
          response.writeHead(200, {
            "cache-control": "no-store",
            "content-type": "text/html; charset=utf-8",
          });
          response.end(renderLaunchInterstitial(token));
          return;
        }

        if (request.method !== "POST") {
          throw new AgentAppRequestError(405, "Use GET or POST for app launch links.");
        }

        const redeemed = await options.auth.redeemLaunchToken(token, {sessionTtlMs});
        const app = await options.service.getApp(redeemed.session.agentKey, redeemed.session.appSlug);
        if (!app.hasUi) {
          throw new AgentAppRequestError(404, `App ${app.slug} does not expose a UI.`);
        }

        const cookieNames = buildAgentAppCookieNames(app.agentKey, app.slug);
        response.writeHead(302, {
          "cache-control": "no-store",
          "location": buildAgentAppPath(app.agentKey, app.slug),
          "set-cookie": [
            serializeCookie({
              name: cookieNames.session,
              path: "/",
              value: redeemed.sessionToken,
              expiresAt: redeemed.session.expiresAt,
              httpOnly: true,
              secure: cookieSecure,
            }),
            serializeCookie({
              name: cookieNames.csrf,
              path: buildAgentAppCookiePath(app.agentKey, app.slug),
              value: redeemed.csrfToken,
              expiresAt: redeemed.session.expiresAt,
              httpOnly: false,
              secure: cookieSecure,
            }),
          ],
        });
        response.end();
        return;
      }

      const appUiPath = parseAppUiPath(parts);
      if (appUiPath && request.method === "GET") {
        const {agentKey, appSlug, relativeAssetPath} = appUiPath;
        await resolveAppHttpSession({
          auth: options.auth,
          authMode,
          request,
          agentKey,
          appSlug,
        });
        const app = await options.service.getApp(agentKey, appSlug);
        if (!app.hasUi) {
          writeJsonResponse(response, 404, {
            ok: false,
            error: `App ${app.slug} does not expose a UI.`,
          });
          return;
        }

        const targetPath = relativeAssetPath
          ? ensureContainedPath(app.publicDir, relativeAssetPath)
          : app.entryHtmlPath;
        if (!await pathExists(targetPath)) {
          writeJsonResponse(response, 404, {
            ok: false,
            error: "Static asset not found.",
          });
          return;
        }

        const bytes = await readFile(targetPath);
        response.writeHead(200, {"content-type": contentTypeForFile(targetPath)});
        response.end(bytes);
        return;
      }

      if (parts[0] === "api" && parts[1] === "apps" && parts.length >= 5) {
        const agentKey = parts[2] ?? "";
        const appSlug = parts[3] ?? "";
        const appSession = await resolveAppHttpSession({
          auth: options.auth,
          authMode,
          request,
          agentKey,
          appSlug,
        });
        assertAppCsrf({
          auth: options.auth,
          authMode,
          request,
          session: appSession,
        });
        const app = await options.service.getApp(agentKey, appSlug);
        const body = request.method === "POST" ? asRecord(await readJsonBody(request)) : {};
        const identityContext = appSession
          ? {identityId: appSession.identityId}
          : await resolveRequestIdentity({
            identityId: trimString(body.identityId) ?? trimString(requestUrl.searchParams.get("identityId")),
            identityHandle: trimString(body.identityHandle) ?? trimString(requestUrl.searchParams.get("identityHandle")),
            identityStore: options.identityStore,
          });
        const identityId = identityContext.identityId;
        const requestedSessionId = appSession?.sessionId
          ?? trimString(body.sessionId)
          ?? trimString(requestUrl.searchParams.get("sessionId"));
        const explicitSession = await resolveExplicitRequestSession({
          agentKey,
          requestedSessionId,
          sessionStore: options.sessionStore,
        });

        if (parts[4] === "bootstrap" && request.method === "GET") {
          const session = options.sessionStore
            ? (explicitSession ?? await options.sessionStore.getMainSession(agentKey))
            : null;
          writeJsonResponse(response, 200, {
            ok: true,
            app: {
              slug: app.slug,
              name: app.name,
              ...(app.description ? {description: app.description} : {}),
              identityScoped: app.identityScoped,
              hasUi: app.hasUi,
              viewNames: Object.keys(app.views),
              actionNames: Object.keys(app.actions),
              views: Object.entries(app.views).map(([name, definition]) => ({
                name,
                ...(definition.description ? {description: definition.description} : {}),
                paginated: Boolean(definition.pagination),
              })),
              actions: Object.entries(app.actions).map(([name, definition]) => ({
                name,
                mode: definition.mode ?? "native",
                ...(definition.description ? {description: definition.description} : {}),
                ...(readAgentAppRequiredInputKeys(definition)?.length
                  ? {requiredInputKeys: readAgentAppRequiredInputKeys(definition)}
                  : {}),
                ...(definition.inputSchema ? {inputSchema: definition.inputSchema} : {}),
              })),
            },
            context: {
              agentKey,
              identityId: identityId ?? null,
              identityHandle: identityContext.identityHandle ?? null,
              sessionId: session?.id ?? null,
              authenticated: Boolean(appSession),
            },
          });
          return;
        }

        if (parts[4] === "views" && parts[5] && request.method === "POST") {
          const result = await options.service.executeView(agentKey, appSlug, parts[5], {
            identityId,
            sessionId: explicitSession?.id,
            params: asRecord(body.params),
            pageSize: typeof body.pageSize === "number" ? body.pageSize : undefined,
            offset: typeof body.offset === "number" ? body.offset : undefined,
          });
          writeJsonResponse(response, 200, {
            ok: true,
            appSlug,
            viewName: parts[5],
            ...result,
          });
          return;
        }

        if (parts[4] === "actions" && parts[5] && request.method === "POST") {
          const actionName = parts[5];
          const actionDefinition = app.actions[actionName];
          if (!actionDefinition) {
            writeJsonResponse(response, 404, {
              ok: false,
              error: `Unknown app action ${actionName} in ${app.slug}.`,
            });
            return;
          }

          const actionNeedsWake = (actionDefinition.mode ?? "native") !== "native";
          const wakeSession = actionNeedsWake
            ? await resolveActionSession({
              agentKey,
              explicitSession,
              sessionStore: options.sessionStore,
            })
            : undefined;
          const wake = actionNeedsWake && wakeSession
            ? buildWakeHandler({
              agentKey,
              appSlug,
              actionName,
              identityId,
              session: wakeSession,
              coordinator: options.coordinator,
            })
            : undefined;
          const result = await options.service.executeAction(agentKey, appSlug, actionName, {
            identityId,
            sessionId: explicitSession?.id ?? wakeSession?.id,
            input: asRecord(body.input),
            wake,
          });
          writeJsonResponse(response, 200, {
            ok: true,
            appSlug,
            actionName,
            ...result,
          });
          return;
        }
      }

      writeJsonResponse(response, 404, {
        ok: false,
        error: "Not found.",
      });
    } catch (error) {
      writeJsonResponse(response, readAgentAppRequestStatus(error), {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
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
  const resolvedPort = typeof address === "object" && address ? address.port : options.port;

  return {
    host: options.host,
    port: resolvedPort,
    server,
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

async function resolveActionSession(input: {
  agentKey: string;
  explicitSession?: SessionRecord;
  sessionStore?: Pick<SessionStore, "getMainSession">;
}) {
  if (input.explicitSession) {
    return input.explicitSession;
  }

  if (!input.sessionStore) {
    throw new Error("App actions with wake mode require a session store.");
  }

  const mainSession = await input.sessionStore.getMainSession(input.agentKey);
  if (!mainSession) {
    throw new Error(`Agent ${input.agentKey} does not have a main session.`);
  }

  return mainSession;
}

function buildWakeHandler(input: {
  agentKey: string;
  appSlug: string;
  actionName: string;
  identityId?: string;
  session: SessionRecord;
  coordinator?: Pick<ThreadRuntimeCoordinator, "submitInput">;
}) {
  const coordinator = input.coordinator;
  if (!coordinator) {
    throw new Error("App actions with wake mode require a thread coordinator.");
  }

  return async (message: string): Promise<void> => {
    await coordinator.submitInput(input.session.currentThreadId, {
      message: stringToUserMessage(message),
      source: "app_http",
      channelId: input.appSlug,
      externalMessageId: `app:${input.appSlug}:${input.actionName}:${randomUUID()}`,
      ...(input.identityId ? {identityId: input.identityId} : {}),
      metadata: {
        kind: "app_action",
        agentKey: input.agentKey,
        appSlug: input.appSlug,
        actionName: input.actionName,
      },
    }, "wake");
  };
}
