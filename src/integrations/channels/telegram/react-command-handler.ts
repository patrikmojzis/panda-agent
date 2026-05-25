import type {JsonObject, JsonValue} from "../../../lib/json.js";
import type {ChannelActionInput, ChannelActionRecord} from "../../../domain/channels/actions/types.js";
import type {SessionStore} from "../../../domain/sessions/store.js";
import type {ThreadRuntimeStore} from "../../../domain/threads/runtime/store.js";
import type {ThreadMessageRecord} from "../../../domain/threads/runtime/types.js";
import type {TelegramReactCommandRequestPayload} from "../../../domain/threads/requests/types.js";
import {enqueueTelegramReaction, type TelegramReactContext} from "./telegram-react-tool.js";

interface TelegramReactCommandChannelActionQueue {
  enqueueAction(input: ChannelActionInput): Promise<ChannelActionRecord>;
}

interface TelegramReactCommandDependencies {
  sessions: Pick<SessionStore, "getSession">;
  store: Pick<ThreadRuntimeStore, "getRun" | "getThread" | "loadTranscript">;
  channelActionQueue: TelegramReactCommandChannelActionQueue;
}

function readCurrentInputFromTranscript(
  messages: readonly ThreadMessageRecord[],
): TelegramReactContext["currentInput"] | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index];
    if (!entry || entry.origin !== "input") {
      continue;
    }

    return {
      source: entry.source,
      channelId: entry.channelId,
      externalMessageId: entry.externalMessageId,
      metadata: entry.metadata as JsonValue | undefined,
    };
  }

  return undefined;
}

export async function handleTelegramReactCommandRequest(
  payload: TelegramReactCommandRequestPayload,
  dependencies: TelegramReactCommandDependencies,
): Promise<JsonObject> {
  const run = await dependencies.store.getRun(payload.runId);
  if (run.status !== "running") {
    throw new Error("panda telegram react requires an active running agent run.");
  }
  if (run.threadId !== payload.threadId) {
    throw new Error("panda telegram react run/thread mismatch.");
  }

  const thread = await dependencies.store.getThread(payload.threadId);
  if (thread.sessionId !== payload.sessionId) {
    throw new Error("panda telegram react session/thread mismatch.");
  }

  const session = await dependencies.sessions.getSession(payload.sessionId);
  if (session.agentKey !== payload.agentKey) {
    throw new Error("panda telegram react agent/session mismatch.");
  }

  const transcript = await dependencies.store.loadTranscript(payload.threadId);
  return enqueueTelegramReaction({
    emoji: payload.emoji,
    remove: payload.remove,
    messageId: payload.messageId,
    target: payload.target,
  }, {
    currentInput: readCurrentInputFromTranscript(transcript),
    channelActionQueue: dependencies.channelActionQueue,
  });
}
