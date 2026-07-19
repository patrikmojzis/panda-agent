import {createServer, type Server} from "node:http";

import type {
  AgentAppActionResult,
  AgentAppDefinition,
  AgentAppViewResult,
} from "../../domain/apps/types.js";
import type {IdentityStore} from "../../domain/identity/store.js";
import {writeJsonResponse} from "../../lib/http.js";
import type {ThreadRuntimeCoordinator} from "../../domain/threads/runtime/coordinator.js";
import type {AgentAppAuthService} from "../../domain/apps/auth.js";
import {AgentAppRequestError} from "./http-errors.js";
import {
  assertSafePublicAppsBaseUrl,
  resolveAgentAppAuthMode,
  resolveCookieSecure,
  resolveRateLimitPerMinute,
  readPublicAppsPathPrefix,
  resolveSessionTtlMs,
  type AgentAppServerBinding,
} from "./http-config.js";
import {
  APP_CSRF_HEADER,
  resolveAppHttpSession,
  type AgentAppAuthMode,
} from "./http-auth.js";
import {buildAgentAppSdkScript} from "./http-sdk.js";
import {setAgentAppSecurityHeaders} from "./http-security-headers.js";
import {createAgentAppRateLimiter, readAgentAppRateLimitKey} from "./http-rate-limit.js";
import {writeAgentAppLaunchResponse} from "./http-launch.js";
import {maybeWriteAgentAppApiResponse} from "./http-api.js";
import type {AgentAppSessionContextStore} from "./http-runtime.js";
import {parseAgentAppRequestTarget, parseAgentAppUiPath} from "./http-routes.js";
import {readAgentAppStaticAsset} from "./http-static.js";

export interface AgentAppServerOptions extends AgentAppServerBinding {
  service: AgentAppHttpService;
  auth?: AgentAppAuthService;
  authMode?: AgentAppAuthMode;
  cookieSecure?: boolean;
  env?: NodeJS.ProcessEnv;
  rateLimitPerMinute?: number;
  sessionTtlMs?: number;
  identityStore?: Pick<IdentityStore, "getIdentityByHandle">;
  sessionStore?: AgentAppSessionContextStore;
  coordinator?: Pick<ThreadRuntimeCoordinator, "submitInput">;
}

export interface AgentAppHttpService {
  getApp(agentKey: string, appSlug: string): Promise<AgentAppDefinition>;
  executeView(
    agentKey: string,
    appSlug: string,
    viewName: string,
    options: {
      identityId?: string;
      offset?: number;
      pageSize?: number;
      params?: Record<string, unknown>;
      sessionId?: string;
    },
  ): Promise<AgentAppViewResult>;
  executeAction(
    agentKey: string,
    appSlug: string,
    actionName: string,
    options: {
      identityId?: string;
      input?: Record<string, unknown>;
      sessionId?: string;
      wake?: ((message: string) => Promise<void>) | undefined;
    },
  ): Promise<AgentAppActionResult>;
}

export interface AgentAppServer {
  readonly host: string;
  readonly port: number;
  readonly server: Server;
  close(): Promise<void>;
}

function readAgentAppErrorResponse(error: unknown): {
  statusCode: number;
  message: string;
} {
  if (error instanceof AgentAppRequestError) {
    return {
      statusCode: error.statusCode,
      message: error.message,
    };
  }

  console.error("Agent app request failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  return {
    statusCode: 500,
    message: "Internal server error.",
  };
}

function rewriteAgentAppHtmlForPrefix(bytes: Buffer, contentType: string, pathPrefix: string): Buffer {
  if (!pathPrefix || !contentType.toLowerCase().startsWith("text/html")) {
    return bytes;
  }

  return Buffer.from(
    bytes.toString("utf8").replaceAll("\"/panda-app-sdk.js\"", `"${pathPrefix}/panda-app-sdk.js"`),
    "utf8",
  );
}

export async function startAgentAppServer(options: AgentAppServerOptions): Promise<AgentAppServer> {
  const env = options.env ?? process.env;
  assertSafePublicAppsBaseUrl(env);
  const pathPrefix = readPublicAppsPathPrefix(env);
  const authMode = options.authMode ?? resolveAgentAppAuthMode(env);
  if (authMode === "required" && !options.auth) {
    throw new Error("PANDA_APPS_AUTH requires an app auth service.");
  }
  const cookieSecure = options.cookieSecure ?? resolveCookieSecure(env);
  const rateLimitAllows = createAgentAppRateLimiter(options.rateLimitPerMinute ?? resolveRateLimitPerMinute(env));
  const sessionTtlMs = options.sessionTtlMs ?? resolveSessionTtlMs(env);

  const server = createServer(async (request, response) => {
    try {
      setAgentAppSecurityHeaders(response);
      if (!rateLimitAllows(readAgentAppRateLimitKey(request))) {
        throw new AgentAppRequestError(429, "Too many app requests. Try again in a minute.");
      }
      const {parts, requestUrl} = parseAgentAppRequestTarget(request.url ?? "/", {pathPrefix});

      if (request.method === "GET" && requestUrl.pathname === "/health") {
        writeJsonResponse(response, 200, {ok: true});
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/panda-app-sdk.js") {
        response.writeHead(200, {"content-type": "text/javascript; charset=utf-8"});
        response.end(buildAgentAppSdkScript({csrfHeaderName: APP_CSRF_HEADER, pathPrefix}));
        return;
      }

      if (parts[0] === "apps" && parts[1] === "open") {
        await writeAgentAppLaunchResponse({
          auth: options.auth,
          cookieSecure,
          method: request.method,
          pathPrefix,
          requestUrl,
          response,
          service: options.service,
          sessionTtlMs,
        });
        return;
      }

      const appUiPath = parseAgentAppUiPath(parts);
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
        const asset = await readAgentAppStaticAsset(app, relativeAssetPath);
        response.writeHead(200, {"content-type": asset.contentType});
        response.end(rewriteAgentAppHtmlForPrefix(asset.bytes, asset.contentType, pathPrefix));
        return;
      }

      if (await maybeWriteAgentAppApiResponse({
        auth: options.auth,
        authMode,
        coordinator: options.coordinator,
        identityStore: options.identityStore,
        method: request.method,
        parts,
        request,
        requestUrl,
        response,
        service: options.service,
        sessionStore: options.sessionStore,
      })) {
        return;
      }

      writeJsonResponse(response, 404, {
        ok: false,
        error: "Not found.",
      });
    } catch (error) {
      const errorResponse = readAgentAppErrorResponse(error);
      writeJsonResponse(response, errorResponse.statusCode, {
        ok: false,
        error: errorResponse.message,
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
