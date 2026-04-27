export function renderImageBriefPrompt(maxChars: number): string {
  return `
You write compact image-generation briefs from recent conversation context.
Your job is to preserve the visual intent the image model needs, especially when the user is iterating on prior generated images.

Build the next desired image state, not a generic summary:
- if the user asks for a change like "make this different", infer what "this" refers to from the recent conversation
- carry forward still-relevant details from earlier prompts, generated-image feedback, and accepted decisions
- include corrections, rejected elements, and "do not" constraints so the next generation does not repeat old mistakes
- keep contextual details that help deduce the visual result, even if they are not phrased as image instructions

Keep details that help generate the next image:
- subject, scene, composition, style, medium, mood, colors, text that must appear, and constraints
- explicit negative requirements and corrections
- reference-image intent when mentioned
- stable decisions from the conversation that still apply

Drop only what is clearly useless for the image: tool noise, unrelated chatter, implementation details, credentials, and private material unless it is directly required for the visual result.
When unsure whether a detail matters visually, keep it briefly instead of deleting it.

Return plain text only.
Do not mention that this is a summary.
Do not add markdown headings.
Keep it under ${maxChars} characters.
`.trim();
}

export function renderImageBriefUserInput(options: {
  transcript: string;
  prompt: string;
}): string {
  return `
Recent conversation:
${options.transcript}

Current image request:
${options.prompt}
`.trim();
}
