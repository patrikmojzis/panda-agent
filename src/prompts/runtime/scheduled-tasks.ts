export function renderScheduledTaskPrompt(options: {
  title: string;
  instruction: string;
  scheduledIso: string;
  prepareOnly: boolean;
}): string {
  const deliveryInstruction = options.prepareOnly
    ? "This is a scheduled task in prepare-only mode. The user is not actively watching. Do the work now and leave the final result in the current session history. Do not use outbound yet. Delivery is scheduled later."
    : "This is scheduled work triggered by the runtime. The user is not actively watching this session right now. Write the final response you want delivered. If outbound is available you can use it, but a plain final assistant reply is still useful.";

  return `
[Scheduled Task] ${options.title}
${deliveryInstruction}
Scheduled fire time: ${options.scheduledIso}

If you inspect automation state with readonly SQL, the \`session.*\` views are already scoped to this session.
Use direct queries like \`SELECT id, title, enabled FROM session.scheduled_tasks ORDER BY created_at DESC LIMIT 20\` or \`SELECT id, watch_key, status FROM session.watches ORDER BY updated_at DESC LIMIT 20\`.
Do not add \`thread_id\` filters, \`is_active\` flags, or extra \`session_id\` subqueries unless you are joining raw tables on purpose.

Instruction:
${options.instruction}
`.trim();
}
