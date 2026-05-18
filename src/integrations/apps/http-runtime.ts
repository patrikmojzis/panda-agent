import {randomUUID} from "node:crypto";

import type {IdentityStore} from "../../domain/identity/store.js";
import type {AgentAppSessionRecord} from "../../domain/apps/auth.js";
import {submitCurrentSessionInput} from "../../domain/sessions/current-thread.js";
import type {SessionRecord} from "../../domain/sessions/types.js";
import type {SessionStore} from "../../domain/sessions/store.js";
import type {ThreadRuntimeCoordinator} from "../../domain/threads/runtime/coordinator.js";
import {stringToUserMessage} from "../../kernel/agent/helpers/input.js";
import {trimToUndefined} from "../../lib/strings.js";
import {AgentAppRequestError} from "./http-errors.js";

export type AgentAppSessionLookupStore = Pick<SessionStore, "getSession">;
export type AgentAppMainSessionStore = Pick<SessionStore, "getMainSession">;
export type AgentAppSessionContextStore = AgentAppSessionLookupStore & AgentAppMainSessionStore;

function isUnknownSessionError(error: unknown, sessionId: string): boolean {
  return error instanceof Error && error.message === `Unknown session ${sessionId}`;
}

/**
 * Resolves the identity context supplied by an app HTTP request body or query.
 */
async function resolveAgentAppRequestIdentity(input: {
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

/**
 * Validates an explicit app HTTP session id before passing it to app actions.
 */
async function resolveExplicitAgentAppRequestSession(input: {
  agentKey: string;
  requestedSessionId?: string;
  sessionStore?: AgentAppSessionLookupStore;
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
      throw new AgentAppRequestError(404, "Requested session is not valid for this app.");
    }
    throw error;
  }

  if (session.agentKey !== input.agentKey) {
    throw new AgentAppRequestError(400, "Requested session is not valid for this app.");
  }

  return session;
}

export interface AgentAppApiRequestContext {
  readonly authenticated: boolean;
  readonly explicitSession?: SessionRecord;
  readonly identityHandle?: string;
  readonly identityId?: string;
}

/**
 * Resolves the identity and explicit session context shared by public app API
 * routes. Authenticated app cookies take precedence over browser-supplied
 * query/body context.
 */
export async function resolveAgentAppApiRequestContext(input: {
  agentKey: string;
  appSession: AgentAppSessionRecord | null;
  body: Record<string, unknown>;
  identityStore?: Pick<IdentityStore, "getIdentityByHandle">;
  requestUrl: URL;
  sessionStore?: AgentAppSessionLookupStore;
}): Promise<AgentAppApiRequestContext> {
  const identityContext = input.appSession
    ? {identityId: input.appSession.identityId}
    : await resolveAgentAppRequestIdentity({
      identityId: trimToUndefined(input.body.identityId) ?? trimToUndefined(input.requestUrl.searchParams.get("identityId")),
      identityHandle: trimToUndefined(input.body.identityHandle) ?? trimToUndefined(input.requestUrl.searchParams.get("identityHandle")),
      identityStore: input.identityStore,
    });
  const requestedSessionId = input.appSession
    ? input.appSession.sessionId
    : trimToUndefined(input.body.sessionId) ?? trimToUndefined(input.requestUrl.searchParams.get("sessionId"));
  const explicitSession = await resolveExplicitAgentAppRequestSession({
    agentKey: input.agentKey,
    requestedSessionId,
    sessionStore: input.sessionStore,
  });

  return {
    authenticated: Boolean(input.appSession),
    explicitSession,
    identityHandle: identityContext.identityHandle,
    identityId: identityContext.identityId,
  };
}

/**
 * Selects the session that should receive a wake after a non-native app action.
 */
export async function resolveAgentAppActionSession(input: {
  agentKey: string;
  explicitSession?: SessionRecord;
  sessionStore?: AgentAppMainSessionStore;
}): Promise<SessionRecord> {
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

/**
 * Builds the wake callback that app actions use to submit into the current
 * thread for the durable session.
 */
export function buildAgentAppWakeHandler(input: {
  agentKey: string;
  appSlug: string;
  actionName: string;
  identityId?: string;
  sessionId: string;
  sessionStore?: AgentAppSessionLookupStore;
  coordinator?: Pick<ThreadRuntimeCoordinator, "submitInput">;
}): (message: string) => Promise<void> {
  const coordinator = input.coordinator;
  if (!coordinator) {
    throw new Error("App actions with wake mode require a thread coordinator.");
  }
  const sessionStore = input.sessionStore;
  if (!sessionStore) {
    throw new Error("App actions with wake mode require a session store.");
  }

  return async (message: string): Promise<void> => {
    await submitCurrentSessionInput({
      sessions: sessionStore,
      sessionId: input.sessionId,
      coordinator,
      mode: "wake",
      payload: {
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
      },
    });
  };
}
