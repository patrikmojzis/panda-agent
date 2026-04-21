/**
 * Transcript-visible runtime continuation message for zero-input rerolls.
 *
 * This lives in prompts instead of the coordinator so we can tune the wording
 * without spelunking through the run loop every time autonomy behavior shifts.
 */
export function renderRuntimeAutonomyContext(): string {
  return `
<runtime-autonomy-context>
source: runtime
kind: idle-reroll
new_external_input: no
This is an internal continuation turn.
You are still active.
Take one concrete useful next step if one is obvious.
Private self-chat is allowed here.
Useful actions include checking memory or wiki, reading local context, planing, preparing the next likely answer, or calling a relevant tool.
</runtime-autonomy-context>
`.trim();
}
