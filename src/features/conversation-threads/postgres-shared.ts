import { buildPrefixedRelationNames } from "../thread-runtime/postgres-shared.js";

export interface ConversationThreadRelationNames {
  conversationThreads: string;
}

export interface ConversationThreadTableNames extends ConversationThreadRelationNames {
  prefix: string;
}

export function buildConversationThreadTableNames(prefix: string): ConversationThreadTableNames {
  return buildPrefixedRelationNames(prefix, {
    conversationThreads: "conversation_threads",
  });
}
