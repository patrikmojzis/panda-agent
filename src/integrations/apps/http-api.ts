import type {IncomingMessage, ServerResponse} from "node:http";

import type {AgentAppAuthService} from "../../domain/apps/auth.js";
import type {
  AgentAppActionResult,
  AgentAppDefinition,
  AgentAppViewResult,
} from "../../domain/apps/types.js";
import type {IdentityStore} from "../../domain/identity/store.js";
import type {ThreadRuntimeCoordinator} from "../../domain/threads/runtime/coordinator.js";
import {writeJsonResponse} from "../../lib/http.js";
import {
  assertAppCsrf,
  resolveAppHttpSession,
  type AgentAppAuthMode,
} from "./http-auth.js";
import {AgentAppRequestError} from "./http-errors.js";
import {
  readAgentAppBodyRecord,
  readAgentAppJsonBody,
} from "./http-body.js";
import {
  describeAgentAppDetails,
} from "./descriptors.js";
import {
  buildAgentAppWakeHandler,
  resolveAgentAppActionSession,
  resolveAgentAppApiRequestContext,
} from "./http-runtime.js";
import type {
  AgentAppApiRequestContext,
  AgentAppMainSessionStore,
  AgentAppSessionContextStore,
} from "./http-runtime.js";

interface AgentAppHttpApiService {
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

function isAgentAppApiPath(parts: readonly string[]): boolean {
  return parts[0] === "api" && parts[1] === "apps" && parts.length >= 5;
}

async function buildBootstrapPayload(input: {
  agentKey: string;
  app: AgentAppDefinition;
  apiContext: AgentAppApiRequestContext;
  sessionStore?: AgentAppMainSessionStore;
}): Promise<{
  ok: true;
  app: ReturnType<typeof describeAgentAppDetails>;
  context: {
    agentKey: string;
    authenticated: boolean;
    identityHandle: string | null;
    identityId: string | null;
    sessionId: string | null;
  };
}> {
  const session = input.sessionStore
    ? (input.apiContext.explicitSession ?? await input.sessionStore.getMainSession(input.agentKey))
    : null;

  return {
    ok: true,
    app: describeAgentAppDetails(input.app),
    context: {
      agentKey: input.agentKey,
      authenticated: input.apiContext.authenticated,
      identityHandle: input.apiContext.identityHandle ?? null,
      identityId: input.apiContext.identityId ?? null,
      sessionId: session?.id ?? null,
    },
  };
}

/**
 * Owns the authenticated `/api/apps/...` HTTP lane: app-session auth, CSRF,
 * browser-supplied context, and dispatch to bootstrap/view/action interfaces.
 */
export async function maybeWriteAgentAppApiResponse(input: {
  auth?: AgentAppAuthService;
  authMode: AgentAppAuthMode;
  coordinator?: Pick<ThreadRuntimeCoordinator, "submitInput">;
  identityStore?: Pick<IdentityStore, "getIdentityByHandle">;
  method?: string;
  parts: readonly string[];
  request: IncomingMessage;
  requestUrl: URL;
  response: ServerResponse;
  service: AgentAppHttpApiService;
  sessionStore?: AgentAppSessionContextStore;
}): Promise<boolean> {
  if (!isAgentAppApiPath(input.parts)) {
    return false;
  }

  const agentKey = input.parts[2] ?? "";
  const appSlug = input.parts[3] ?? "";
  const appSession = await resolveAppHttpSession({
    auth: input.auth,
    authMode: input.authMode,
    request: input.request,
    agentKey,
    appSlug,
  });
  assertAppCsrf({
    auth: input.auth,
    authMode: input.authMode,
    request: input.request,
    session: appSession,
  });

  const app = await input.service.getApp(agentKey, appSlug);
  const body = input.method === "POST" ? readAgentAppBodyRecord(await readAgentAppJsonBody(input.request)) : {};
  const apiContext = await resolveAgentAppApiRequestContext({
    agentKey,
    appSession,
    body,
    identityStore: input.identityStore,
    requestUrl: input.requestUrl,
    sessionStore: input.sessionStore,
  });
  const identityId = apiContext.identityId;
  const explicitSession = apiContext.explicitSession;

  if (input.parts[4] === "bootstrap" && input.method === "GET") {
    writeJsonResponse(input.response, 200, await buildBootstrapPayload({
      agentKey,
      apiContext,
      app,
      sessionStore: input.sessionStore,
    }));
    return true;
  }

  if (input.parts[4] === "views" && input.parts[5] && input.method === "POST") {
    const viewName = input.parts[5];
    if (!app.views[viewName]) {
      throw new AgentAppRequestError(404, `Unknown app view ${viewName} in ${app.slug}.`);
    }
    const result = await input.service.executeView(agentKey, appSlug, viewName, {
      identityId,
      sessionId: explicitSession?.id,
      params: readAgentAppBodyRecord(body.params, {
        allowMissing: true,
        label: "App view params",
      }),
      pageSize: typeof body.pageSize === "number" ? body.pageSize : undefined,
      offset: typeof body.offset === "number" ? body.offset : undefined,
    });
    writeJsonResponse(input.response, 200, {
      ok: true,
      appSlug,
      viewName,
      ...result,
    });
    return true;
  }

  if (input.parts[4] === "actions" && input.parts[5] && input.method === "POST") {
    const actionName = input.parts[5];
    const actionDefinition = app.actions[actionName];
    if (!actionDefinition) {
      throw new AgentAppRequestError(404, `Unknown app action ${actionName} in ${app.slug}.`);
    }

    const actionNeedsWake = (actionDefinition.mode ?? "native") !== "native";
    const wakeSession = actionNeedsWake
      ? await resolveAgentAppActionSession({
        agentKey,
        explicitSession,
        sessionStore: input.sessionStore,
      })
      : undefined;
    const wake = actionNeedsWake && wakeSession
      ? buildAgentAppWakeHandler({
        agentKey,
        appSlug,
        actionName,
        identityId,
        sessionId: wakeSession.id,
        sessionStore: input.sessionStore,
        coordinator: input.coordinator,
      })
      : undefined;
    const result = await input.service.executeAction(agentKey, appSlug, actionName, {
      identityId,
      sessionId: explicitSession?.id ?? wakeSession?.id,
      input: readAgentAppBodyRecord(body.input, {
        allowMissing: true,
        label: "App action input",
      }),
      wake,
    });
    writeJsonResponse(input.response, 200, {
      ok: true,
      appSlug,
      actionName,
      ...result,
    });
    return true;
  }

  return false;
}
