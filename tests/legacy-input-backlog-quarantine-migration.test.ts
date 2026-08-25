import {describe, expect, it} from "vitest";

import {LEGACY_INPUT_BACKLOG_QUARANTINE_MIGRATION} from "../src/app/database/migrations/0009-legacy-input-backlog-quarantine.js";
import type {PgQueryable, PgQueryResult} from "../src/lib/postgres-query.js";

class RecordingQueryable implements PgQueryable {
  readonly queries: string[] = [];

  async query(sql: string): Promise<PgQueryResult> {
    this.queries.push(sql.replace(/\s+/g, " ").trim());
    return {rows: []};
  }
}

describe("legacy input backlog quarantine migration", () => {
  it("archives legacy inter-agent wakes and disarms only the cutover wake", async () => {
    const queryable = new RecordingQueryable();

    await LEGACY_INPUT_BACKLOG_QUARANTINE_MIGRATION.apply({queryable});

    expect(queryable.queries).toHaveLength(1);
    const sql = queryable.queries[0];
    expect(sql).toContain('CREATE TABLE "panda_legacy"."thread_input_cutover_quarantine"');
    expect(sql).toContain("input.\"source\" IN ('subagent', 'a2a', 'worker')");
    expect(sql).toContain("input.\"created_at\" < cutoff.\"applied_at\"");
    expect(sql).toContain("input.\"applied_at\" >= cutoff.\"applied_at\"");
    expect(sql).toContain("archived.\"resolution\" = 'pending_quarantined'");
    expect(sql).toContain('SET "discarded_at" = NOW(), "metadata" = NULL, "message" = NULL');
    expect(sql).toContain('config.\"pending_wake_at\" = cutoff.\"applied_at\"');
    expect(sql).toContain("remaining.\"delivery_mode\" = 'wake'");
    expect(sql).not.toContain("DELETE FROM");
  });
});
