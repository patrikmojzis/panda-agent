import {describe, expect, it} from "vitest";

import {LEGACY_SCHEMA_RECONCILIATION_MIGRATION} from "../src/app/database/migrations/0008-legacy-schema-reconciliation.js";
import type {PgQueryable, PgQueryResult} from "../src/lib/postgres-query.js";

class RecordingQueryable implements PgQueryable {
  readonly queries: string[] = [];

  async query(sql: string): Promise<PgQueryResult> {
    this.queries.push(sql.replace(/\s+/g, " ").trim());
    return {rows: []};
  }
}

describe("legacy schema reconciliation migration", () => {
  it("archives retired data and recreates history-independent readonly views", async () => {
    const queryable = new RecordingQueryable();

    await LEGACY_SCHEMA_RECONCILIATION_MIGRATION.apply({queryable});

    expect(queryable.queries).toHaveLength(2);
    expect(queryable.queries[0]).toContain("CREATE SCHEMA IF NOT EXISTS \"panda_legacy\"");
    expect(queryable.queries[0]).toContain("ALTER TABLE runtime.%I SET SCHEMA panda_legacy");
    expect(queryable.queries[0]).toContain("RENAME TO \"session_routes_id_seq\"");
    expect(queryable.queries[0]).toContain("RENAME CONSTRAINT \"threads_session_id_fkey\" TO \"runtime_threads_session_fk\"");
    expect(queryable.queries[0]).toContain("ALTER COLUMN \"every_minutes\" SET DEFAULT 60");
    expect(queryable.queries[1]).toContain("CREATE VIEW \"session\".\"agent_sessions\"");
    expect(queryable.queries[1]).not.toContain("SELECT *");
  });
});
