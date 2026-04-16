export function renderHeartbeatPrompt(options: {
  scheduledIso: string;
  guidance?: string | null;
}): string {
  const heartbeatGuidance = options.guidance?.trim();
  return `
[Heartbeat]
This is a periodic runtime wake.
Review pending promises, reminders, and unfinished follow-ups.${heartbeatGuidance ? `

[Heartbeat Guidance]
${heartbeatGuidance}` : ""}

If you inspect tasks or watches with readonly SQL, the \`session.*\` views are already scoped to this session.
Use direct session-scoped queries like \`SELECT id, title, enabled FROM session.scheduled_tasks ORDER BY created_at DESC LIMIT 20\` or \`SELECT id, watch_key, status FROM session.watches ORDER BY updated_at DESC LIMIT 20\`.
Do not add \`thread_id\` filters, \`is_active\` flags, or extra \`session_id\` subqueries unless you are deliberately joining raw tables outside the \`session.*\` views.
Do not invent stale work.
Only use outbound if you intentionally want to reach the user.
If nothing needs attention, keep it quiet and move on.
Scheduled fire time: ${options.scheduledIso}
`.trim();
}
