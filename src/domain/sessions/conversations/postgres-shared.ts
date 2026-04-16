import {buildRuntimeRelationNames} from "../../threads/runtime/postgres-shared.js";

export interface ConversationSessionTableNames {
  prefix: string;
  conversationSessions: string;
}

export function buildConversationSessionTableNames(): ConversationSessionTableNames {
  return buildRuntimeRelationNames({
    conversationSessions: "conversation_sessions",
  });
}
