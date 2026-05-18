import {buildRuntimeRelationNames} from "../../../lib/postgres-relations.js";

export interface ChannelCursorTableNames {
  prefix: string;
  channelCursors: string;
}

export function buildChannelCursorTableNames(): ChannelCursorTableNames {
  return buildRuntimeRelationNames({
    channelCursors: "channel_cursors",
  });
}
