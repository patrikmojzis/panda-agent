import {createServer, type IncomingMessage, type Server, type ServerResponse} from "node:http";

import {readJsonHttpBody} from "../http-body.js";
import {writeJsonResponse} from "../../lib/http.js";
import type {PostgresControlAuthService} from "../../domain/control/auth.js";
import type {ControlReadService} from "../../domain/control/read-service.js";
import type {ControlSessionRecord} from "../../domain/control/types.js";

export const CONTROL_SESSION_COOKIE = "panda_control_session";
export const CONTROL_CSRF_COOKIE = "panda_control_csrf";

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
      if (!url.pathname.startsWith("/api/control")) {
        writeJsonResponse(response, 404, {error: "not_found"});
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
