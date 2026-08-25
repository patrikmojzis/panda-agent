#!/usr/bin/env tsx
import {writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {createPostgresPool} from "../../src/app/runtime/database.js";
import {looksLikeDisposableDatabaseName, resolveSmokeDatabaseTarget} from "../../src/app/smoke/database.js";
import {createPandaSchemaVerifier} from "../../src/integrations/postgres/schema-version.js";

interface RelationRow {
  schema_name: string;
  object_name: string;
  object_kind: string;
  definition_hash: string;
}

interface ConstraintRow {
  schema_name: string;
  table_name: string;
  constraint_name: string;
  constraint_kind: string;
  definition_hash: string;
}

interface ColumnRow {
  schema_name: string;
  relation_name: string;
  column_name: string;
  data_type: string;
  not_null: string;
  default_hash: string;
  identity_kind: string;
  generated_kind: string;
  collation_name: string;
}

function requireDisposableDatabaseUrl(): string {
  const value = process.env.TEST_DATABASE_URL?.trim();
  if (!value) throw new Error("Schema manifest generation requires TEST_DATABASE_URL.");
  const target = resolveSmokeDatabaseTarget(value);
  if (!looksLikeDisposableDatabaseName(target.databaseName)) {
    throw new Error(`Refusing to generate a schema manifest from non-disposable database ${target.databaseName}.`);
  }
  return value;
}

function tuple(row: readonly string[]): string {
  return `  ${JSON.stringify(row)},`;
}

async function main(): Promise<void> {
  const pool = createPostgresPool({
    connectionString: requireDisposableDatabaseUrl(),
    applicationName: "panda/schema-object-manifest",
    max: 1,
  });
  try {
    await createPandaSchemaVerifier(pool).assertCurrent();
    const relations = await pool.query<RelationRow>(`
      SELECT namespace.nspname AS schema_name,
             relation.relname AS object_name,
             relation.relkind::TEXT AS object_kind,
             MD5(CASE relation.relkind
               WHEN 'i' THEN pg_get_indexdef(relation.oid)
               WHEN 'v' THEN pg_get_viewdef(relation.oid, TRUE)
               WHEN 'm' THEN pg_get_viewdef(relation.oid, TRUE)
               WHEN 'S' THEN CONCAT_WS('|',
                 format_type(sequence.seqtypid, NULL),
                 sequence.seqstart::TEXT,
                 sequence.seqincrement::TEXT,
                 sequence.seqmax::TEXT,
                 sequence.seqmin::TEXT,
                 sequence.seqcache::TEXT,
                 sequence.seqcycle::TEXT
               )
               ELSE ''
             END) AS definition_hash
      FROM pg_class AS relation
      INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      LEFT JOIN pg_sequence AS sequence ON sequence.seqrelid = relation.oid
      WHERE namespace.nspname IN ('runtime', 'session')
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'i')
      ORDER BY namespace.nspname COLLATE "C",
               relation.relkind::TEXT COLLATE "C",
               relation.relname COLLATE "C"
    `);
    // PostgreSQL 18 exposes NOT NULL as pg_constraint rows. Nullability already
    // lives in the column manifest, and constraint names differ by DDL history,
    // so including contype=n would make an equivalent schema non-portable.
    const constraints = await pool.query<ConstraintRow>(`
      SELECT namespace.nspname AS schema_name,
             relation.relname AS table_name,
             constraint_record.conname AS constraint_name,
             constraint_record.contype::TEXT AS constraint_kind,
             MD5(pg_get_constraintdef(constraint_record.oid, TRUE)) AS definition_hash
      FROM pg_constraint AS constraint_record
      INNER JOIN pg_class AS relation ON relation.oid = constraint_record.conrelid
      INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname IN ('runtime', 'session')
        AND constraint_record.contype <> 'n'
      ORDER BY namespace.nspname COLLATE "C",
               relation.relname COLLATE "C",
               constraint_record.conname COLLATE "C"
    `);
    const columns = await pool.query<ColumnRow>(`
      SELECT namespace.nspname AS schema_name,
             relation.relname AS relation_name,
             column_record.attname AS column_name,
             format_type(column_record.atttypid, column_record.atttypmod) AS data_type,
             column_record.attnotnull::TEXT AS not_null,
             MD5(COALESCE(pg_get_expr(attribute_default.adbin, attribute_default.adrelid, TRUE), '')) AS default_hash,
             column_record.attidentity::TEXT AS identity_kind,
             column_record.attgenerated::TEXT AS generated_kind,
             COALESCE(collation_record.collname, '') AS collation_name
      FROM pg_attribute AS column_record
      INNER JOIN pg_class AS relation ON relation.oid = column_record.attrelid
      INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      LEFT JOIN pg_attrdef AS attribute_default
        ON attribute_default.adrelid = column_record.attrelid
       AND attribute_default.adnum = column_record.attnum
      LEFT JOIN pg_collation AS collation_record ON collation_record.oid = column_record.attcollation
      WHERE namespace.nspname IN ('runtime', 'session')
        AND relation.relkind IN ('r', 'p', 'v', 'm')
        AND column_record.attnum > 0
        AND column_record.attisdropped = FALSE
      ORDER BY namespace.nspname COLLATE "C",
               relation.relname COLLATE "C",
               column_record.attname COLLATE "C"
    `);

    const source = [
      "// Generated from a current disposable PostgreSQL database.",
      "// Run `pnpm ci:postgres-schema-manifest:update` after adding a migration.",
      "export const PANDA_EXPECTED_RELATIONS = Object.freeze([",
      ...relations.rows.map((row) => tuple([
        row.schema_name,
        row.object_name,
        row.object_kind,
        row.definition_hash,
      ])),
      "] as const);",
      "",
      "export const PANDA_EXPECTED_CONSTRAINTS = Object.freeze([",
      ...constraints.rows.map((row) => tuple([
        row.schema_name,
        row.table_name,
        row.constraint_name,
        row.constraint_kind,
        row.definition_hash,
      ])),
      "] as const);",
      "",
      "export const PANDA_EXPECTED_COLUMNS = Object.freeze([",
      ...columns.rows.map((row) => tuple([
        row.schema_name,
        row.relation_name,
        row.column_name,
        row.data_type,
        row.not_null,
        row.default_hash,
        row.identity_kind,
        row.generated_kind,
        row.collation_name,
      ])),
      "] as const);",
      "",
    ].join("\n");
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    await writeFile(path.join(repoRoot, "src/app/database/schema-object-manifest.ts"), source, "utf8");
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
