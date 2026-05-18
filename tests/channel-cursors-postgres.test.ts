import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";

import {ChannelCursorRepo} from "../src/domain/channels/cursors/repo.js";

describe("ChannelCursorRepo", () => {
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

    const store = new ChannelCursorRepo({ pool });
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

    const store = new ChannelCursorRepo({ pool });
    await store.ensureSchema();

    await store.upsertChannelCursor({
      source: "telegram",
      connectorKey: "bot-main",
      cursorKey: "updates",
      value: "10",
    });
    await store.upsertChannelCursor({
      source: "telegram",
      connectorKey: "bot-secondary",
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
      connectorKey: "bot-secondary",
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

    const store = new ChannelCursorRepo({ pool });
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

  it("rejects non-json cursor metadata before persisting it", async () => {
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

    const store = new ChannelCursorRepo({ pool });
    await store.ensureSchema();

    await expect(store.upsertChannelCursor({
      source: "telegram",
      connectorKey: "bot-main",
      cursorKey: "updates",
      value: "1",
      metadata: Number.NaN,
    })).rejects.toThrow("Channel cursor metadata must be JSON-serializable.");
  });

  it("rejects malformed persisted cursor metadata", async () => {
    const query = async () => ({
      rows: [{
        source: "telegram",
        connector_key: "bot-main",
        cursor_key: "updates",
        cursor_value: "1",
        metadata: Number.NaN,
        created_at: new Date(1),
        updated_at: new Date(1),
      }],
    });
    const store = new ChannelCursorRepo({
      pool: {query},
    });

    await expect(store.resolveChannelCursor({
      source: "telegram",
      connectorKey: "bot-main",
      cursorKey: "updates",
    })).rejects.toThrow("Channel cursor metadata must be JSON-serializable.");
  });

  it("rejects malformed persisted cursor key fields", async () => {
    const query = async () => ({
      rows: [{
        source: "telegram",
        connector_key: "",
        cursor_key: "updates",
        cursor_value: "1",
        metadata: null,
        created_at: new Date(1),
        updated_at: new Date(1),
      }],
    });
    const store = new ChannelCursorRepo({
      pool: {query},
    });

    await expect(store.resolveChannelCursor({
      source: "telegram",
      connectorKey: "bot-main",
      cursorKey: "updates",
    })).rejects.toThrow("Channel cursor connector key must not be empty.");
  });

  it("rejects malformed persisted cursor timestamps", async () => {
    const query = async () => ({
      rows: [{
        source: "telegram",
        connector_key: "bot-main",
        cursor_key: "updates",
        cursor_value: "1",
        metadata: null,
        created_at: new Date(1),
        updated_at: "eventually",
      }],
    });
    const store = new ChannelCursorRepo({
      pool: {query},
    });

    await expect(store.resolveChannelCursor({
      source: "telegram",
      connectorKey: "bot-main",
      cursorKey: "updates",
    })).rejects.toThrow("Channel cursor updated_at must be a finite timestamp.");
  });

  it("rejects stringified persisted cursor timestamps", async () => {
    const query = async () => ({
      rows: [{
        source: "telegram",
        connector_key: "bot-main",
        cursor_key: "updates",
        cursor_value: "1",
        metadata: null,
        created_at: "2026-05-01T12:00:00.000Z",
        updated_at: new Date(1),
      }],
    });
    const store = new ChannelCursorRepo({
      pool: {query},
    });

    await expect(store.resolveChannelCursor({
      source: "telegram",
      connectorKey: "bot-main",
      cursorKey: "updates",
    })).rejects.toThrow("Channel cursor created_at must be a finite timestamp.");
  });
});
