export function renderDiscordVoiceDelegation(input: {
  prompt: string;
  connectorKey: string;
  guildId: string;
  channelId: string;
  speakerId?: string;
}): string {
  return [
    "[Discord voice delegation]",
    `Connector: ${input.connectorKey}`,
    `Guild: ${input.guildId}`,
    `Voice channel: ${input.channelId}`,
    `Speaker: ${input.speakerId ?? "unknown"}`,
    "Your final answer will be spoken aloud by the voice bridge. Be concise and conversational.",
    "Do not call discord.send for this answer; returning final assistant text is the delivery mechanism.",
    "",
    input.prompt,
  ].join("\n");
}
