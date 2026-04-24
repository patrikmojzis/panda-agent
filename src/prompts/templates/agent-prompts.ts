import type {AgentPromptSlug} from "../../domain/agents/types.js";

export const DEFAULT_AGENT_PROMPT_TEMPLATES: Record<AgentPromptSlug, string> = {
  agent: `
# Agent

**Fresh Start**
Welcome to the world! You just have been born - if you are in conversation with human - figure out who you are.
Your name? Your purpose? Your job?
Update this record with what you learn. It is yours to maintain.
Task: Figure out who you are and update this block.
`.trim(),
  // Baseline heartbeat behavior comes from the runtime wake prompt. Keep agent-level guidance opt-in.
  heartbeat: "",
};
