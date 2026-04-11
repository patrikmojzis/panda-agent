import type {JsonValue} from "../../../kernel/agent/types.js";

export interface ConversationLookup {
  source: string;
  connectorKey: string;
  externalConversationId: string;
}

export interface BindConversationInput extends ConversationLookup {
  threadId: string;
  metadata?: JsonValue;
}

export interface ConversationBinding extends BindConversationInput {
  createdAt: number;
  updatedAt: number;
}

export interface BindConversationResult {
  binding: ConversationBinding;
  previousThreadId?: string;
}
