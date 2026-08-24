import {describe, expect, it} from "vitest";

import {
  addConstraint,
  runIntegrityChecksReadOnly,
} from "../src/lib/postgres-integrity.js";
import type {PgClientLike, PgPoolLike, PgQueryResult} from "../src/lib/postgres-query.js";

class IntegrityDatabaseFake implements PgPoolLike {
  readonly queries: Array<{sql: string; params: readonly unknown[]}> = [];
  releaseCount = 0;
  constraintExists = false;
  failingCheck = false;

  private readonly client: PgClientLike = {
    query: (sql, params) => this.query(sql, params),
    release: () => {
      this.releaseCount += 1;
    },
  };

  async connect(): Promise<PgClientLike> {
    return this.client;
  }

  async query(sql: string, params: readonly unknown[] = []): Promise<PgQueryResult> {
    const normalized = sql.replace(/\s+/g, " ").trim();
    this.queries.push({sql: normalized, params});
    if (normalized.includes("FROM information_schema.table_constraints")) {
      return {rows: this.constraintExists ? [{exists: true}] : []};
    }
    if (normalized.startsWith("SELECT COUNT")) {
      return {rows: [{count: this.failingCheck ? 1 : 0}]};
    }
    return {rows: []};
  }
}

describe("Postgres integrity helpers", () => {
  it("checks for a named constraint before issuing transaction-sensitive DDL", async () => {
    const database = new IntegrityDatabaseFake();
    database.constraintExists = true;

    await addConstraint(database, `
      ALTER TABLE "runtime"."messages"
      ADD CONSTRAINT "runtime_messages_run_fk"
      FOREIGN KEY (run_id) REFERENCES "runtime"."runs"(id)
    `);

    expect(database.queries.some(({sql}) => sql.includes("FROM information_schema.table_constraints"))).toBe(true);
    expect(database.queries.some(({sql}) => sql.startsWith("ALTER TABLE"))).toBe(false);
  });

  it("runs explicit checks in a read-only transaction", async () => {
    const database = new IntegrityDatabaseFake();

    const result = await runIntegrityChecksReadOnly(database, [{
      scope: "Runtime schema",
      checks: [
        {label: "first", sql: "SELECT COUNT(*)::INTEGER AS count FROM first_table"},
        {label: "second", sql: "SELECT COUNT(*)::INTEGER AS count FROM second_table"},
      ],
    }]);

    expect(result).toEqual({checked: 2});
    expect(database.queries[0]?.sql).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(database.queries.at(-1)?.sql).toBe("COMMIT");
    expect(database.releaseCount).toBe(1);
  });

  it("rolls back a failed integrity check", async () => {
    const database = new IntegrityDatabaseFake();
    database.failingCheck = true;

    await expect(runIntegrityChecksReadOnly(database, [{
      scope: "Runtime schema",
      checks: [{label: "orphaned row", sql: "SELECT COUNT(*)::INTEGER AS count FROM broken_table"}],
    }])).rejects.toThrow("orphaned row (1 row)");

    expect(database.queries.at(-1)?.sql).toBe("ROLLBACK");
    expect(database.releaseCount).toBe(1);
  });
});
