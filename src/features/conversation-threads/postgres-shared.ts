import { quoteIdentifier, validateIdentifier } from "../thread-runtime/postgres-shared.js";

export interface ConversationThreadRelationNames {
  conversationThreads: string;
}

export interface ConversationThreadTableNames extends ConversationThreadRelationNames {
  prefix: string;
}

function buildQuotedConversationThreadRelationNames(prefix: string): ConversationThreadRelationNames {
  return {
    conversationThreads: quoteIdentifier(`${prefix}_conversation_threads`),
  };
}

export function buildConversationThreadTableNames(prefix: string): ConversationThreadTableNames {
  const safePrefix = validateIdentifier(prefix);
  return {
    prefix: safePrefix,
    ...buildQuotedConversationThreadRelationNames(safePrefix),
  };
}
