import { afterEach, describe, expect, it } from "vitest";
import { DataType, newDb } from "pg-mem";

import { PostgresChannelCursorStore } from "../src/index.js";

describe("PostgresChannelCursorStore", () => {
  const pools: Array<{ end(): Promise<void> }> = [];

  afterEach(async () => {
    while (pools.length > 0) {
      const pool = pools.pop();
      if (!pool) {
        continue;
      }

      await pool.end();
    }
  });

  it("persists and updates connector cursors", async () => {
    const db = newDb();
    db.public.registerFunction({
      name: "pg_notify",
      args: [DataType.text, DataType.text],
      returns: DataType.text,
      implementation: () => "",
    });
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);

    const store = new PostgresChannelCursorStore({ pool });
    await store.ensureSchema();

    await expect(store.resolveChannelCursor({
      source: "telegram",
      connectorKey: "bot-main",
      cursorKey: "updates",
    })).resolves.toBeNull();

    const created = await store.upsertChannelCursor({
      source: " telegram ",
      connectorKey: " bot-main ",
      cursorKey: " updates ",
      value: "123",
      metadata: {
        note: "seeded",
      },
    });
    expect(created).toMatchObject({
      source: "telegram",
      connectorKey: "bot-main",
      cursorKey: "updates",
      value: "123",
      metadata: {
        note: "seeded",
      },
    });

    const updated = await store.upsertChannelCursor({
      source: "telegram",
      connectorKey: "bot-main",
      cursorKey: "updates",
      value: "124",
    });
    expect(updated).toMatchObject({
      value: "124",
      metadata: {
        note: "seeded",
      },
    });

    await expect(store.resolveChannelCursor({
      source: "telegram",
      connectorKey: "bot-main",
      cursorKey: "updates",
    })).resolves.toMatchObject({
      value: "124",
      metadata: {
        note: "seeded",
      },
    });
  });

  it("isolates cursors by source, connector, and key", async () => {
    const db = newDb();
    db.public.registerFunction({
      name: "pg_notify",
      args: [DataType.text, DataType.text],
      returns: DataType.text,
      implementation: () => "",
    });
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);

    const store = new PostgresChannelCursorStore({ pool });
    await store.ensureSchema();

    await store.upsertChannelCursor({
      source: "telegram",
      connectorKey: "bot-main",
      cursorKey: "updates",
      value: "10",
    });
    await store.upsertChannelCursor({
      source: "telegram",
      connectorKey: "bot-sidecar",
      cursorKey: "updates",
      value: "20",
    });
    await store.upsertChannelCursor({
      source: "whatsapp",
      connectorKey: "session-main",
      cursorKey: "updates",
      value: "30",
    });
    await store.upsertChannelCursor({
      source: "telegram",
      connectorKey: "bot-main",
      cursorKey: "history",
      value: "40",
    });

    await expect(store.resolveChannelCursor({
      source: "telegram",
      connectorKey: "bot-main",
      cursorKey: "updates",
    })).resolves.toMatchObject({ value: "10" });
    await expect(store.resolveChannelCursor({
      source: "telegram",
      connectorKey: "bot-sidecar",
      cursorKey: "updates",
    })).resolves.toMatchObject({ value: "20" });
    await expect(store.resolveChannelCursor({
      source: "whatsapp",
      connectorKey: "session-main",
      cursorKey: "updates",
    })).resolves.toMatchObject({ value: "30" });
    await expect(store.resolveChannelCursor({
      source: "telegram",
      connectorKey: "bot-main",
      cursorKey: "history",
    })).resolves.toMatchObject({ value: "40" });
  });

  it("validates required fields", async () => {
    const db = newDb();
    db.public.registerFunction({
      name: "pg_notify",
      args: [DataType.text, DataType.text],
      returns: DataType.text,
      implementation: () => "",
    });
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);

    const store = new PostgresChannelCursorStore({ pool });
    await store.ensureSchema();

    await expect(store.upsertChannelCursor({
      source: "   ",
      connectorKey: "bot-main",
      cursorKey: "updates",
      value: "1",
    })).rejects.toThrow("Channel cursor source must not be empty.");
    await expect(store.resolveChannelCursor({
      source: "telegram",
      connectorKey: "   ",
      cursorKey: "updates",
    })).rejects.toThrow("Channel cursor connector key must not be empty.");
    await expect(store.upsertChannelCursor({
      source: "telegram",
      connectorKey: "bot-main",
      cursorKey: "updates",
      value: "   ",
    })).rejects.toThrow("Channel cursor value must not be empty.");
  });
});
