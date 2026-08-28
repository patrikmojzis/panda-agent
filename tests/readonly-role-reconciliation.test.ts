import {describe, expect, it} from "vitest";

import {reconcileReadonlySessionRole} from "../src/app/database/readonly-role.js";
import type {PgQueryResult, PgQueryable} from "../src/lib/postgres-query.js";

class ReadonlyRoleDatabaseFake implements PgQueryable {
  readonly queries: Array<{sql: string; params: readonly unknown[]}> = [];
  readonly roles = new Set<string>();
  configuredRole: string | null = null;

  async query(sql: string, params: readonly unknown[] = []): Promise<PgQueryResult> {
    const normalized = sql.replace(/\s+/g, " ").trim();
    this.queries.push({sql: normalized, params});
    if (normalized.includes("SELECT configuration_value")) {
      return {rows: this.configuredRole ? [{configuration_value: this.configuredRole}] : []};
    }
    if (normalized.startsWith("SELECT 1 FROM pg_roles")) {
      return {rows: this.roles.has(String(params[0])) ? [{exists: 1}] : []};
    }
    if (normalized.startsWith("INSERT INTO")) {
      this.configuredRole = String(params[1]);
    }
    if (normalized.startsWith("DELETE FROM")) {
      this.configuredRole = null;
    }
    return {rows: []};
  }
}

describe("readonly session role reconciliation", () => {
  it("grants and records the configured role", async () => {
    const database = new ReadonlyRoleDatabaseFake();
    database.roles.add("panda_readonly");

    await reconcileReadonlySessionRole(database, "panda_readonly");

    expect(database.configuredRole).toBe("panda_readonly");
    expect(database.queries.some(({sql}) => sql.includes('GRANT USAGE ON SCHEMA "session" TO "panda_readonly"')))
      .toBe(true);
    const grant = database.queries.find(({sql}) => sql.includes("GRANT SELECT ON"))?.sql;
    expect(grant).toContain('"session"."scheduled_commands"');
    expect(grant).toContain('"session"."scheduled_command_runs"');
    expect(database.queries.some(({sql}) => sql.startsWith("CREATE TABLE"))).toBe(false);
  });

  it("revokes a replaced role before granting the new role", async () => {
    const database = new ReadonlyRoleDatabaseFake();
    database.configuredRole = "old_reader";
    database.roles.add("old_reader");
    database.roles.add("new_reader");

    await reconcileReadonlySessionRole(database, "new_reader");

    const revokeIndex = database.queries.findIndex(({sql}) => sql.includes('FROM "old_reader"'));
    const grantIndex = database.queries.findIndex(({sql}) => sql.includes('TO "new_reader"'));
    expect(revokeIndex).toBeGreaterThanOrEqual(0);
    expect(grantIndex).toBeGreaterThan(revokeIndex);
    expect(database.configuredRole).toBe("new_reader");
  });

  it("revokes and clears a role removed from deployment configuration", async () => {
    const database = new ReadonlyRoleDatabaseFake();
    database.configuredRole = "old_reader";
    database.roles.add("old_reader");

    await reconcileReadonlySessionRole(database, null);

    expect(database.configuredRole).toBeNull();
    expect(database.queries.some(({sql}) => sql.includes('REVOKE USAGE ON SCHEMA "session" FROM "old_reader"')))
      .toBe(true);
  });

  it("fails before recording a role that does not exist", async () => {
    const database = new ReadonlyRoleDatabaseFake();

    await expect(reconcileReadonlySessionRole(database, "missing_reader"))
      .rejects.toThrow("does not exist");
    expect(database.configuredRole).toBeNull();
  });
});
