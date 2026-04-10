import {buildPrefixedRelationNames, validateIdentifier} from "../thread-runtime/postgres-shared.js";

export interface ChannelActionTableNames {
  prefix: string;
  channelActions: string;
}

export function buildChannelActionTableNames(prefix: string): ChannelActionTableNames {
  return buildPrefixedRelationNames(prefix, {
    channelActions: "channel_actions",
  });
}

export function buildChannelActionNotificationChannel(prefix = "thread_runtime"): string {
  return validateIdentifier(`${prefix}_channel_action_events`);
}
