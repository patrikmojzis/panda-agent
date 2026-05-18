import type {BindA2ASessionInput, A2ASessionBindingRecord} from "../../domain/a2a/types.js";
import type {IdentityRecord} from "../../domain/identity/types.js";
import type {SessionStore} from "../../domain/sessions/store.js";
import type {CreateWorkerSessionRequestPayload} from "../../domain/threads/requests/types.js";
import type {
  CreateWorkerSessionInput,
  CreateWorkerSessionResult,
} from "./worker-session-service.js";

export interface DaemonCreateWorkerSessionInput {
  identity: IdentityRecord;
  sessionId?: string;
  threadId?: string;
  agentKey?: string;
  role?: string;
  task: string;
  context?: string;
  model?: string;
  thinking?: CreateWorkerSessionRequestPayload["thinking"];
  inferenceProjection?: CreateWorkerSessionRequestPayload["inferenceProjection"];
  credentialAllowlist?: readonly string[];
  environmentId?: string;
  skillAllowlist?: readonly string[];
  toolPolicy?: CreateWorkerSessionRequestPayload["toolPolicy"];
  ttlMs?: number;
  parentSessionId?: string;
}

export interface DaemonWorkerSessionContext {
  a2aBindings: {
    bindSession(input: BindA2ASessionInput): Promise<A2ASessionBindingRecord>;
  };
  resolveAccessibleAgentKey(identity: IdentityRecord, explicitAgentKey?: string): Promise<string>;
  sessions: Pick<SessionStore, "getSession">;
  workerSessions: {
    createWorkerSession(input: CreateWorkerSessionInput): Promise<CreateWorkerSessionResult>;
  };
}

export function createDaemonWorkerSessionCreator(
  context: DaemonWorkerSessionContext,
): (input: DaemonCreateWorkerSessionInput) => Promise<CreateWorkerSessionResult> {
  return async (input) => {
    const agentKey = await context.resolveAccessibleAgentKey(input.identity, input.agentKey);
    const parentSession = input.parentSessionId
      ? await context.sessions.getSession(input.parentSessionId)
      : null;
    if (parentSession && parentSession.agentKey !== agentKey) {
      throw new Error(`Worker session agent ${agentKey} must match parent session agent ${parentSession.agentKey}.`);
    }

    return context.workerSessions.createWorkerSession({
      agentKey,
      sessionId: input.sessionId,
      threadId: input.threadId,
      role: input.role,
      task: input.task,
      context: input.context,
      model: input.model,
      thinking: input.thinking,
      inferenceProjection: input.inferenceProjection,
      credentialAllowlist: input.credentialAllowlist,
      environmentId: input.environmentId,
      skillAllowlist: input.skillAllowlist,
      toolPolicy: input.toolPolicy,
      ttlMs: input.ttlMs,
      parentSessionId: input.parentSessionId,
      createdByIdentityId: input.identity.id,
      beforeHandoff: parentSession
        ? async (result) => {
          await context.a2aBindings.bindSession({
            senderSessionId: parentSession.id,
            recipientSessionId: result.session.id,
          });
          await context.a2aBindings.bindSession({
            senderSessionId: result.session.id,
            recipientSessionId: parentSession.id,
          });
        }
        : undefined,
    });
  };
}
