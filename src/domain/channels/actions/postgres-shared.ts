import {buildPrefixedRelationNames, validateIdentifier} from "../../threads/runtime/postgres-shared.js";

export interface ChannelActionTableNames {
  prefix: string;
  channelActions: string;
}

export function buildChannelActionTableNames(prefix: string): ChannelActionTableNames {
  return buildPrefixedRelationNames(prefix, {
    channelActions: "channel_actions",
  });
}

export function buildActionNotificationChannel(prefix = "thread_runtime"): string {
  return validateIdentifier(`${prefix}_channel_action_events`);
}
