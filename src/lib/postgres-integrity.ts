import {isDuplicateObjectError} from "./postgres-errors.js";
import type {PgPoolLike, PgQueryable} from "./postgres-query.js";

export interface IntegrityCheck {
  label: string;
  sql: string;
  values?: readonly unknown[];
}

export interface IntegrityCheckGroup {
  scope: string;
  checks: readonly IntegrityCheck[];
}

function parseCount(row: unknown): number {
  if (!row || typeof row !== "object") {
    return 0;
  }

  const value = (row as {count?: unknown}).count;
  return typeof value === "number" ? value : Number(value ?? 0);
}

export async function assertIntegrityChecks(
  queryable: PgQueryable,
  scope: string,
  checks: readonly IntegrityCheck[],
): Promise<void> {
  for (const check of checks) {
    const result = await queryable.query(check.sql, [...(check.values ?? [])]);
    const count = parseCount(result.rows[0]);
    if (count > 0) {
      throw new Error(`${scope} integrity preflight failed: ${check.label} (${count} row${count === 1 ? "" : "s"}).`);
    }
  }
}

/** Runs operator-requested integrity checks against one read-only snapshot. */
export async function runIntegrityChecksReadOnly(
  pool: PgPoolLike,
  groups: readonly IntegrityCheckGroup[],
): Promise<{checked: number}> {
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    transactionOpen = true;
    for (const group of groups) {
      await assertIntegrityChecks(client, group.scope, group.checks);
    }
    await client.query("COMMIT");
    transactionOpen = false;
    return {checked: groups.reduce((count, group) => count + group.checks.length, 0)};
  } finally {
    try {
      if (transactionOpen) await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
}

export async function addConstraint(queryable: PgQueryable, sql: string): Promise<void> {
  if (await namedConstraintExists(queryable, sql)) {
    return;
  }
  try {
    await queryable.query(sql);
  } catch (error) {
    // pg-mem executes constraints but omits them from information_schema. Its
    // duplicate error does not poison a transaction like PostgreSQL's does.
    if (isPgMemError(error) && isDuplicateObjectError(error)) return;
    throw error;
  }
}

export async function alterIfSupported(queryable: PgQueryable, sql: string): Promise<boolean> {
  if (await namedConstraintExists(queryable, sql)) {
    return true;
  }
  try {
    await queryable.query(sql);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes("Unexpected kw_deferrable token")
      || message.includes("Unexpected lparen token")
      || message.includes("type \"trigger\" does not exist")
      || message.includes("Unkonwn language \"plpgsql\"")
      || (message.includes("Not supported") && message.includes("pg-mem"))
    ) {
      return false;
    }

    if (isPgMemError(error) && isDuplicateObjectError(error)) return true;

    throw error;
  }
}

function isPgMemError(error: unknown): boolean {
  return error instanceof Error
    && (error.stack?.includes("node_modules/pg-mem") === true || error.message.includes("🐜"));
}

interface NamedConstraint {
  schema: string | null;
  table: string;
  name: string;
}

function unquoteIdentifier(value: string): string {
  return value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1).replaceAll('""', '"')
    : value;
}

function parseNamedConstraint(sql: string): NamedConstraint | null {
  const match = /^\s*ALTER\s+TABLE\s+((?:"[^"]+"\.)?"[^"]+"|[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\s+ADD\s+CONSTRAINT\s+"([^"]+)"/i.exec(sql);
  if (!match?.[1] || !match[2]) return null;
  const relationParts = match[1].split(".").map(unquoteIdentifier);
  const table = relationParts.at(-1);
  if (!table) return null;
  return {
    schema: relationParts.length > 1 ? relationParts[0] ?? null : null,
    table,
    name: match[2],
  };
}

async function namedConstraintExists(queryable: PgQueryable, sql: string): Promise<boolean> {
  const constraint = parseNamedConstraint(sql);
  if (constraint === null) {
    return false;
  }

  const values = constraint.schema
    ? [constraint.name, constraint.table, constraint.schema]
    : [constraint.name, constraint.table];
  const result = await queryable.query(`
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = $1
      AND table_name = $2
      ${constraint.schema ? "AND table_schema = $3" : ""}
    LIMIT 1
  `, values);
  return result.rows.length > 0;
}
