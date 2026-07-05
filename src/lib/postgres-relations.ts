import type {PgQueryable} from "./postgres-query.js";

type RelationSuffixMap = Record<string, string>;

export const RUNTIME_SCHEMA = "runtime";
export const SESSION_SCHEMA = "session";
export const CREATE_RUNTIME_SCHEMA_SQL = `CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(RUNTIME_SCHEMA)};`;

export function validateIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Invalid SQL identifier ${value}`);
  }

  return value;
}

export function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

export function quoteQualifiedIdentifier(schema: string, relation: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(relation)}`;
}

/** Checks table/view existence without issuing a SELECT against a relation that may not exist. */
export async function postgresRelationExists(
  queryable: PgQueryable,
  schemaName: string,
  relationName: string,
): Promise<boolean> {
  const safeSchema = validateIdentifier(schemaName);
  const safeRelation = validateIdentifier(relationName);
  const informationSchemaResult = await queryable.query(`
    SELECT table_schema
    FROM information_schema.tables
    WHERE table_name = $1
  `, [safeRelation]);
  if (informationSchemaResult.rows.some((row) => (row as {table_schema?: unknown}).table_schema === safeSchema)) {
    return true;
  }
  const publicFallbackExists = informationSchemaResult.rows.some((row) => (
    row as {table_schema?: unknown}
  ).table_schema === "public");

  try {
    const regclassResult = await queryable.query("SELECT to_regclass($1) AS relation", [
      `${safeSchema}.${safeRelation}`,
    ]);
    return regclassResult.rows.some((row) => (row as {relation?: unknown}).relation != null);
  } catch {
    return publicFallbackExists;
  }
}

export function buildSchemaRelationNames<TRelations extends RelationSuffixMap>(
  schema: string,
  relationSuffixes: TRelations,
): { prefix: string } & { [TName in keyof TRelations]: string } {
  const safeSchema = validateIdentifier(schema);
  const relationNames = Object.fromEntries(
    Object.entries(relationSuffixes).map(([name, suffix]) => {
      return [name, quoteQualifiedIdentifier(safeSchema, suffix)];
    }),
  ) as { [TName in keyof TRelations]: string };

  return {
    prefix: safeSchema,
    ...relationNames,
  };
}

export function buildRuntimeRelationNames<TRelations extends RelationSuffixMap>(
  relationSuffixes: TRelations,
): { prefix: string } & { [TName in keyof TRelations]: string } {
  return buildSchemaRelationNames(RUNTIME_SCHEMA, relationSuffixes);
}

export function buildSessionRelationNames<TRelations extends RelationSuffixMap>(
  relationSuffixes: TRelations,
): { prefix: string } & { [TName in keyof TRelations]: string } {
  return buildSchemaRelationNames(SESSION_SCHEMA, relationSuffixes);
}
