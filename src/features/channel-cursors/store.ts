import type {
  ChannelCursorInput,
  ChannelCursorLookup,
  ChannelCursorRecord,
} from "./types.js";

export interface ChannelCursorStore {
  resolveChannelCursor(lookup: ChannelCursorLookup): Promise<ChannelCursorRecord | null>;
  upsertChannelCursor(input: ChannelCursorInput): Promise<ChannelCursorRecord>;
}
