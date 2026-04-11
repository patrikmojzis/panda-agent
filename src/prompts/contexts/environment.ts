export function renderEnvironmentContext(options: {
  username: string;
  hostname: string;
  osLabel: string;
  hardware: string;
  runtime: string;
  workspace: string;
}): string {
  return `
User: ${options.username} @ ${options.hostname}
OS: ${options.osLabel}
Hardware: ${options.hardware}
Runtime: ${options.runtime}
Workspace: ${options.workspace}
`.trim();
}
