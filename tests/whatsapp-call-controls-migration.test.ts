import {describe, expect, it} from "vitest";

import {WHATSAPP_CALL_CONTROLS_MIGRATION} from "../src/app/database/migrations/0016-whatsapp-call-controls.js";
import type {PgQueryable, PgQueryResult} from "../src/lib/postgres-query.js";

describe("WhatsApp call-controls migration", () => {
  it("installs constrained transport controls and idempotency", async () => {
    const queries: string[] = [];
    const queryable: PgQueryable = {query: async (sql: string): Promise<PgQueryResult> => { queries.push(sql.replace(/\s+/g, " ").trim()); return {rows: []}; }};
    await WHATSAPP_CALL_CONTROLS_MIGRATION.apply({queryable});
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain('CREATE TABLE "runtime"."whatsapp_call_controls"');
    expect(queries[0]).toContain("CHECK (\"operation\" IN ('send', 'hangup'))");
    expect(queries[0]).toContain('CREATE UNIQUE INDEX "runtime_whatsapp_call_controls_idempotency_idx"');
    expect(queries[0]).toContain('ALTER TABLE "runtime"."live_voice_turns" ADD COLUMN "transport_authorization" JSONB');
  });
});
