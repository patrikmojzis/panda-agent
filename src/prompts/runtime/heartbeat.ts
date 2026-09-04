import {truncateText} from "../../lib/strings.js";

export function renderHeartbeatPrompt(options: {
  scheduledIso: string;
  everyMinutes: number;
  scheduledLocalDateTime?: string;
  timeZone?: string;
  guidance?: string | null;
  lastChangeReason?: string;
  canConfigureCadence?: boolean;
}): string {
  const heartbeatGuidance = options.guidance?.trim();
  const lastChangeReason = options.lastChangeReason?.trim();
  const cadence = [
    `Current heartbeat interval: ${options.everyMinutes} minutes.`,
    lastChangeReason ? `Last cadence change reason: ${JSON.stringify(truncateText(lastChangeReason, 500))}` : "",
    options.canConfigureCadence ? "Adjust your heartbeat interval with `panda heartbeat set` when the pace of useful work changes. See `--help` for usage." : "",
  ].filter(Boolean).join("\n");
  return `
💗 This is a periodic system heartbeat wake.

Review open loops, pending follow-ups, recent conversation momentum, or memory candidates. If one concrete action is obvious, do it.

${cadence}
${heartbeatGuidance ? `
Heartbeat prompt:
${heartbeatGuidance}` : ""}

Clock:
${options.scheduledLocalDateTime ? ` - Local ${options.timeZone ? options.timeZone : ''}: ${options.scheduledLocalDateTime}` : ""}
 - ISO UTC: ${options.scheduledIso}
`.trim();
}
