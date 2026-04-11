import type {JsonObject} from "../../kernel/agent/types.js";
import type {WatchEventKind} from "../../domain/watches/types.js";

export function renderWatchEventPrompt(options: {
  title: string;
  eventKind: WatchEventKind;
  summary: string;
  occurredIso: string;
  payload?: JsonObject;
}): string {
  const payloadBlock = options.payload
    ? `\n\n[Watch Payload]\n${JSON.stringify(options.payload, null, 2)}`
    : "";

  return `
[Watch Event] ${options.title}
This is a machine-generated watch event from Panda, not a live human message.
The event has already been detected programmatically.
Decide whether a user-facing notification or follow-up action is useful.
If this thread is attached to an external channel, use outbound only when you intentionally want to notify the user.
If nothing useful should happen, keep it quiet.

Event kind: ${options.eventKind}
Observed at: ${options.occurredIso}
Summary: ${options.summary}${payloadBlock}
`.trim();
}
