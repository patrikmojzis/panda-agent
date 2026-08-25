import {describe, expect, it} from "vitest";

import {ensurePostgresEmailSchema} from "../src/domain/email/postgres-schema.js";

describe("email Postgres schema", () => {
  it("backfills legacy attachment availability before enforcing storage constraints", async () => {
    const queries: string[] = [];
    await ensurePostgresEmailSchema({
      query: async (text: string) => {
        queries.push(text);
        return {rows: text.includes("information_schema.table_constraints") ? [] : [{count: 0}]};
      },
    });

    const sql = queries.join("\n");
    const addStatus = sql.indexOf("ADD COLUMN IF NOT EXISTS storage_status TEXT");
    const migrateStatus = sql.indexOf("SET storage_status = CASE");
    const requireStatus = sql.indexOf("ALTER COLUMN storage_status SET NOT NULL");
    expect(addStatus).toBeGreaterThan(-1);
    expect(migrateStatus).toBeGreaterThan(addStatus);
    expect(requireStatus).toBeGreaterThan(migrateStatus);
    expect(sql).toContain("WHEN local_path IS NOT NULL THEN 'stored'");
    expect(sql).toContain("ELSE COALESCE(storage_reason, 'legacy')");
    expect(sql).toContain("email_attachments_storage_shape_check");
  });
});
