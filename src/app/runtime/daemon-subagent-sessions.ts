import type {IdentityRecord} from "../../domain/identity/types.js";
import type {CreateSubagentSessionRequestPayload} from "../../domain/threads/requests/types.js";
import type {
  CreateSubagentSessionInput,
  CreateSubagentSessionResult,
} from "./subagent-session-service.js";
import {RetryableRuntimeRequestError} from "../../domain/threads/requests/errors.js";

export interface DaemonCreateSubagentSessionInput {
  operationId: string;
  replayAttempt: boolean;
  identityId: string;
  sessionId: string;
  threadId: string;
  agentKey?: string;
  parentSessionId: string;
  prompt: string;
  context?: string;
  profile?: string;
  execution?: CreateSubagentSessionRequestPayload["execution"];
  environmentId?: string;
  credentialAllowlist?: readonly string[];
  credentialRefAllowlist?: readonly string[];
  toolGroups?: readonly string[];
  model?: string;
  thinking?: CreateSubagentSessionRequestPayload["thinking"];
  inferenceProjection?: CreateSubagentSessionRequestPayload["inferenceProjection"];
}

export interface DaemonSubagentSessionContext {
  ensureIdentity(identityId: string): Promise<IdentityRecord>;
  resolveAccessibleAgentKey(identity: IdentityRecord, explicitAgentKey?: string): Promise<string>;
  sessions: {
    getSession(sessionId: string): Promise<{agentKey: string}>;
    getSessionCreationOperation(operationId: string): Promise<{
      identityId: string;
      agentKey: string;
      sessionId: string;
      threadId: string;
      kind: "main" | "branch" | "subagent";
    } | null>;
  };
  subagentSessions: {
    createSubagentSession(input: CreateSubagentSessionInput): Promise<CreateSubagentSessionResult>;
  };
}

export function createDaemonSubagentSessionCreator(
  context: DaemonSubagentSessionContext,
): (input: DaemonCreateSubagentSessionInput) => Promise<CreateSubagentSessionResult> {
  return async (input) => {
    const createWithAgent = (agentKey: string) => context.subagentSessions.createSubagentSession({
      operationId: input.operationId,
      replayAttempt: input.replayAttempt,
      agentKey,
      sessionId: input.sessionId,
      threadId: input.threadId,
      parentSessionId: input.parentSessionId,
      task: input.prompt,
      context: input.context,
      profile: input.profile,
      execution: input.execution,
      environmentId: input.environmentId,
      credentialAllowlist: input.credentialAllowlist,
      credentialRefAllowlist: input.credentialRefAllowlist,
      toolGroups: input.toolGroups,
      model: input.model,
      thinking: input.thinking,
      inferenceProjection: input.inferenceProjection,
      createdByIdentityId: input.identityId,
    });

    if (input.replayAttempt) {
      let receipt;
      try {
        receipt = await context.sessions.getSessionCreationOperation(input.operationId);
      } catch (error) {
        throw new RetryableRuntimeRequestError(
          `Subagent session operation ${input.operationId} could not read its creation receipt.`,
          {cause: error},
        );
      }
      if (receipt) {
        if (
          receipt.identityId !== input.identityId
          || receipt.kind !== "subagent"
          || receipt.sessionId !== input.sessionId
          || receipt.threadId !== input.threadId
          || (input.agentKey !== undefined && receipt.agentKey !== input.agentKey)
        ) {
          throw new Error(`Subagent session operation ${input.operationId} conflicts with another target.`);
        }
        return createWithAgent(receipt.agentKey);
      }
    }

    const identity = await context.ensureIdentity(input.identityId);
    const agentKey = await context.resolveAccessibleAgentKey(identity, input.agentKey);
    return createWithAgent(agentKey);
  };
}
