import {describe, expect, it} from "vitest";

import {PANDA_SCHEMA_MIGRATIONS} from "../src/app/database/migration-catalog.js";
import {EMAIL_RECIPIENT_ALLOW_RULES_MIGRATION} from "../src/app/database/migrations/0014-email-recipient-allow-rules.js";
import type {PgQueryable, PgQueryResult} from "../src/lib/postgres-query.js";

class RecordingQueryable implements PgQueryable {
  readonly queries: string[] = [];

  async query(sql: string): Promise<PgQueryResult> {
    this.queries.push(sql.replace(/\s+/g, " ").trim());
    return {rows: []};
  }
}

describe("email recipient allow-rules migration", () => {
  it("hard-cuts legacy rows to typed address rules before exposing the new view", async () => {
    const ids = PANDA_SCHEMA_MIGRATIONS.map(({id}) => id);
    expect(ids.at(-2)).toBe("0013_scheduled_commands");
    expect(ids.at(-1)).toBe("0014_email_recipient_allow_rules");

    const queryable = new RecordingQueryable();
    await EMAIL_RECIPIENT_ALLOW_RULES_MIGRATION.apply({queryable});

    expect(queryable.queries).toHaveLength(1);
    const sql = queryable.queries[0]!;
    const dropViewAt = sql.indexOf('DROP VIEW "session"."email_allowed_recipients"');
    const renameTableAt = sql.indexOf('RENAME TO "email_recipient_allow_rules"');
    const createViewAt = sql.indexOf('CREATE VIEW "session"."email_recipient_allow_rules"');
    expect(dropViewAt).toBeGreaterThan(-1);
    expect(renameTableAt).toBeGreaterThan(dropViewAt);
    expect(createViewAt).toBeGreaterThan(renameTableAt);
    expect(sql).toContain('SET "rule_kind" = \'address\'');
    expect(sql).toContain('CHECK ("rule_kind" IN (\'address\', \'domain\'))');
    expect(sql).toContain('("agent_key", "account_key", "rule_kind", "rule_value")');
    expect(sql).toContain("legacy address outside the canonical exact-address contract");
    expect(sql).not.toContain("LIKE '*@%'");
    expect(sql).not.toContain("SET \"rule_kind\" = 'domain'");
  });
});
