import {createReadStream} from "node:fs";
import {access, stat} from "node:fs/promises";
import {createServer, type IncomingMessage, type Server, type ServerResponse} from "node:http";
import path from "node:path";

import {readJsonHttpBody} from "../http-body.js";
import {writeJsonResponse} from "../../lib/http.js";
import type {PostgresControlAuthService} from "../../domain/control/auth.js";
import type {ControlReadService} from "../../domain/control/read-service.js";
import type {ControlBriefingService} from "../../domain/control/briefing-service.js";
import type {ControlHeartbeatService} from "../../domain/control/heartbeat-service.js";
import type {ControlSessionRecord} from "../../domain/control/types.js";

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
  briefings: ControlBriefingService;
  heartbeats: ControlHeartbeatService;
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

function clearCookie(response: ServerResponse, name: string): void {
  setCookie(response, name, "", "HttpOnly; SameSite=Strict; Path=/api/control; Max-Age=0");
}

function publicSession(session: ControlSessionRecord): Record<string, unknown> {
  return {
    id: session.id,
    identityId: session.identityId,
    role: session.role,
    expiresAt: new Date(session.expiresAt).toISOString(),
  };
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


function matchSessionHeartbeatPath(path: string): {agentKey: string; sessionId: string} | null {
  const match = /^\/agents\/([^/]+)\/sessions\/([^/]+)\/heartbeat$/.exec(path);
  if (!match) return null;
  return {agentKey: decodeURIComponent(match[1]!), sessionId: decodeURIComponent(match[2]!)};
}

function matchSessionBriefingPath(path: string): {agentKey: string; sessionId: string} | null {
  const match = /^\/agents\/([^/]+)\/sessions\/([^/]+)\/briefing$/.exec(path);
  if (!match) return null;
  return {agentKey: decodeURIComponent(match[1]!), sessionId: decodeURIComponent(match[2]!)};
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
      if (request.method === "POST" && path === "/login") {
        const body = await readBody(request);
        const token = typeof body.token === "string" ? body.token : "";
        let login;
        try {
          login = await options.auth.loginWithToken(token);
        } catch {
          throw new ControlHttpError(401, "Control login token is invalid, expired, or already used.");
        }
        setCookie(response, CONTROL_SESSION_COOKIE, login.sessionToken);
        setCookie(response, CONTROL_CSRF_COOKIE, login.csrfToken, "SameSite=Strict; Path=/api/control");
        writeJsonResponse(response, 200, {session: publicSession(login.session), csrfToken: login.csrfToken});
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
        clearCookie(response, CONTROL_CSRF_COOKIE);
        writeJsonResponse(response, 200, {ok: true});
        return;
      }
      if (request.method === "GET" && path === "/overview") {
        writeJsonResponse(response, 200, await options.reads.getOverview(session));
        return;
      }
      if (request.method === "GET" && path === "/agents") {
        writeJsonResponse(response, 200, {agents: await options.reads.listAgents(session)});
        return;
      }
      if (request.method === "GET" && path === "/credentials") {
        writeJsonResponse(response, 200, {credentials: await options.reads.listCredentials(session)});
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
