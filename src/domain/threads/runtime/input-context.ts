import type {JsonObject, JsonValue} from "../../../lib/json.js";
import {isRecord} from "../../../lib/records.js";
import {isCompactBoundaryRecord} from "../../../kernel/transcript/checkpoint.js";
import type {ThreadMessageRecord} from "./types.js";

export type RunInputContext = JsonObject & {
  messageId: string;
  source: string;
  channelId?: string;
  externalMessageId?: string;
  actorId?: string;
  identityId?: string;
  metadata?: JsonValue;
};

/** Restores input provenance after a checkpoint has summarized the originating input. */
export function readRunInputContext(messages: readonly ThreadMessageRecord[], routeOnly = false): RunInputContext | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const entry = messages[index]!;
    if (entry.origin !== "input" || (routeOnly && (!isRecord(entry.metadata) || !isRecord(entry.metadata.route)))) continue;
    return {
      messageId: entry.id,
      source: entry.source,
      ...(entry.channelId === undefined ? {} : {channelId: entry.channelId}),
      ...(entry.externalMessageId === undefined ? {} : {externalMessageId: entry.externalMessageId}),
      ...(entry.actorId === undefined ? {} : {actorId: entry.actorId}),
      ...(entry.identityId === undefined ? {} : {identityId: entry.identityId}),
      ...(entry.metadata === undefined ? {} : {metadata: entry.metadata}),
    };
  }
  const checkpoint = messages.find(isCompactBoundaryRecord);
  const context = checkpoint?.metadata.replayContext?.[routeOnly ? "currentRouteInput" : "currentInput"];
  if (!isRecord(context) || typeof context.messageId !== "string" || typeof context.source !== "string") return undefined;
  for (const key of ["channelId", "externalMessageId", "actorId", "identityId"]) {
    if (context[key] !== undefined && typeof context[key] !== "string") throw new Error("Invalid compacted input provenance.");
  }
  return context as RunInputContext;
}

/** Captures the current input and most recent route for provider-neutral checkpoint storage. */
export function captureReplayContext(messages: readonly ThreadMessageRecord[]): JsonObject {
  const currentInput = readRunInputContext(messages);
  const currentRouteInput = readRunInputContext(messages, true);
  return {
    ...(currentInput ? {currentInput} : {}),
    ...(currentRouteInput ? {currentRouteInput} : {}),
  };
}
