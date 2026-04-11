import type {JsonValue} from "../../../kernel/agent/types.js";

export interface ChannelCursorLookup {
  source: string;
  connectorKey: string;
  cursorKey: string;
}

export interface ChannelCursorInput extends ChannelCursorLookup {
  value: string;
  metadata?: JsonValue;
}

export interface ChannelCursorRecord extends ChannelCursorInput {
  createdAt: number;
  updatedAt: number;
}
