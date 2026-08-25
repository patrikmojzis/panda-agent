import {describe, expect, it} from "vitest";

import {THREAD_INPUT_CUTOFFS_MIGRATION} from "../src/app/database/migrations/0006-thread-input-cutoffs.js";
import type {PgQueryable, PgQueryResult} from "../src/lib/postgres-query.js";

class RecordingQueryable implements PgQueryable {
  readonly queries: string[] = [];

  async query(sql: string): Promise<PgQueryResult> {
    this.queries.push(sql.replace(/\s+/g, " ").trim());
    return {rows: []};
  }
}

describe("thread input cutoff migration", () => {
  it("discards unresolved internal handoffs before arming pending wakes", async () => {
    const queryable = new RecordingQueryable();

    await THREAD_INPUT_CUTOFFS_MIGRATION.apply({queryable});

    expect(queryable.queries).toHaveLength(1);
    const sql = queryable.queries[0];
    const discardAt = sql.indexOf('UPDATE "runtime"."inputs" SET "discarded_at" = NOW()');
    const armAt = sql.indexOf('INSERT INTO "runtime"."session_runtime_config"');
    expect(discardAt).toBeGreaterThan(-1);
    expect(armAt).toBeGreaterThan(discardAt);
    expect(sql).toContain("\"source\" IN ('subagent', 'a2a', 'worker', 'background_tool')");
    expect(sql).toContain('"metadata" = NULL, "message" = NULL');
    expect(sql).toContain('AND "discarded_at" IS NULL');
    expect(sql).not.toContain("'telegram'");
  });
});
