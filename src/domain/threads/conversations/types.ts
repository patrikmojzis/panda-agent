import type {JsonValue} from "../../../kernel/agent/types.js";

export interface ConversationThreadLookup {
  source: string;
  connectorKey: string;
  externalConversationId: string;
}

export interface ConversationThreadBindingInput extends ConversationThreadLookup {
  threadId: string;
  metadata?: JsonValue;
}

export interface ConversationThreadRecord extends ConversationThreadBindingInput {
  createdAt: number;
  updatedAt: number;
}

export interface BindConversationThreadResult {
  binding: ConversationThreadRecord;
  previousThreadId?: string;
}
