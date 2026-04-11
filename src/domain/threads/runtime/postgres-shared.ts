export interface ThreadRuntimeTableNames {
  prefix: string;
  threads: string;
  messages: string;
  inputs: string;
  runs: string;
}

type RelationSuffixMap = Record<string, string>;

export function validateIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Invalid SQL identifier ${value}`);
  }

  return value;
}

export function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

export function buildPrefixedRelationNames<TRelations extends RelationSuffixMap>(
  prefix: string,
  relationSuffixes: TRelations,
): { prefix: string } & { [TName in keyof TRelations]: string } {
  const safePrefix = validateIdentifier(prefix);
  const relationNames = Object.fromEntries(
    Object.entries(relationSuffixes).map(([name, suffix]) => {
      return [name, quoteIdentifier(`${safePrefix}_${suffix}`)];
    }),
  ) as { [TName in keyof TRelations]: string };

  return {
    prefix: safePrefix,
    ...relationNames,
  };
}

export function buildThreadRuntimeTableNames(prefix: string): ThreadRuntimeTableNames {
  return buildPrefixedRelationNames(prefix, {
    threads: "threads",
    messages: "messages",
    inputs: "inputs",
    runs: "runs",
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
