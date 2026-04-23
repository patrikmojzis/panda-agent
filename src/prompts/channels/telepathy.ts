import {formatMaybeValue} from "./shared.js";

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
device_label: ${formatMaybeValue(options.deviceLabel)}
telepathy_mode: ${options.mode}
frontmost_app: ${formatMaybeValue(options.frontmostApp)}
window_title: ${formatMaybeValue(options.windowTitle)}
trigger: ${formatMaybeValue(options.trigger)}
attachments:
${attachments}
</runtime-channel-context>

${trimmedBody || "[Telepathy context push]"}
`.trim();
}
