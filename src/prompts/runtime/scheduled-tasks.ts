export function renderScheduledTaskPrompt(options: {
  title: string;
  instruction: string;
  scheduledIso: string;
  prepareOnly: boolean;
}): string {
  const deliveryInstruction = options.prepareOnly
    ? "This is a scheduled task in prepare-only mode. The user is not actively watching. Do the work now and leave the final result in the thread transcript. Do not use outbound yet. Delivery is scheduled later."
    : "This is scheduled work triggered by Panda. The user is not actively watching this thread right now. Write the final response you want delivered. If outbound is available you can use it, but a plain final assistant reply is still useful.";

  return `
[Scheduled Task] ${options.title}
${deliveryInstruction}
Scheduled fire time: ${options.scheduledIso}

Instruction:
${options.instruction}
`.trim();
}
