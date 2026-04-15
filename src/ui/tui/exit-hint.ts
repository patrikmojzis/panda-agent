const RESUME_HINT_LABEL = "Resume this session with:";
const FALLBACK_WIDTH = 80;

export function renderResumeHint(sessionId: string, columns = FALLBACK_WIDTH): string {
  const resolvedWidth = Number.isFinite(columns)
    ? Math.max(RESUME_HINT_LABEL.length + 1, Math.floor(columns))
    : FALLBACK_WIDTH;
  const separator = "─".repeat(Math.max(1, resolvedWidth - RESUME_HINT_LABEL.length));

  return `${RESUME_HINT_LABEL}${separator}\npanda --session ${sessionId}`;
}
