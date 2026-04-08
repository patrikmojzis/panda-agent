import type {
  ChannelCursorInput,
  ChannelCursorLookup,
  ChannelCursorRecord,
} from "./types.js";
import type { ChannelCursorStore } from "./store.js";

function requiresPostgresError(): Error {
  return new Error("Persisted channel cursors require Postgres. Pass --db-url or set PANDA_DATABASE_URL.");
}

export class InMemoryChannelCursorStore implements ChannelCursorStore {
  async resolveChannelCursor(_lookup: ChannelCursorLookup): Promise<ChannelCursorRecord | null> {
    return null;
  }

  async upsertChannelCursor(_input: ChannelCursorInput): Promise<ChannelCursorRecord> {
    throw requiresPostgresError();
  }
}
