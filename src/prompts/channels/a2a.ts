import {formatMaybeValue} from "./shared.js";

interface A2ASenderEnvironmentPrompt {
  id: string;
  kind: string;
  envDir?: string;
  parentRunnerPaths?: {
    root?: string;
    workspace?: string;
    inbox?: string;
    artifacts?: string;
  };
  workerPaths?: {
    workspace?: string;
    inbox?: string;
    artifacts?: string;
  };
}

export function renderA2AInboundText(options: {
  connectorKey: string;
  conversationId: string;
  actorId: string;
  messageId: string;
  sentAt?: string;
  fromAgentKey: string;
  fromSessionId: string;
  senderEnvironment?: A2ASenderEnvironmentPrompt;
  attachments: readonly string[];
  body: string;
}): string {
  const attachments = options.attachments.length === 0 ? "- none" : options.attachments.join("\n");
  const trimmedBody = options.body.trim();
  const senderEnvironment = renderSenderEnvironment(options.senderEnvironment);
  const contextLines = [
    "channel: a2a",
    `connector_key: ${options.connectorKey}`,
    `conversation_id: ${options.conversationId}`,
    `actor_id: ${options.actorId}`,
    `message_id: ${options.messageId}`,
    `sent_at: ${formatMaybeValue(options.sentAt)}`,
    `from_agent_key: ${options.fromAgentKey}`,
    `from_session_id: ${options.fromSessionId}`,
    ...(senderEnvironment ? senderEnvironment.split("\n") : []),
    "attachments:",
    attachments,
  ].join("\n");

  return `
<runtime-channel-context>
${contextLines}
</runtime-channel-context>

${trimmedBody || "[A2A message]"}
`.trim();
}

function renderSenderEnvironment(environment: A2ASenderEnvironmentPrompt | undefined): string {
  if (!environment) {
    return "";
  }

  const parentRunnerPaths = environment.parentRunnerPaths;
  const workerPaths = environment.workerPaths;
  return [
    "sender_environment:",
    `- id: ${environment.id}`,
    `- kind: ${environment.kind}`,
    `- env_dir: ${formatMaybeValue(environment.envDir)}`,
    `- parent_root_path: ${formatMaybeValue(parentRunnerPaths?.root)}`,
    `- parent_workspace_path: ${formatMaybeValue(parentRunnerPaths?.workspace)}`,
    `- parent_inbox_path: ${formatMaybeValue(parentRunnerPaths?.inbox)}`,
    `- parent_artifacts_path: ${formatMaybeValue(parentRunnerPaths?.artifacts)}`,
    `- worker_workspace_path: ${formatMaybeValue(workerPaths?.workspace)}`,
    `- worker_inbox_path: ${formatMaybeValue(workerPaths?.inbox)}`,
    `- worker_artifacts_path: ${formatMaybeValue(workerPaths?.artifacts)}`,
  ].join("\n");
}

export function renderA2AInboundFallbackBody(options: {
  textBlocks: readonly string[];
}): string {
  const blocks = options.textBlocks
    .map((block) => block.trim())
    .filter((block) => block.length > 0);

  if (blocks.length === 0) {
    return "[A2A message]";
  }

  return blocks.join("\n\n");
}

export function renderA2AAttachmentCaption(caption: string | undefined): string {
  return `caption: ${formatMaybeValue(caption)}`;
}
