import {requireNonEmptyString} from "../../lib/strings.js";
import type {ChannelTypingRequest} from "./types.js";

export interface ChannelTypingAdapter {
  channel: string;
  send(request: ChannelTypingRequest): Promise<void>;
}

function requireTrimmedChannel(value: string): string {
  return requireNonEmptyString(value, "Typing channel must not be empty.");
}

export class ChannelTypingDispatcher {
  private readonly adapters = new Map<string, ChannelTypingAdapter>();

  constructor(adapters: readonly ChannelTypingAdapter[]) {
    for (const adapter of adapters) {
      this.adapters.set(requireTrimmedChannel(adapter.channel), adapter);
    }
  }

  async dispatch(request: ChannelTypingRequest): Promise<void> {
    const channel = requireTrimmedChannel(request.channel);
    const adapter = this.adapters.get(channel);
    if (!adapter) {
      throw new Error(`No typing adapter registered for channel ${channel}.`);
    }

    await adapter.send({
      ...request,
      channel,
    });
  }
}
