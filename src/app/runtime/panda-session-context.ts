import type {JsonValue} from "../../lib/json.js";
import type {AgentSessionKind} from "../../domain/sessions/types.js";
import type {OutboundDeliveryInput, OutboundDeliveryRecord,} from "../../domain/channels/deliveries/types.js";
import type {ChannelActionInput, ChannelActionRecord,} from "../../domain/channels/actions/types.js";
import type {OutboundItem, RememberedRoute} from "../../domain/channels/types.js";
import type {A2ASenderEnvironmentSnapshot} from "../../domain/threads/requests/types.js";
import type {ShellExecutionContext, ShellSession} from "../../integrations/shell/types.js";
import type {ResolvedExecutionEnvironment} from "../../domain/execution-environments/types.js";

export interface DefaultAgentRouteMemoryLookup {
  channel?: string;
  identityId?: string;
}

export interface DefaultAgentRouteMemorySaveOptions {
  identityId?: string;
}

export interface DefaultAgentRouteMemory {
  getLastRoute(lookup?: DefaultAgentRouteMemoryLookup): Promise<RememberedRoute | null>;
  saveLastRoute(route: RememberedRoute, options?: DefaultAgentRouteMemorySaveOptions): Promise<void>;
}

export interface DefaultAgentOutboundQueue {
  enqueueDelivery(input: OutboundDeliveryInput): Promise<OutboundDeliveryRecord>;
}

export interface DefaultAgentChannelActionQueue {
  enqueueAction(input: ChannelActionInput): Promise<ChannelActionRecord>;
}

export interface DefaultAgentMessageAgentService {
  queueMessage(input: {
    senderAgentKey: string;
    senderSessionId: string;
    senderThreadId: string;
    senderRunId?: string;
    agentKey?: string;
    sessionId?: string;
    senderEnvironment?: A2ASenderEnvironmentSnapshot;
    items: readonly OutboundItem[];
  }): Promise<{
    delivery: OutboundDeliveryRecord;
    targetAgentKey: string;
    targetSessionId: string;
    messageId: string;
  }>;
}

export type DefaultAgentShellSession = ShellSession;

export interface DefaultAgentCurrentInputContext {
  messageId?: string;
  source: string;
  channelId?: string;
  externalMessageId?: string;
  actorId?: string;
  identityId?: string;
  metadata?: JsonValue;
}

export interface DefaultAgentSessionContext extends ShellExecutionContext {
  cwd?: string;
  agentKey: string;
  sessionId: string;
  sessionKind?: AgentSessionKind;
  threadId: string;
  runId?: string;
  currentInput?: DefaultAgentCurrentInputContext;
  currentRouteInput?: DefaultAgentCurrentInputContext;
  routeMemory?: DefaultAgentRouteMemory;
  outboundQueue?: DefaultAgentOutboundQueue;
  channelActionQueue?: DefaultAgentChannelActionQueue;
  messageAgent?: DefaultAgentMessageAgentService;
  subagent?: JsonValue;
  subagentDepth?: number;
  resolveExecutionTarget?: (target?: string) => Promise<ResolvedExecutionEnvironment>;
  refreshCommandAccess?: (input: {
    executionEnvironment: ResolvedExecutionEnvironment;
    currentInput?: DefaultAgentCurrentInputContext;
    runId?: string;
    parentToolCallId?: string;
  }) => Promise<{
    refreshed: boolean;
    reason?: string;
    commandAccess?: {
      url?: string;
      socketPath?: string;
      token: string;
    };
  }>;
}
