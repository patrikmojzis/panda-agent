export interface ThreadRuntimeRelationNames {
  threads: string;
  messages: string;
  inputs: string;
  runs: string;
}

export interface ThreadRuntimeTableNames extends ThreadRuntimeRelationNames {
  prefix: string;
}

export function validateIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Invalid SQL identifier ${value}`);
  }

  return value;
}

export function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

function buildQuotedThreadRuntimeRelationNames(prefix: string): ThreadRuntimeRelationNames {
  return {
    threads: quoteIdentifier(`${prefix}_threads`),
    messages: quoteIdentifier(`${prefix}_messages`),
    inputs: quoteIdentifier(`${prefix}_inputs`),
    runs: quoteIdentifier(`${prefix}_runs`),
  };
}

export function buildThreadRuntimeTableNames(prefix: string): ThreadRuntimeTableNames {
  const safePrefix = validateIdentifier(prefix);
  return {
    prefix: safePrefix,
    ...buildQuotedThreadRuntimeRelationNames(safePrefix),
  };
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
