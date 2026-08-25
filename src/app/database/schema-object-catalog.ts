import type {PgPoolLike, PgQueryable} from "../../lib/postgres-query.js";
import {
  PANDA_EXPECTED_COLUMNS,
  PANDA_EXPECTED_CONSTRAINTS,
  PANDA_EXPECTED_RELATIONS,
} from "./schema-object-manifest.js";

export type PandaSchemaRelationTuple = readonly [string, string, string, string];
export type PandaSchemaConstraintTuple = readonly [string, string, string, string, string];
export type PandaSchemaColumnTuple = readonly [string, string, string, string, string, string, string, string, string];

export interface PandaSchemaObjectCatalog {
  relations: readonly PandaSchemaRelationTuple[];
  constraints: readonly PandaSchemaConstraintTuple[];
  columns: readonly PandaSchemaColumnTuple[];
}

function requireString(row: unknown, key: string): string {
  if (!row || typeof row !== "object") {
    throw new Error(`Postgres schema catalog returned an invalid ${key} value.`);
  }
  const value = (row as Record<string, unknown>)[key];
  if (typeof value !== "string") {
    throw new Error(`Postgres schema catalog returned an invalid ${key} value.`);
  }
  return value;
}

async function queryPandaSchemaObjectCatalog(queryable: PgQueryable): Promise<PandaSchemaObjectCatalog> {
  const relations = await queryable.query(`
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
  // PostgreSQL 18 exposes NOT NULL as history-dependent constraint rows.
  // Nullability is already represented exactly in the column catalog.
  const constraints = await queryable.query(`
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
  const columns = await queryable.query(`
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

  return {
    relations: relations.rows.map((row) => [
      requireString(row, "schema_name"),
      requireString(row, "object_name"),
      requireString(row, "object_kind"),
      requireString(row, "definition_hash"),
    ]),
    constraints: constraints.rows.map((row) => [
      requireString(row, "schema_name"),
      requireString(row, "table_name"),
      requireString(row, "constraint_name"),
      requireString(row, "constraint_kind"),
      requireString(row, "definition_hash"),
    ]),
    columns: columns.rows.map((row) => [
      requireString(row, "schema_name"),
      requireString(row, "relation_name"),
      requireString(row, "column_name"),
      requireString(row, "data_type"),
      requireString(row, "not_null"),
      requireString(row, "default_hash"),
      requireString(row, "identity_kind"),
      requireString(row, "generated_kind"),
      requireString(row, "collation_name"),
    ]),
  };
}

/** Reads a deterministic catalog snapshot without inheriting the operator's display timezone. */
export async function readPandaSchemaObjectCatalog(pool: PgPoolLike): Promise<PandaSchemaObjectCatalog> {
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    transactionOpen = true;
    // pg_get_expr renders TIMESTAMPTZ constants in the session timezone. UTC
    // makes fingerprints portable without changing Panda's runtime timezone.
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    const catalog = await queryPandaSchemaObjectCatalog(client);
    await client.query("COMMIT");
    transactionOpen = false;
    return catalog;
  } finally {
    try {
      if (transactionOpen) await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
}

function collectTupleMismatches(
  label: string,
  keyLength: number,
  expectedTuples: readonly (readonly string[])[],
  actualTuples: readonly (readonly string[])[],
): string[] {
  const tupleKey = (tuple: readonly string[]): string => tuple.slice(0, keyLength).join("\u0000");
  const displayKey = (tuple: readonly string[]): string => tuple.slice(0, keyLength).join(".");
  const expectedByKey = new Map(expectedTuples.map((tuple) => [tupleKey(tuple), tuple]));
  const actualByKey = new Map(actualTuples.map((tuple) => [tupleKey(tuple), tuple]));
  const mismatches: string[] = [];

  for (const expected of expectedTuples) {
    const actual = actualByKey.get(tupleKey(expected));
    if (!actual) {
      mismatches.push(`missing ${label} ${displayKey(expected)}`);
    } else if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      mismatches.push(`changed ${label} ${displayKey(expected)}`);
    }
  }
  for (const actual of actualTuples) {
    if (!expectedByKey.has(tupleKey(actual))) {
      mismatches.push(`unexpected ${label} ${displayKey(actual)}`);
    }
  }
  return mismatches;
}

export function listPandaSchemaObjectMismatches(catalog: PandaSchemaObjectCatalog): string[] {
  return [
    ...collectTupleMismatches("relation", 2, PANDA_EXPECTED_RELATIONS, catalog.relations),
    ...collectTupleMismatches("constraint", 3, PANDA_EXPECTED_CONSTRAINTS, catalog.constraints),
    ...collectTupleMismatches("column", 3, PANDA_EXPECTED_COLUMNS, catalog.columns),
  ];
}

export async function assertPandaSchemaObjectManifest(pool: PgPoolLike): Promise<void> {
  const mismatches = listPandaSchemaObjectMismatches(await readPandaSchemaObjectCatalog(pool));
  if (mismatches.length === 0) return;

  const shown = mismatches.slice(0, 10);
  const omitted = mismatches.length - shown.length;
  const suffix = omitted > 0 ? `; ${omitted} more` : "";
  throw new Error(
    `Postgres schema objects integrity preflight failed: schema manifest differs `
    + `(${mismatches.length} mismatch${mismatches.length === 1 ? "" : "es"}): ${shown.join("; ")}${suffix}.`,
  );
}
