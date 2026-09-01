import {afterEach, describe, expect, it} from "vitest";
import {newDb} from "pg-mem";

import {CHANNEL_ACTION_EXPIRY_MIGRATION} from "../src/app/database/migrations/0017-channel-action-expiry.js";

describe("channel-action expiry migration", () => {
  const pools: Array<{end(): Promise<void>}> = [];

  afterEach(async () => {
    while (pools.length > 0) await pools.pop()?.end();
  });

  it("expires historical pending typing without replaying or changing durable work", async () => {
    const adapter = newDb().adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);
    await pool.query(`
      CREATE SCHEMA "runtime";
      CREATE TABLE "runtime"."channel_actions" (
        id UUID PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        completed_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      INSERT INTO "runtime"."channel_actions" (id, kind, status) VALUES
        ('00000000-0000-0000-0000-000000000001', 'typing', 'pending'),
        ('00000000-0000-0000-0000-000000000002', 'telegram_reaction', 'pending'),
        ('00000000-0000-0000-0000-000000000003', 'typing', 'sent');
    `);

    await CHANNEL_ACTION_EXPIRY_MIGRATION.apply({queryable: pool});

    await expect(pool.query(`
      SELECT id, kind, status, attempt_count, last_error, expires_at,
             completed_at IS NOT NULL AS completed
      FROM "runtime"."channel_actions"
      ORDER BY id
    `)).resolves.toMatchObject({rows: [
      {
        id: "00000000-0000-0000-0000-000000000001",
        kind: "typing",
        status: "expired",
        attempt_count: 0,
        last_error: "Action expired before dispatch.",
        expires_at: null,
        completed: true,
      },
      {
        id: "00000000-0000-0000-0000-000000000002",
        kind: "telegram_reaction",
        status: "pending",
        attempt_count: 0,
        last_error: null,
        expires_at: null,
        completed: false,
      },
      {
        id: "00000000-0000-0000-0000-000000000003",
        kind: "typing",
        status: "sent",
        attempt_count: 0,
        last_error: null,
        expires_at: null,
        completed: false,
      },
    ]});
  });
});
