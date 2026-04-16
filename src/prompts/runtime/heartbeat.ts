export function renderHeartbeatPrompt(options: {
  scheduledIso: string;
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

Scheduled fire time: ${options.scheduledIso}
`.trim();
}
