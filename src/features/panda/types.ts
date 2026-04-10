import type {JsonValue} from "../agent-core/types.js";
import type {CreateOutboundDeliveryInput, OutboundDeliveryRecord} from "../outbound-deliveries/types.js";
import type {ChannelActionRecord, CreateChannelActionInput} from "../channel-actions/types.js";
import type {RememberedRoute} from "../channels/core/types.js";

export interface PandaRouteMemory {
  getLastRoute(channel?: string): Promise<RememberedRoute | null>;
  rememberLastRoute(route: RememberedRoute): Promise<void>;
}

export interface PandaOutboundQueue {
  enqueueDelivery(input: CreateOutboundDeliveryInput): Promise<OutboundDeliveryRecord>;
}

export interface PandaChannelActionQueue {
  enqueueAction(input: CreateChannelActionInput): Promise<ChannelActionRecord>;
}

export interface PandaShellSession {
  cwd: string;
  env: Record<string, string>;
}

export interface PandaSessionContext {
  cwd?: string;
  shell?: PandaShellSession;
  timezone?: string;
  identityId?: string;
  identityHandle?: string;
  threadId?: string;
  agentKey?: string;
  currentInput?: {
    source: string;
    channelId?: string;
    externalMessageId?: string;
    actorId?: string;
    metadata?: JsonValue;
  };
  routeMemory?: PandaRouteMemory;
  outboundQueue?: PandaOutboundQueue;
  channelActionQueue?: PandaChannelActionQueue;
  subagentDepth?: number;
}
