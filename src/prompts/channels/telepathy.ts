import {formatMaybeValue} from "./shared.js";

function formatUntrustedValue(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "null";
  }

  return JSON.stringify(trimmed)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

export function renderTelepathyInboundText(options: {
  connectorKey: string;
  sentAt?: string;
  conversationId: string;
  actorId: string;
  externalMessageId: string;
  deviceId: string;
  deviceLabel?: string;
  agentKey: string;
  mode: string;
  frontmostApp?: string;
  windowTitle?: string;
  trigger?: string;
  attachments: readonly string[];
  body?: string;
}): string {
  const attachments = options.attachments.length === 0 ? "- none" : options.attachments.join("\n");
  const trimmedBody = options.body?.trim() ?? "";

  return `
<runtime-channel-context>
channel: telepathy
connector_key: ${options.connectorKey}
conversation_id: ${options.conversationId}
actor_id: ${options.actorId}
external_message_id: ${options.externalMessageId}
sent_at: ${formatMaybeValue(options.sentAt)}
agent_key: ${options.agentKey}
device_id: ${options.deviceId}
metadata_trust: receiver_supplied_untrusted
device_label: ${formatUntrustedValue(options.deviceLabel)}
telepathy_mode: ${formatUntrustedValue(options.mode)}
frontmost_app: ${formatUntrustedValue(options.frontmostApp)}
window_title: ${formatUntrustedValue(options.windowTitle)}
trigger: ${formatUntrustedValue(options.trigger)}
attachments:
${attachments}
</runtime-channel-context>

${trimmedBody || "[Telepathy context push]"}
`.trim();
}
