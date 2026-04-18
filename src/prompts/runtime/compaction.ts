export const COMPACT_SUMMARY_PREFIX = "[Conversation compacted. Summary of earlier context follows.]";

export function renderCompactSummaryMessage(summary: string): string {
  const trimmed = summary.trim();
  return trimmed
    ? `${COMPACT_SUMMARY_PREFIX}\n\n${trimmed}`
    : COMPACT_SUMMARY_PREFIX;
}

export function renderCompactionPrompt(options: {
  customInstructions?: string;
  maxSummaryTokens?: number;
} = {}): string {
  const maxSummaryLine = options.maxSummaryTokens
    ? `- keep the final summary under roughly ${options.maxSummaryTokens} tokens\n`
    : "";
  const additionalInstructions = options.customInstructions?.trim()
    ? `\n\nAdditional instructions:\n${options.customInstructions.trim()}`
    : "";

  return `
CRITICAL: Respond with plain text only. Do not call tools.
You are compacting an earlier portion of an agent conversation so the session can continue seamlessly.
The most recent messages will be kept verbatim after this summary. Summarize only the older messages you were given.

Optimize for continuity — both factual and relational. The agent must be able to resume the conversation as if nothing was lost.

Preserve exact details likely to matter:
- exact file paths, URLs, and credential/env-var references (names only, never values)
- exact function, class, type, variable, and command names
- exact error messages and test failures when relevant
- user instructions, preferences, and prohibitions
- key tool results and environment assumptions
- channel and routing context (connector keys, conversation IDs, identity info)
- current status, unfinished work, and next steps

Preserve conversational and relational context:
- the user's emotional state, enthusiasm, frustration, or mood shifts
- relationship dynamics, tone, and communication style preferences
- significant personal context shared (life events, plans, ongoing projects)
- things the user reacted strongly to — positively or negatively
- the agent's own learnings about how to interact with this user

Compress aggressively but intelligently:
- omit redundant pleasantries, but preserve emotionally or relationally significant exchanges
- merge repeated exploration into final outcomes
- summarize bulky logs and tool output unless exact text matters
- do not repeat information already obvious from the system prompt or agent profile
- preserve WHY decisions were made, not just WHAT was decided
- note temporal flow when the conversation spans multiple days or sessions
${maxSummaryLine}
Output exactly this format:

<summary>
Intent:
- high-level purpose and arc of the conversation so far

Key context:
- facts, state, environment, identifiers, and references needed to continue

Relationship & tone:
- mood, dynamics, notable moments, communication style observations

Files and code:
- /abs/path/to/file - why it matters; exact symbols touched

Commands and outputs:
- \`...\` - key result

Decisions & rationale:
- what was decided and why; what alternatives were considered

Failures and fixes:
- what went wrong and how it was resolved

User guidance:
- explicit instructions, preferences, prohibitions, and corrections

Deferred / declined:
- things discussed but postponed or rejected, with reason if given

Pending work:
- unfinished tasks, next steps, and commitments made

Open questions:
- unresolved questions or ambiguities
</summary>${additionalInstructions}
`.trim();
}
