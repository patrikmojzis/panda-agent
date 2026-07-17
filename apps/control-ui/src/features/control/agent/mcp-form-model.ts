export function formatMcpArgs(args: readonly string[]): string {
  return JSON.stringify(args, null, 2)
}

export function parseMcpArgs(value: string): string[] {
  const parsed = JSON.parse(value) as unknown
  if (
    !Array.isArray(parsed) ||
    parsed.some((entry) => typeof entry !== "string")
  ) {
    throw new Error("Arguments must be a JSON array of strings.")
  }
  return parsed
}
