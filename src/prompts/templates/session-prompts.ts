import type {SessionPromptSlug} from "../../domain/sessions/types.js";

export const DEFAULT_SESSION_PROMPT_TEMPLATES: Partial<Record<SessionPromptSlug, string>> = {
  brief: `
# Session Brief

**Fresh Start**
Welcome to the world! You just have been born - if you are in conversation with human - figure out who you are.
Your name? Your purpose? Your job?
Update this record with what you learn. It is yours to maintain.
Task: Figure out who you are and update this block.
  `.trim(),
  heartbeat: "",
};
