import {normalizeAgentKey} from "../agents/types.js";
import {trimToUndefined} from "../../lib/strings.js";
import type {SessionRecord, ResolveSessionRefInput} from "./types.js";
import {normalizeSessionAlias} from "./types.js";

export interface SessionRefResolverStore {
  getSession(sessionId: string): Promise<SessionRecord>;
  getSessionByAlias(agentKey: string, alias: string): Promise<SessionRecord | null>;
}

function isUnknownSessionError(error: unknown, sessionRef: string): boolean {
  return error instanceof Error && error.message === `Unknown session ${sessionRef}`;
}

function unknownSessionError(sessionRef: string): Error {
  return new Error(`Unknown session ${sessionRef}`);
}

function missingScopeError(sessionRef: string): Error {
  return new Error(`Unknown session ${sessionRef}. Pass an agent scope to resolve aliases.`);
}

function scopedAgentMismatchError(input: {sessionRef: string; scopedAgentKey: string; requestedAgentKey: string}): Error {
  return new Error(
    `Session ref ${input.sessionRef} is scoped to agent ${input.scopedAgentKey}, not ${input.requestedAgentKey}.`,
  );
}

function sessionAgentMismatchError(input: {sessionId: string; sessionAgentKey: string; requestedAgentKey: string}): Error {
  return new Error(
    `Session ${input.sessionId} belongs to agent ${input.sessionAgentKey}, not ${input.requestedAgentKey}.`,
  );
}

function parseScopedAliasRef(sessionRef: string): {agentKey: string; alias: string} | null {
  const separator = sessionRef.indexOf(":");
  if (separator < 0) {
    return null;
  }

  try {
    return {
      agentKey: normalizeAgentKey(sessionRef.slice(0, separator)),
      alias: normalizeSessionAlias(sessionRef.slice(separator + 1)),
    };
  } catch {
    return null;
  }
}

export async function resolveSessionRef(
  sessions: SessionRefResolverStore,
  input: ResolveSessionRefInput,
): Promise<SessionRecord> {
  const sessionRef = trimToUndefined(input.sessionRef);
  if (!sessionRef) {
    throw new Error("Session ref must not be empty.");
  }

  const requestedAgentKey = input.agentKey ? normalizeAgentKey(input.agentKey) : undefined;
  try {
    const session = await sessions.getSession(sessionRef);
    if (requestedAgentKey && session.agentKey !== requestedAgentKey) {
      throw sessionAgentMismatchError({
        sessionId: session.id,
        sessionAgentKey: session.agentKey,
        requestedAgentKey,
      });
    }

    return session;
  } catch (error) {
    if (!isUnknownSessionError(error, sessionRef)) {
      throw error;
    }
  }

  const scopedRef = parseScopedAliasRef(sessionRef);
  if (scopedRef && requestedAgentKey && scopedRef.agentKey !== requestedAgentKey) {
    throw scopedAgentMismatchError({
      sessionRef,
      scopedAgentKey: scopedRef.agentKey,
      requestedAgentKey,
    });
  }

  const agentKey = scopedRef?.agentKey ?? requestedAgentKey;
  if (!agentKey) {
    throw missingScopeError(sessionRef);
  }

  let alias: string;
  try {
    alias = scopedRef?.alias ?? normalizeSessionAlias(sessionRef);
  } catch {
    throw unknownSessionError(sessionRef);
  }

  const session = await sessions.getSessionByAlias(agentKey, alias);
  if (!session) {
    throw unknownSessionError(sessionRef);
  }

  return session;
}
