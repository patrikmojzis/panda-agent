import type {
  BindConversationThreadResult,
  ConversationThreadBindingInput,
  ConversationThreadLookup,
  ConversationThreadRecord,
} from "./types.js";
import type { ConversationThreadStore } from "./store.js";

function requiresPostgresError(): Error {
  return new Error("Persisted conversation threads require Postgres. Pass --db-url or set PANDA_DATABASE_URL.");
}

export class InMemoryConversationThreadStore implements ConversationThreadStore {
  async resolveConversationThread(_lookup: ConversationThreadLookup): Promise<ConversationThreadRecord | null> {
    return null;
  }

  async bindConversationThread(_input: ConversationThreadBindingInput): Promise<BindConversationThreadResult> {
    throw requiresPostgresError();
  }
}
