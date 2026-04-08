import { buildPrefixedRelationNames } from "../thread-runtime/postgres-shared.js";

export interface ConversationThreadTableNames {
  prefix: string;
  conversationThreads: string;
}

export function buildConversationThreadTableNames(prefix: string): ConversationThreadTableNames {
  return buildPrefixedRelationNames(prefix, {
    conversationThreads: "conversation_threads",
  });
}
