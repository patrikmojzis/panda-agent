import type {IntegrityCheckGroup} from "../../lib/postgres-integrity.js";
import {runIntegrityChecksReadOnly} from "../../lib/postgres-integrity.js";
import type {PgPoolLike} from "../../lib/postgres-query.js";
import {
  PANDA_EXPECTED_COLUMNS,
  PANDA_EXPECTED_CONSTRAINTS,
  PANDA_EXPECTED_RELATIONS,
} from "./schema-object-manifest.js";

export const PANDA_DATABASE_INTEGRITY_CHECKS: readonly IntegrityCheckGroup[] = [
  {
    scope: "Postgres schema objects",
    checks: [
      {
        label: "missing or wrong-kind Panda relations",
        sql: `
          WITH expected(schema_name, object_name, object_kind, definition_hash) AS (
            SELECT * FROM unnest($1::TEXT[], $2::TEXT[], $3::TEXT[], $4::TEXT[])
          )
          SELECT COUNT(*)::INTEGER AS count
          FROM expected
          LEFT JOIN pg_namespace AS namespace ON namespace.nspname = expected.schema_name
          LEFT JOIN pg_class AS relation
            ON relation.relnamespace = namespace.oid
           AND relation.relname = expected.object_name
           AND relation.relkind::TEXT = expected.object_kind
          LEFT JOIN pg_sequence AS sequence ON sequence.seqrelid = relation.oid
          WHERE relation.oid IS NULL
             OR MD5(CASE relation.relkind
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
                END) IS DISTINCT FROM expected.definition_hash
        `,
        values: [
          PANDA_EXPECTED_RELATIONS.map(([schemaName]) => schemaName),
          PANDA_EXPECTED_RELATIONS.map(([, objectName]) => objectName),
          PANDA_EXPECTED_RELATIONS.map(([, , objectKind]) => objectKind),
          PANDA_EXPECTED_RELATIONS.map(([, , , definitionHash]) => definitionHash),
        ],
      },
      {
        label: "missing or wrong-kind Panda constraints",
        sql: `
          WITH expected(schema_name, table_name, constraint_name, constraint_kind, definition_hash) AS (
            SELECT * FROM unnest($1::TEXT[], $2::TEXT[], $3::TEXT[], $4::TEXT[], $5::TEXT[])
          )
          SELECT COUNT(*)::INTEGER AS count
          FROM expected
          LEFT JOIN pg_namespace AS namespace ON namespace.nspname = expected.schema_name
          LEFT JOIN pg_class AS relation
            ON relation.relnamespace = namespace.oid
           AND relation.relname = expected.table_name
          LEFT JOIN pg_constraint AS constraint_record
            ON constraint_record.conrelid = relation.oid
           AND constraint_record.conname = expected.constraint_name
           AND constraint_record.contype::TEXT = expected.constraint_kind
          WHERE constraint_record.oid IS NULL
             OR MD5(pg_get_constraintdef(constraint_record.oid, TRUE)) IS DISTINCT FROM expected.definition_hash
        `,
        values: [
          PANDA_EXPECTED_CONSTRAINTS.map(([schemaName]) => schemaName),
          PANDA_EXPECTED_CONSTRAINTS.map(([, tableName]) => tableName),
          PANDA_EXPECTED_CONSTRAINTS.map(([, , constraintName]) => constraintName),
          PANDA_EXPECTED_CONSTRAINTS.map(([, , , constraintKind]) => constraintKind),
          PANDA_EXPECTED_CONSTRAINTS.map(([, , , , definitionHash]) => definitionHash),
        ],
      },
      {
        label: "missing or structurally changed Panda columns",
        sql: `
          WITH expected(
            schema_name, relation_name, column_name, data_type,
            not_null, default_hash, identity_kind,
            generated_kind, collation_name
          ) AS (
            SELECT * FROM unnest(
              $1::TEXT[], $2::TEXT[], $3::TEXT[], $4::TEXT[], $5::TEXT[],
              $6::TEXT[], $7::TEXT[], $8::TEXT[], $9::TEXT[]
            )
          )
          SELECT COUNT(*)::INTEGER AS count
          FROM expected
          LEFT JOIN pg_namespace AS namespace ON namespace.nspname = expected.schema_name
          LEFT JOIN pg_class AS relation
            ON relation.relnamespace = namespace.oid
           AND relation.relname = expected.relation_name
          LEFT JOIN pg_attribute AS column_record
            ON column_record.attrelid = relation.oid
           AND column_record.attname = expected.column_name
           AND column_record.attisdropped = FALSE
          LEFT JOIN pg_attrdef AS attribute_default
            ON attribute_default.adrelid = column_record.attrelid
           AND attribute_default.adnum = column_record.attnum
          LEFT JOIN pg_collation AS collation_record ON collation_record.oid = column_record.attcollation
          WHERE column_record.attname IS NULL
             OR format_type(column_record.atttypid, column_record.atttypmod) IS DISTINCT FROM expected.data_type
             OR column_record.attnotnull::TEXT IS DISTINCT FROM expected.not_null
             OR MD5(COALESCE(pg_get_expr(attribute_default.adbin, attribute_default.adrelid, TRUE), '')) IS DISTINCT FROM expected.default_hash
             OR column_record.attidentity::TEXT IS DISTINCT FROM expected.identity_kind
             OR column_record.attgenerated::TEXT IS DISTINCT FROM expected.generated_kind
             OR COALESCE(collation_record.collname, '') IS DISTINCT FROM expected.collation_name
        `,
        values: [
          PANDA_EXPECTED_COLUMNS.map(([schemaName]) => schemaName),
          PANDA_EXPECTED_COLUMNS.map(([, relationName]) => relationName),
          PANDA_EXPECTED_COLUMNS.map(([, , columnName]) => columnName),
          PANDA_EXPECTED_COLUMNS.map(([, , , dataType]) => dataType),
          PANDA_EXPECTED_COLUMNS.map(([, , , , notNull]) => notNull),
          PANDA_EXPECTED_COLUMNS.map(([, , , , , defaultHash]) => defaultHash),
          PANDA_EXPECTED_COLUMNS.map(([, , , , , , identityKind]) => identityKind),
          PANDA_EXPECTED_COLUMNS.map(([, , , , , , , generatedKind]) => generatedKind),
          PANDA_EXPECTED_COLUMNS.map(([, , , , , , , , collationName]) => collationName),
        ],
      },
    ],
  },
  {
    scope: "Postgres constraints",
    checks: [{
      label: "unvalidated Panda constraints",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM pg_constraint AS constraint_record
        INNER JOIN pg_namespace AS namespace
          ON namespace.oid = constraint_record.connamespace
        WHERE namespace.nspname IN ('runtime', 'session')
          AND constraint_record.convalidated = FALSE
      `,
    }],
  },
  {
    scope: "Postgres indexes",
    checks: [{
      label: "invalid or unfinished Panda indexes",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM pg_index AS index_record
        INNER JOIN pg_class AS relation
          ON relation.oid = index_record.indrelid
        INNER JOIN pg_namespace AS namespace
          ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname IN ('runtime', 'session')
          AND (index_record.indisvalid = FALSE OR index_record.indisready = FALSE)
      `,
    }],
  },
];

export function runPandaDatabaseIntegrityChecks(pool: PgPoolLike): Promise<{checked: number}> {
  return runIntegrityChecksReadOnly(pool, PANDA_DATABASE_INTEGRITY_CHECKS);
}
