export function renderWhatsAppVoiceDelegation(input: {
  prompt: string;
  connectorKey: string;
  callId: string;
  voiceTurnId: string;
  speakerId?: string;
}): string {
  return [
    "[WhatsApp voice delegation]",
    `Connector: ${input.connectorKey}`,
    `Call: ${input.callId}`,
    `Voice turn: ${input.voiceTurnId}`,
    `Speaker: ${input.speakerId ?? "unknown"}`,
    "Only `panda whatsapp call send` delivers your words to this call; ordinary assistant text is not spoken.",
    `For longer work, send brief progress with \`panda whatsapp call send --turn ${input.voiceTurnId} --mode progress --text <message>\`.`,
    `If the participant asked to leave, hang up, or disconnect, run \`panda whatsapp call hangup --turn ${input.voiceTurnId} --call ${input.callId} --connector ${input.connectorKey}\`. A successful hangup completes this voice turn; do not send final voice context afterward.`,
    `For every other request, send the concise answer with \`panda whatsapp call send --turn ${input.voiceTurnId} --mode final --text <message>\`. Do not use \`whatsapp.send\`.`,
    "",
    input.prompt,
  ].join("\n");
}
