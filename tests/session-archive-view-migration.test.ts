import {describe, expect, it} from "vitest";

import {PANDA_SCHEMA_MIGRATIONS} from "../src/app/database/migration-catalog.js";
import {REFRESH_ARCHIVED_SESSION_VIEW_MIGRATION} from "../src/app/database/migrations/0010-refresh-archived-session-view.js";
import type {PgQueryable, PgQueryResult} from "../src/lib/postgres-query.js";

class RecordingQueryable implements PgQueryable {
  readonly queries: string[] = [];

  async query(sql: string): Promise<PgQueryResult> {
    this.queries.push(sql.replace(/\s+/g, " ").trim());
    return {rows: []};
  }
}

describe("session archive readonly view migration", () => {
  it("runs after legacy reconciliation and appends archived_at without changing existing columns", async () => {
    const ids = PANDA_SCHEMA_MIGRATIONS.map(({id}) => id);
    expect(ids.indexOf("0008_legacy_schema_reconciliation")).toBeLessThan(ids.indexOf("0009_archive_session"));
    expect(ids.indexOf("0009_archive_session")).toBeLessThan(ids.indexOf("0010_refresh_archived_session_view"));
    expect(ids.indexOf("0010_refresh_archived_session_view")).toBeLessThan(ids.indexOf("0011_bound_secret_envelopes"));

    const queryable = new RecordingQueryable();
    await REFRESH_ARCHIVED_SESSION_VIEW_MIGRATION.apply({queryable});

    expect(queryable.queries).toHaveLength(1);
    expect(queryable.queries[0]).toContain('CREATE OR REPLACE VIEW "session"."agent_sessions"');
    expect(queryable.queries[0]).toContain("session.updated_at, session.archived_at");
  });
});
