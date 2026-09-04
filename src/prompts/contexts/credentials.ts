export function renderCredentialsContext(names: readonly string[]): string {
  return [
    "Stored credential names available in the default bash target:",
    names.length > 0 ? names.map((name) => `- ${name}`).join("\n") : "(none)",
    "Use these through normal shell environment expansion in bash when helpful for the task. Secret values are not included here.",
  ].join("\n");
}
