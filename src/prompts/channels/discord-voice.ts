export function renderDiscordVoiceDelegation(input: {
  prompt: string;
  connectorKey: string;
  guildId: string;
  channelId: string;
  voiceTurnId: string;
  speakerId?: string;
}): string {
  return [
    "[Discord voice delegation]",
    `Connector: ${input.connectorKey}`,
    `Guild: ${input.guildId}`,
    `Voice channel: ${input.channelId}`,
    `Voice turn: ${input.voiceTurnId}`,
    `Speaker: ${input.speakerId ?? "unknown"}`,
    "Only `panda discord voice send` delivers your words to this voice conversation; ordinary assistant text is not spoken.",
    `For longer work, send brief progress with \`panda discord voice send --turn ${input.voiceTurnId} --mode progress --text <message>\`.`,
    `When done, send the concise answer with \`panda discord voice send --turn ${input.voiceTurnId} --mode final --text <message>\`. Do not use \`discord.send\`.`,
    "",
    input.prompt,
  ].join("\n");
}
