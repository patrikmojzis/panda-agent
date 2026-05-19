import type {JsonValue} from "../../../lib/json.js";

export interface ConversationLookup {
  source: string;
  connectorKey: string;
  externalConversationId: string;
}

export interface ConversationBindingListFilter {
  source: string;
  connectorKey: string;
}

export interface BindConversationInput extends ConversationLookup {
  sessionId: string;
  metadata?: JsonValue;
}

export interface ConversationBinding extends BindConversationInput {
  createdAt: number;
  updatedAt: number;
}

export interface BindConversationResult {
  binding: ConversationBinding;
  previousSessionId?: string;
}
