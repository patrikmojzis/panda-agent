import {buildPrefixedRelationNames} from "../../threads/runtime/postgres-shared.js";

export interface ChannelCursorTableNames {
  prefix: string;
  channelCursors: string;
}

export function buildChannelCursorTableNames(prefix: string): ChannelCursorTableNames {
  return buildPrefixedRelationNames(prefix, {
    channelCursors: "channel_cursors",
  });
}
