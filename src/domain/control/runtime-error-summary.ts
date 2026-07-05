const DEFAULT_RUNTIME_ERROR_SUMMARY_MAX_CHARS = 260;

const FAILURE_KIND_PATTERN = /\s*\bfailureKind=[a-z_]+\b\s*/gi;

const UNSAFE_MARKERS = [
  /\b(?:request|response)\s+bod(?:y|ies)\s*[:=]/i,
  /\b(?:raw\s+)?(?:prompt|prompts|transcript|transcripts|context|messages|metadata|headers|body|payload|tool\s*args?|tool\s*arguments?|tool\s*results?|stdout|stderr|db\s+row)\s*[:=]/i,
  /\b(?:authorization|cookie)\s+header\s*[:=]/i,
  /"(?:body|content|context|headers|message|messages|metadata|payload|prompt|prompts|request|response|stderr|stdout|tool[_ -]?args?|tool[_ -]?arguments?|tool[_ -]?results?|transcript|transcripts)"\s*:/i,
];

function messageFromError(error: unknown): string | null {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return null;
}

function stripAnsiAndControls(value: string): string {
  return value
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ");
}

function isStackLine(value: string): boolean {
  return /^at\s+\S+\s+\(?/.test(value) || /^\s*\.\.\.\s+\d+\s+more\s*$/i.test(value);
}

function startsWithUnsafeMarker(value: string): boolean {
  for (const pattern of UNSAFE_MARKERS) {
    pattern.lastIndex = 0;
    const match = pattern.exec(value);
    if (match?.index === 0) return true;
  }
  return false;
}

function isPayloadLine(value: string): boolean {
  return /^[{[]/.test(value) || startsWithUnsafeMarker(value);
}

function leadingSafeText(value: string): string {
  const lines = stripAnsiAndControls(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const kept: string[] = [];
  for (const line of lines) {
    if (isStackLine(line) || isPayloadLine(line)) break;
    kept.push(line);
    if (kept.length >= 2 || kept.join(" ").length >= DEFAULT_RUNTIME_ERROR_SUMMARY_MAX_CHARS * 2) break;
  }
  return kept.join(" ");
}

function hasEnoughLeadingProse(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0;
}

function inlineStructuredPayloadStart(value: string): number | null {
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if ((char === "{" || char === "[") && hasEnoughLeadingProse(value.slice(0, index))) return index;
  }
  return null;
}

function truncateAtUnsafeMarker(value: string): string {
  let end = value.length;
  const structuredStart = inlineStructuredPayloadStart(value);
  if (structuredStart !== null && structuredStart < end) end = structuredStart;
  for (const pattern of UNSAFE_MARKERS) {
    pattern.lastIndex = 0;
    const match = pattern.exec(value);
    if (match && match.index < end) end = match.index;
  }
  return value.slice(0, end);
}

function normalizeWhitespace(value: string): string {
  return value
    .replace(/[=:\s]*[{[]\s*$/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

function truncateSummary(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const slice = value.slice(0, Math.max(1, maxChars - 1)).trimEnd();
  return `${slice}…`;
}

export function summarizeRuntimeError(error: unknown, options: {maxChars?: number} = {}): string | null {
  const message = messageFromError(error);
  if (!message?.trim()) return null;

  const maxChars = Math.max(40, Math.min(1_000, options.maxChars ?? DEFAULT_RUNTIME_ERROR_SUMMARY_MAX_CHARS));
  const summary = truncateSummary(normalizeWhitespace(
    truncateAtUnsafeMarker(leadingSafeText(message))
      .replace(FAILURE_KIND_PATTERN, " ")
  ), maxChars);

  if (!summary) return null;
  return summary;
}
