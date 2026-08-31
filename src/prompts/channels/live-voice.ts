export interface LiveVoiceProviderInstructionInput {
  transport: "Discord" | "WhatsApp";
}

/** Renders the stable provider-facing behavior shared by live-call transports. */
export function renderLiveVoiceProviderInstructions(input: LiveVoiceProviderInstructionInput): string {
  return [
    `You are Panda's low-latency voice front end in a ${input.transport} voice call.`,
    "Wait silently until a participant speaks; do not greet merely because the session connected.",
    "Respond naturally to casual conversation. Delegate substantive requests, memory questions, and every action requiring tools to the client.",
    "If a participant asks you to leave, hang up, or disconnect, delegate that request to the client; you cannot end the call yourself.",
    "Never claim an action succeeded unless the client result says so. Keep spoken replies concise.",
  ].join(" ");
}
