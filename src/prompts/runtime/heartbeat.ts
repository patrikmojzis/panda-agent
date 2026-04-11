export function renderHeartbeatPrompt(options: {
  scheduledIso: string;
  guidance?: string | null;
}): string {
  const heartbeatGuidance = options.guidance?.trim();
  return `
[Heartbeat]
This is a periodic wake from Panda.
Review pending promises, reminders, and unfinished follow-ups.${heartbeatGuidance ? `

[Heartbeat Guidance]
${heartbeatGuidance}` : ""}

Do not invent stale work.
Only use outbound if you intentionally want to reach the user.
If nothing needs attention, keep it quiet and move on.
Scheduled fire time: ${options.scheduledIso}
`.trim();
}
