export interface StringifyUnknownOptions {
  pretty?: boolean;
  preferErrorMessage?: boolean;
}

export function stringifyUnknown(
  value: unknown,
  options: StringifyUnknownOptions = {},
): string {
  if (options.preferErrorMessage && value instanceof Error) {
    return value.message;
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, options.pretty ? 2 : undefined);
  } catch {
    return String(value);
  }
}
