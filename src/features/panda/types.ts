import type { JsonValue } from "../agent-core/types.js";
import type { ChannelOutboundDispatcher } from "../channels/core/outbound.js";

export interface PandaShellSession {
  cwd: string;
  env: Record<string, string>;
}

export interface PandaCurrentInputContext {
  source: string;
  channelId?: string;
  externalMessageId?: string;
  actorId?: string;
  metadata?: JsonValue;
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
  currentInput?: PandaCurrentInputContext;
  outboundDispatcher?: ChannelOutboundDispatcher;
}
