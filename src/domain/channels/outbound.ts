import {requireNonEmptyString} from "../../lib/strings.js";
import type {OutboundRequest, OutboundResult} from "./types.js";

export interface ChannelOutboundAdapter {
  channel: string;
  send(request: OutboundRequest): Promise<OutboundResult>;
}

function requireTrimmedChannel(value: string): string {
  return requireNonEmptyString(value, "Outbound channel must not be empty.");
}

export class ChannelOutboundDispatcher {
  private readonly adapters = new Map<string, ChannelOutboundAdapter>();

  constructor(adapters: readonly ChannelOutboundAdapter[]) {
    for (const adapter of adapters) {
      this.adapters.set(requireTrimmedChannel(adapter.channel), adapter);
    }
  }

  async dispatch(request: OutboundRequest): Promise<OutboundResult> {
    const channel = requireTrimmedChannel(request.channel);
    const adapter = this.adapters.get(channel);
    if (!adapter) {
      throw new Error(`No outbound adapter registered for channel ${channel}.`);
    }

    return adapter.send({
      ...request,
      channel,
    });
  }
}
