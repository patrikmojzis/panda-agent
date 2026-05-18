import {resolveChannelRouteTarget, type ResolvedChannelRouteTarget} from "../../channels/route-target.js";
import type {ChannelTypingTarget} from "../../channels/types.js";
import type {ChannelTypingDispatcher} from "../../channels/typing.js";
import type {ThreadRuntimeEvent} from "./coordinator.js";
import type {ThreadMessageRecord} from "./types.js";

interface ChannelTypingSession extends ResolvedChannelRouteTarget {
  runId: string;
}

function sameTarget(left: ChannelTypingTarget, right: ChannelTypingTarget): boolean {
  return left.source === right.source
    && left.connectorKey === right.connectorKey
    && left.externalConversationId === right.externalConversationId
    && (left.externalActorId ?? null) === (right.externalActorId ?? null);
}

function findLatestRouteTarget(messages: readonly ThreadMessageRecord[]): ResolvedChannelRouteTarget | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const resolved = resolveChannelRouteTarget(messages[index]);
    if (resolved) {
      return resolved;
    }
  }

  return null;
}

class ChannelTypingEventHandler {
  private readonly sessions = new Map<string, ChannelTypingSession>();

  constructor(private readonly dispatcher: ChannelTypingDispatcher) {}

  async handle(event: ThreadRuntimeEvent): Promise<void> {
    switch (event.type) {
      case "inputs_applied":
        await this.handleInputsApplied(event.threadId, event.runId, event.messages);
        break;
      case "run_finished":
        await this.stopSession(event.threadId, event.run.id, false);
        break;
      default:
        break;
    }
  }

  private async handleInputsApplied(
    threadId: string,
    runId: string,
    messages: readonly ThreadMessageRecord[],
  ): Promise<void> {
    const resolved = findLatestRouteTarget(messages);
    if (!resolved) {
      return;
    }

    const existing = this.sessions.get(threadId);
    if (
      existing
      && existing.runId === runId
      && existing.channel === resolved.channel
      && sameTarget(existing.target, resolved.target)
    ) {
      return;
    }

    await this.stopSession(threadId, undefined, false);

    const started = await this.dispatchSafely({
      channel: resolved.channel,
      target: resolved.target,
      phase: "start",
    });
    if (!started) {
      return;
    }

    // Typing is intentionally one-shot for now. A keepalive tied to run lifetime
    // outlives some outbound deliveries and creates misleading channel UX; the
    // next policy should be delivery-bound instead.
    const session: ChannelTypingSession = {
      runId,
      channel: resolved.channel,
      target: resolved.target,
    };

    this.sessions.set(threadId, session);
  }

  private async stopSession(threadId: string, runId?: string, notifyChannel = true): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) {
      return;
    }

    if (runId !== undefined && session.runId !== runId) {
      return;
    }

    this.sessions.delete(threadId);

    if (!notifyChannel) {
      return;
    }

    await this.dispatchSafely({
      channel: session.channel,
      target: session.target,
      phase: "stop",
    });
  }

  private async dispatchSafely(
    request: {
      channel: string;
      target: ChannelTypingTarget;
      phase: "start" | "keepalive" | "stop";
    },
  ): Promise<boolean> {
    try {
      await this.dispatcher.dispatch(request);
      return true;
    } catch {
      return false;
    }
  }
}

export function createChannelTypingEventHandler(
  typingDispatcher?: ChannelTypingDispatcher,
): (event: ThreadRuntimeEvent) => Promise<void> {
  if (!typingDispatcher) {
    return async () => {};
  }

  const handler = new ChannelTypingEventHandler(typingDispatcher);
  return async (event: ThreadRuntimeEvent) => {
    await handler.handle(event);
  };
}
