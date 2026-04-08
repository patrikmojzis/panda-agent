import { describe, expect, it } from "vitest";

import { InMemoryConversationThreadStore } from "../src/index.js";

describe("InMemoryConversationThreadStore", () => {
  it("keeps reads harmless without Postgres", async () => {
    const store = new InMemoryConversationThreadStore();

    await expect(store.resolveConversationThread({
      source: "telegram",
      connectorKey: "bot-main",
      externalConversationId: "chat-1",
    })).resolves.toBeNull();
  });

  it("rejects writes without Postgres", async () => {
    const store = new InMemoryConversationThreadStore();

    await expect(store.bindConversationThread({
      source: "telegram",
      connectorKey: "bot-main",
      externalConversationId: "chat-1",
      threadId: "thread-a",
    })).rejects.toThrow("Persisted conversation threads require Postgres");
  });
});
