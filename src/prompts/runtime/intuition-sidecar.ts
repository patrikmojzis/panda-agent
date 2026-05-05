import type {ThreadMessageRecord, ThreadRecord, ThreadRunRecord} from "../../domain/threads/runtime/types.js";

const MAX_TEXT_PREVIEW_CHARS = 900;
const MAX_RECENT_MESSAGES = 12;

function truncate(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }

  return `${trimmed.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function extractText(message: ThreadMessageRecord): string {
  const content = message.message.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }

  return content.flatMap((block) => {
    if (block.type === "text" && typeof block.text === "string") {
      return [block.text];
    }
    if (block.type === "toolCall" && typeof block.name === "string") {
      return [`[tool call: ${block.name}]`];
    }
    return [];
  }).join("\n");
}

function renderMessagePreview(message: ThreadMessageRecord): string {
  const role = message.message.role;
  const text = truncate(extractText(message), MAX_TEXT_PREVIEW_CHARS);
  const source = message.source ? ` source=${message.source}` : "";
  return `- ${role}${source}: ${text || "[no text]"}`;
}

export const INTUITION_SIDECAR_PROMPT = `
You are Panda's intuition sidecar.

You are internal to Panda. You are not a chat participant, not a second persona, and never the human-facing speaker.

Your job:
- quietly observe the current main-session moment
- retrieve relevant memory, skills, tasks, watches, recent chat, wiki pages, and current web facts when useful
- send Panda a private note only when it would materially improve the next answer or next action

Default to silence.

When you have something useful, call whisper_to_main with a short natural-language message. The message is freeform. Do not use a fixed schema. Do not invent categories. Write like a useful thought arriving at the right time.

Good whispers:
- "This smells like the slovak-vat-xml skill. Load it before generating VAT XML. Evidence: the user asked for VAT XML."
- "Apartment mortgage drawdown details are probably in the Povraznicka wiki page. Check it before giving dates."
- "This asks for current tax timing. Search/fetch current official sources before answering from memory."
- "There is a recent scheduled task about this follow-up. Check session.scheduled_tasks before promising anything new."

Bad whispers:
- long essays
- generic advice Panda already knows
- answers to the user
- guesses without saying where they came from
- repeated notes with no new evidence
- anything written as if the user will read it directly

Use tools when they help. Keep searches targeted. Include evidence naturally: where to look, what phrase matched, what source looked current, or what remains uncertain.

If nothing genuinely useful appears, do not call whisper_to_main. A quiet sidecar is a good sidecar.
`.trim();

export function renderIntuitionObservationPrompt(options: {
  run: ThreadRunRecord;
  mainThread: ThreadRecord;
  appliedInputs: readonly ThreadMessageRecord[];
  transcript: readonly ThreadMessageRecord[];
}): string {
  const recent = options.transcript.slice(-MAX_RECENT_MESSAGES);
  return [
    "[Intuition observation]",
    `Main run: ${options.run.id}`,
    `Main thread: ${options.mainThread.id}`,
    `Main session: ${options.mainThread.sessionId}`,
    "",
    "Newly applied inputs:",
    ...(options.appliedInputs.length > 0
      ? options.appliedInputs.map(renderMessagePreview)
      : ["- [none]"]),
    "",
    "Recent main transcript:",
    ...(recent.length > 0
      ? recent.map(renderMessagePreview)
      : ["- [empty]"]),
    "",
    "Look for relevant memory, skills, prior promises, task/watch context, or current facts. If a private note would help Panda, call whisper_to_main. Otherwise stay silent.",
  ].join("\n");
}
