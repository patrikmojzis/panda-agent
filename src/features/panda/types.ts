import type { JsonValue } from "../agent-core/types.js";
import type { ChannelOutboundDispatcher } from "../channels/core/outbound.js";
import type { RememberedRoute } from "../channels/core/types.js";

export interface PandaRouteMemory {
  getLastRoute(): Promise<RememberedRoute | null>;
  rememberLastRoute(route: RememberedRoute): Promise<void>;
}

export interface PandaShellSession {
  cwd: string;
  env: Record<string, string>;
}

export interface PandaSessionContext {
  cwd?: string;
  shell?: PandaShellSession;
  locale?: string;
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
  outboundDispatcher?: ChannelOutboundDispatcher;
  routeMemory?: PandaRouteMemory;
}
