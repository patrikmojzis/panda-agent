import type {JsonValue} from "../../kernel/agent/types.js";
import type {CreateOutboundDeliveryInput, OutboundDeliveryRecord,} from "../../domain/channels/deliveries/types.js";
import type {ChannelActionRecord, CreateChannelActionInput,} from "../../domain/channels/actions/types.js";
import type {RememberedRoute} from "../../domain/channels/types.js";
import type {ShellExecutionContext, ShellSession} from "../../integrations/shell/types.js";

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

export type PandaShellSession = ShellSession;

export interface PandaSessionContext extends ShellExecutionContext {
  cwd?: string;
  timezone?: string;
  identityId?: string;
  identityHandle?: string;
  threadId?: string;
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
