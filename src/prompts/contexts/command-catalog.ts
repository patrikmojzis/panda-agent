export interface RenderCommandCatalogContextCommand {
  name: string;
  summary: string;
  usage: string;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function renderGroup(group: string, commands: readonly RenderCommandCatalogContextCommand[]): string {
  const lines = commands.map((command) => (
    `  - \`${normalizeText(command.usage)}\`: ${normalizeText(command.summary)}`
  ));

  return [`- ${group}:`, ...lines].join("\n");
}

function readUsageGroup(command: RenderCommandCatalogContextCommand): string {
  const usage = normalizeText(command.usage);
  const [, group] = usage.match(/^panda\s+(\S+)/) ?? [];
  if (group) {
    return group;
  }

  return command.name.split(".")[0] || command.name;
}

export function renderCommandCatalogContext(commands: readonly RenderCommandCatalogContextCommand[]): string {
  const byGroup = new Map<string, RenderCommandCatalogContextCommand[]>();
  for (const command of commands) {
    const group = readUsageGroup(command);
    byGroup.set(group, [...(byGroup.get(group) ?? []), command]);
  }

  return [
    "Use `bash` for shell work. Inside dockerized workspaces, use the tiny `panda` CLI for Panda runtime capabilities.",
    "Discovery:",
    "- `panda commands` lists command keys allowed by the current session token.",
    "- `panda commands --output json` returns the full machine-readable catalog; invoke commands with the spaced CLI paths shown below and in help.",
    "- `panda <group> <action> --help` shows exact args and examples.",
    "Input/output:",
    "- Prefer `--json @-` for generated JSON or `--json @file` for saved payloads.",
    "- Treat command results as JSON contracts unless command help says otherwise.",
    "Available command groups:",
    ...[...byGroup.entries()].map(([group, groupCommands]) => renderGroup(group, groupCommands)),
    "Direct native tools remain: bash, background_job_status, background_job_wait, background_job_cancel, view_media, thinking_set.",
  ].join("\n");
}
