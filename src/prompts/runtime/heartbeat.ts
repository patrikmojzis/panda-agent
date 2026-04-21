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
Treat it as reclaimed time, not a ceremonial ping.
Review open loops, promises, pending follow-ups, scheduled work, recent conversation momentum, and memory candidates.
If one concrete useful action is obvious, do it.
Assistant replies here are private scratchpad. If a human should actually be notified now, use outbound intentionally.
${heartbeatGuidance ? `

**Heartbeat Guidance**
${heartbeatGuidance}` : ""}

Canonical time hint for this wake:
${options.scheduledLocalDateTime ? `Scheduled fire time (local): ${options.scheduledLocalDateTime}` : ""}
${options.timeZone ? `Timezone: ${options.timeZone}` : ""}
Scheduled fire time (ISO UTC): ${options.scheduledIso}
`.trim();
}
