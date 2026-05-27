import type {IdentityRecord} from "../../domain/identity/types.js";
import type {CreateSubagentSessionRequestPayload} from "../../domain/threads/requests/types.js";
import type {
  CreateSubagentSessionInput,
  CreateSubagentSessionResult,
} from "./subagent-session-service.js";

export interface DaemonCreateSubagentSessionInput {
  identity: IdentityRecord;
  sessionId?: string;
  threadId?: string;
  agentKey?: string;
  parentSessionId: string;
  prompt: string;
  context?: string;
  profile?: string;
  execution?: CreateSubagentSessionRequestPayload["execution"];
  environmentId?: string;
  credentialAllowlist?: readonly string[];
  toolGroups?: readonly string[];
  model?: string;
  thinking?: CreateSubagentSessionRequestPayload["thinking"];
  inferenceProjection?: CreateSubagentSessionRequestPayload["inferenceProjection"];
}

export interface DaemonSubagentSessionContext {
  resolveAccessibleAgentKey(identity: IdentityRecord, explicitAgentKey?: string): Promise<string>;
  subagentSessions: {
    createSubagentSession(input: CreateSubagentSessionInput): Promise<CreateSubagentSessionResult>;
  };
}

export function createDaemonSubagentSessionCreator(
  context: DaemonSubagentSessionContext,
): (input: DaemonCreateSubagentSessionInput) => Promise<CreateSubagentSessionResult> {
  return async (input) => {
    const agentKey = await context.resolveAccessibleAgentKey(input.identity, input.agentKey);
    return context.subagentSessions.createSubagentSession({
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
      toolGroups: input.toolGroups,
      model: input.model,
      thinking: input.thinking,
      inferenceProjection: input.inferenceProjection,
      createdByIdentityId: input.identity.id,
    });
  };
}
