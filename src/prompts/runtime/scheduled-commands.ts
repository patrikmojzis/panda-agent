export function renderScheduledCommandEventPrompt(options: {
  commandId: string;
  runId: string;
  kind: "failure" | "recovery";
  failureCode?: string;
}): string {
  if (options.kind === "recovery") {
    return `
[Mechanical Scheduler Recovery]
Scheduled command ${options.commandId} recovered on run ${options.runId}.
Inspect it with \`panda cron show ${options.commandId}\` or \`panda cron runs ${options.commandId}\` if follow-up is needed.
`.trim();
  }

  return `
[Mechanical Scheduler Failure]
Scheduled command ${options.commandId} failed on run ${options.runId}.
Failure code: ${options.failureCode ?? "command_failed"}
Inspect the bounded, redacted result with \`panda cron runs ${options.commandId}\` and repair or disable the command.
`.trim();
}
