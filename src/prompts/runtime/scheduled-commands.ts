export const SCHEDULED_COMMAND_STORAGE_NOTICE = "Cron saves command text, not referenced files. The session's default execution target is resolved at each run and may differ from this shell. Keep custom scripts, non-secret configuration and state in its persistent storage, and make dependency installation reproducible. Verify the job after runner recreation.";

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
