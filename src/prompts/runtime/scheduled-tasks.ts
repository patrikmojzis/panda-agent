export function renderScheduledTaskPrompt(options: {
  title: string;
  instruction: string;
  scheduledIso: string;
}): string {
  return `
[Scheduled Task]
This is scheduled trigger from your past self.
Scheduled time: ${options.scheduledIso}

---

${options.title}
${options.instruction}
`.trim();
}
