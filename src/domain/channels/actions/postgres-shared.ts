import {buildRuntimeRelationNames} from "../../threads/runtime/postgres-shared.js";

export interface ChannelActionTableNames {
  prefix: string;
  channelActions: string;
}

export function buildChannelActionTableNames(): ChannelActionTableNames {
  return buildRuntimeRelationNames({
    channelActions: "channel_actions",
  });
}

export function buildActionNotificationChannel(): string {
  return "runtime_channel_action_events";
}
