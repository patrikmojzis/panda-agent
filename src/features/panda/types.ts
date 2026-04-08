import type { JsonValue } from "../agent-core/types.js";
import type { ChannelOutboundDispatcher } from "../channels/core/outbound.js";

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
}
