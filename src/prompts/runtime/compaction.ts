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
You are compacting an earlier portion of a coding-assistant conversation so the session can continue in the same repository.
The most recent messages will be kept verbatim after this summary. Summarize only the older messages you were given.
Optimize for continuity, not elegance. Preserve exact details that are likely to matter for continuing the work:
- exact file paths
- exact function, class, type, variable, and command names
- exact error messages and test failures when important
- user instructions, preferences, and prohibitions
- key tool results and environment assumptions
- current status, unfinished work, and next steps
Compress aggressively:
- omit small talk
- merge repeated exploration
- summarize bulky logs unless exact text matters
- do not repeat information that is already obvious
${maxSummaryLine}Output exactly this format:
<summary>
Intent:
- ...

Key context:
- ...

Files and code:
- /abs/path/to/file.ts - why it matters; exact symbols touched

Commands and outputs:
- \`...\` - key result

Failures and fixes:
- ...

User guidance:
- ...

Pending work:
- ...

Open questions:
- ...
</summary>${additionalInstructions}
`.trim();
}
