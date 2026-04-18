import type {JsonValue} from "../../kernel/agent/types.js";
import type {OutboundDeliveryInput, OutboundDeliveryRecord,} from "../../domain/channels/deliveries/types.js";
import type {ChannelActionInput, ChannelActionRecord,} from "../../domain/channels/actions/types.js";
import type {OutboundItem, RememberedRoute} from "../../domain/channels/types.js";
import type {ShellExecutionContext, ShellSession} from "../../integrations/shell/types.js";

export interface DefaultAgentRouteMemory {
  getLastRoute(channel?: string): Promise<RememberedRoute | null>;
  saveLastRoute(route: RememberedRoute): Promise<void>;
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
    items: readonly OutboundItem[];
  }): Promise<{
    delivery: OutboundDeliveryRecord;
    targetAgentKey: string;
    targetSessionId: string;
    messageId: string;
  }>;
}

export type DefaultAgentShellSession = ShellSession;

export interface DefaultAgentSessionContext extends ShellExecutionContext {
  cwd?: string;
  agentKey: string;
  sessionId: string;
  threadId: string;
  runId?: string;
  currentInput?: {
    source: string;
    channelId?: string;
    externalMessageId?: string;
    actorId?: string;
    identityId?: string;
    metadata?: JsonValue;
  };
  routeMemory?: DefaultAgentRouteMemory;
  outboundQueue?: DefaultAgentOutboundQueue;
  channelActionQueue?: DefaultAgentChannelActionQueue;
  messageAgent?: DefaultAgentMessageAgentService;
  subagentDepth?: number;
}
