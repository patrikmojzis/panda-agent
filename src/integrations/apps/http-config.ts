import {DEFAULT_APP_SESSION_TTL_MS} from "../../domain/apps/auth.js";
import {isLoopbackHttpHostname, normalizeHttpHostname} from "../../lib/http.js";
import {readTcpPort} from "../../lib/numbers.js";
import {trimToNull} from "../../lib/strings.js";
import type {AgentAppAuthMode} from "./http-auth.js";

export const DEFAULT_APPS_HOST = "127.0.0.1";
export const DEFAULT_APPS_PORT = 8092;
const WILDCARD_APP_HOSTS = new Set(["0.0.0.0", "::"]);

function parsePort(value: string, label: string): number {
  const parsed = readTcpPort(value, {allowZero: true});
  if (parsed === undefined) {
    throw new Error(`Invalid ${label}: ${value}`);
  }

  return parsed;
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

function isLocalAppsHostname(hostname: string): boolean {
  const normalized = normalizeHttpHostname(hostname);
  return normalized.endsWith(".localhost") || isLoopbackHttpHostname(normalized);
}

function readPublicAppsBaseUrl(env: NodeJS.ProcessEnv): URL | null {
  const raw = trimToNull(env.PANDA_APPS_BASE_URL);
  if (!raw) {
    return null;
  }

  try {
    return new URL(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid PANDA_APPS_BASE_URL value: ${message}`);
  }
}

/** Enforces that publicly visible app URLs are plain safe origins. */
export function assertSafePublicAppsBaseUrl(env: NodeJS.ProcessEnv): void {
  const publicBaseUrl = readPublicAppsBaseUrl(env);
  if (!publicBaseUrl) {
    return;
  }
  if (
    publicBaseUrl.username
    || publicBaseUrl.password
    || publicBaseUrl.search
    || publicBaseUrl.hash
    || publicBaseUrl.pathname !== "/"
  ) {
    throw new Error("PANDA_APPS_BASE_URL must be a plain origin like https://apps.example.com.");
  }
  if (publicBaseUrl.protocol !== "https:" && !isLocalAppsHostname(publicBaseUrl.hostname)) {
    throw new Error("PANDA_APPS_BASE_URL must use https:// for non-local app hosts.");
  }
}

export function buildAgentAppPath(agentKey: string, appSlug: string): string {
  return `/${encodeURIComponent(agentKey)}/apps/${encodeURIComponent(appSlug)}/`;
}

export function buildAgentAppOpenPath(token: string): string {
  return `/apps/open?token=${encodeURIComponent(token)}`;
}

export function buildAgentAppCookiePath(agentKey: string, appSlug: string): string {
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

export function resolveCookieSecure(env: NodeJS.ProcessEnv): boolean {
  const publicBaseUrl = readPublicAppsBaseUrl(env);
  const raw = trimToNull(env.PANDA_APPS_COOKIE_SECURE)?.toLowerCase();
  if (raw) {
    if (["true", "1", "on"].includes(raw)) {
      return true;
    }
    if (["false", "0", "off"].includes(raw)) {
      if (publicBaseUrl && !isLocalAppsHostname(publicBaseUrl.hostname)) {
        throw new Error("PANDA_APPS_COOKIE_SECURE=false is only allowed for local app hosts.");
      }
      return false;
    }
    throw new Error(`Invalid PANDA_APPS_COOKIE_SECURE value: ${raw}`);
  }

  return publicBaseUrl?.protocol === "https:" || false;
}

export function resolveSessionTtlMs(env: NodeJS.ProcessEnv): number {
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

export function resolveRateLimitPerMinute(env: NodeJS.ProcessEnv): number {
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

export interface AgentAppUrls {
  appPath: string;
  appUrl: string;
  localAppUrl: string;
  internalAppUrl?: string;
  publicAppUrl?: string;
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
  assertSafePublicAppsBaseUrl(env);
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
