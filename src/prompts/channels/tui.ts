function formatMaybeValue(value: string | undefined): string {
  return value?.trim() || "null";
}

export function renderTuiInboundText(options: {
  actorId: string;
  externalMessageId: string;
  identityId?: string;
  identityHandle?: string;
  body: string;
}): string {
  const trimmedBody = options.body.trim();
  return `
<runtime-input-context>
source: tui
actor_id: ${options.actorId}
external_message_id: ${options.externalMessageId}
identity_id: ${formatMaybeValue(options.identityId)}
identity_handle: ${formatMaybeValue(options.identityHandle)}
</runtime-input-context>

${trimmedBody || "[Terminal message]"}
`.trim();
}
