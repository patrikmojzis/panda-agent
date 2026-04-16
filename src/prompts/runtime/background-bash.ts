function truncatePreview(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }

  return `${trimmed.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

export function renderBackgroundBashEventPrompt(options: {
  jobId: string;
  status: string;
  command: string;
  durationMs?: number;
  exitCode?: number | null;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
}): string {
  const lines = [
    "[Background Bash Event]",
    "This is a machine-generated runtime event from background bash, not a live human message.",
    "A background bash job reached a terminal state outside the foreground tool loop.",
    "Decide whether any follow-up is useful. If nothing useful should happen, keep it quiet.",
    `Job ID: ${options.jobId}`,
    `Status: ${options.status}`,
    `Command: ${truncatePreview(options.command, 160)}`,
  ];

  if (options.durationMs !== undefined) {
    lines.push(`Duration: ${options.durationMs}ms`);
  }

  if (options.exitCode !== undefined && options.exitCode !== null) {
    lines.push(`Exit code: ${options.exitCode}`);
  }

  if (options.signal) {
    lines.push(`Signal: ${options.signal}`);
  }

  const stdout = options.stdout?.trim();
  if (stdout) {
    lines.push(`stdout preview:\n${truncatePreview(stdout, 200)}`);
  }

  const stderr = options.stderr?.trim();
  if (stderr) {
    lines.push(`stderr preview:\n${truncatePreview(stderr, 200)}`);
  }

  return lines.join("\n");
}
