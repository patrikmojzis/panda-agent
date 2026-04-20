export function renderHeartbeatPrompt(options: {
  scheduledIso: string;
  scheduledLocalDateTime?: string;
  timeZone?: string;
  guidance?: string | null;
}): string {
  const heartbeatGuidance = options.guidance?.trim();
  return `
[Heartbeat]
This is a periodic runtime wake.
Review if something needs attention, otherwise keep it quiet and move on.
Use outbound if you intentionally want to reach the user.${heartbeatGuidance ? `

**Heartbeat Guidance**
${heartbeatGuidance}` : ""}

Canonical time hint for this wake:
${options.scheduledLocalDateTime ? `Scheduled fire time (local): ${options.scheduledLocalDateTime}` : ""}
${options.timeZone ? `Timezone: ${options.timeZone}` : ""}
Scheduled fire time (ISO UTC): ${options.scheduledIso}
`.trim();
}
