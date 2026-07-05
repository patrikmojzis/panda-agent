import type {IncomingMessage} from "node:http";

import {
  type AgentAppAuthService,
  type AgentAppSessionRecord,
  buildAgentAppCookieNames,
} from "../../domain/apps/auth.js";
import {AgentAppRequestError} from "./http-errors.js";

export const APP_CSRF_HEADER = "x-panda-app-csrf";

export type AgentAppAuthMode = "off" | "required";

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

export function serializeCookie(input: {
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

export async function resolveAppHttpSession(input: {
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
    throw new AgentAppRequestError(401, "Open this app from a fresh panda micro-app link create link.");
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

export function assertAppCsrf(input: {
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
