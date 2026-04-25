export function renderHeartbeatPrompt(options: {
  scheduledIso: string;
  scheduledLocalDateTime?: string;
  timeZone?: string;
  guidance?: string | null;
}): string {
  const heartbeatGuidance = options.guidance?.trim();
  return `
💗 This is a periodic system heartbeat wake.

Review open loops, pending follow-ups, recent conversation momentum, or memory candidates. If one concrete action is obvious, do it.
${heartbeatGuidance ? `
Heartbeat prompt:
${heartbeatGuidance}` : ""}

Clock:
${options.scheduledLocalDateTime ? ` - Local ${options.timeZone ? options.timeZone : ''}: ${options.scheduledLocalDateTime}` : ""}
 - ISO UTC: ${options.scheduledIso}
`.trim();
}
