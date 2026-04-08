import { buildPrefixedRelationNames } from "../thread-runtime/postgres-shared.js";

export interface ChannelCursorRelationNames {
  channelCursors: string;
}

export interface ChannelCursorTableNames extends ChannelCursorRelationNames {
  prefix: string;
}

export function buildChannelCursorTableNames(prefix: string): ChannelCursorTableNames {
  return buildPrefixedRelationNames(prefix, {
    channelCursors: "channel_cursors",
  });
}
