export interface ThreadRuntimeTableNames {
  prefix: string;
  threads: string;
  messages: string;
  inputs: string;
  runs: string;
  toolJobs: string;
  bashJobs: string;
}

type RelationSuffixMap = Record<string, string>;

export const RUNTIME_SCHEMA = "runtime";
export const SESSION_SCHEMA = "session";
export const CREATE_RUNTIME_SCHEMA_SQL = `CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(RUNTIME_SCHEMA)};`;
export const CREATE_SESSION_SCHEMA_SQL = `CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(SESSION_SCHEMA)};`;

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

export function buildThreadRuntimeTableNames(): ThreadRuntimeTableNames {
  return buildRuntimeRelationNames({
    threads: "threads",
    messages: "messages",
    inputs: "inputs",
    runs: "runs",
    toolJobs: "tool_jobs",
    bashJobs: "bash_jobs",
  });
}

export function toMillis(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }

  if (value instanceof Date) {
    return value.getTime();
  }

  return new Date(String(value)).getTime();
}

export function toOrderNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }

  return Number(value);
}

export function toJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}
