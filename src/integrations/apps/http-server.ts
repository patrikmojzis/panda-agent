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
import {AgentAppService} from "./sqlite-service.js";

export const DEFAULT_APPS_HOST = "127.0.0.1";
export const DEFAULT_APPS_PORT = 8092;
const WILDCARD_APP_HOSTS = new Set(["0.0.0.0", "::"]);

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
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
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

export function buildAgentAppPath(agentKey: string, appSlug: string): string {
  return `/apps/${encodeURIComponent(agentKey)}/${encodeURIComponent(appSlug)}/`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function buildSdkScript(): string {
  return `(() => {
  const trim = (value) => typeof value === "string" && value.trim() ? value.trim() : undefined;
  const url = new URL(window.location.href);
  const parts = url.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
  const appsIndex = parts.indexOf("apps");
  if (appsIndex === -1 || !parts[appsIndex + 1] || !parts[appsIndex + 2]) {
    return;
  }

  const agentKey = parts[appsIndex + 1];
  const appSlug = parts[appsIndex + 2];
  const apiBase = \`/api/apps/\${encodeURIComponent(agentKey)}/\${encodeURIComponent(appSlug)}\`;
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
    const response = await fetch(requestPath, {
      credentials: "same-origin",
      ...options,
      method,
      headers: {
        ...(method === "GET" ? {} : {"content-type": "application/json"}),
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
    agentKey,
    appSlug,
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

class AgentAppRequestError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "AgentAppRequestError";
  }
}

function readAgentAppRequestStatus(error: unknown): number {
  return error instanceof AgentAppRequestError ? error.statusCode : 500;
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
  const server = createServer(async (request, response) => {
    try {
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

      if (parts[0] === "apps" && parts.length >= 3 && request.method === "GET") {
        const agentKey = parts[1] ?? "";
        const appSlug = parts[2] ?? "";
        const app = await options.service.getApp(agentKey, appSlug);
        if (!app.hasUi) {
          writeJsonResponse(response, 404, {
            ok: false,
            error: `App ${app.slug} does not expose a UI.`,
          });
          return;
        }

        const relativeAssetPath = parts.slice(3).join("/");
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
        const app = await options.service.getApp(agentKey, appSlug);
        const body = request.method === "POST" ? asRecord(await readJsonBody(request)) : {};
        const identityContext = await resolveRequestIdentity({
          identityId: trimString(body.identityId) ?? trimString(requestUrl.searchParams.get("identityId")),
          identityHandle: trimString(body.identityHandle) ?? trimString(requestUrl.searchParams.get("identityHandle")),
          identityStore: options.identityStore,
        });
        const identityId = identityContext.identityId;
        const requestedSessionId = trimString(body.sessionId) ?? trimString(requestUrl.searchParams.get("sessionId"));
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
