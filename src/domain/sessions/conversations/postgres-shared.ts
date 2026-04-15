import {buildPrefixedRelationNames} from "../../threads/runtime/postgres-shared.js";

export interface ConversationSessionTableNames {
  prefix: string;
  conversationSessions: string;
}

export function buildConversationSessionTableNames(prefix: string): ConversationSessionTableNames {
  return buildPrefixedRelationNames(prefix, {
    conversationSessions: "conversation_sessions",
  });
}
