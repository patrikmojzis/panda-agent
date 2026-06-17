export function renderBashTargetsContext(aliases: readonly string[]): string {
  const targets = ["default", ...aliases].join(", ");
  return `Available bash targets: ${targets}`;
}
