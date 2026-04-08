import type {
  BindConversationThreadResult,
  ConversationThreadBindingInput,
  ConversationThreadLookup,
  ConversationThreadRecord,
} from "./types.js";

export interface ConversationThreadStore {
  resolveConversationThread(lookup: ConversationThreadLookup): Promise<ConversationThreadRecord | null>;
  bindConversationThread(input: ConversationThreadBindingInput): Promise<BindConversationThreadResult>;
}
