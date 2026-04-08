import { describe, expect, it } from "vitest";

import { InMemoryChannelCursorStore } from "../src/index.js";

describe("InMemoryChannelCursorStore", () => {
  it("keeps reads harmless without Postgres", async () => {
    const store = new InMemoryChannelCursorStore();

    await expect(store.resolveChannelCursor({
      source: "telegram",
      connectorKey: "bot-main",
      cursorKey: "updates",
    })).resolves.toBeNull();
  });

  it("rejects writes without Postgres", async () => {
    const store = new InMemoryChannelCursorStore();

    await expect(store.upsertChannelCursor({
      source: "telegram",
      connectorKey: "bot-main",
      cursorKey: "updates",
      value: "1",
    })).rejects.toThrow("Persisted channel cursors require Postgres");
  });
});
