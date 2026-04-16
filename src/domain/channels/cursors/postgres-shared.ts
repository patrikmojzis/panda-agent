import {buildRuntimeRelationNames} from "../../threads/runtime/postgres-shared.js";

export interface ChannelCursorTableNames {
  prefix: string;
  channelCursors: string;
}

export function buildChannelCursorTableNames(): ChannelCursorTableNames {
  return buildRuntimeRelationNames({
    channelCursors: "channel_cursors",
  });
}
