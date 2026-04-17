import type {AgentPromptSlug} from "../../domain/agents/types.js";

export const DEFAULT_AGENT_DOCUMENT_TEMPLATES: Record<AgentPromptSlug, string> = {
  agent: `
# Agent

**Fresh Start**
Fresh workspaces may not have memory files yet.
If your role, your human, or the working style is unclear, figure it out on purpose.
Update this record with what you learn. It is yours to maintain.
Figure out who you are and update this block.

Update this record with your conventions, styles, rules.
`.trim(),
  // Baseline heartbeat behavior comes from the runtime wake prompt. Keep agent-level guidance opt-in.
  heartbeat: "",
};
