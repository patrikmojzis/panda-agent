import type {Pool} from "pg";

import {isDuplicateObjectError} from "./postgres-errors.js";

export interface PgQueryable {
  query: Pool["query"];
}

export interface IntegrityCheck {
  label: string;
  sql: string;
  values?: readonly unknown[];
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

export async function addConstraint(queryable: PgQueryable, sql: string): Promise<void> {
  try {
    await queryable.query(sql);
  } catch (error) {
    if (isDuplicateObjectError(error)) {
      return;
    }

    throw error;
  }
}

export async function addIndex(queryable: PgQueryable, sql: string): Promise<void> {
  await queryable.query(sql);
}

export async function alterIfSupported(queryable: PgQueryable, sql: string): Promise<boolean> {
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

    if (isDuplicateObjectError(error)) {
      return true;
    }

    throw error;
  }
}
