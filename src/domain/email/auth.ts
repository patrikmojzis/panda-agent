import type {EmailAuthSummary, EmailAuthVerdict} from "./types.js";

const FAIL_VERDICTS = new Set<EmailAuthVerdict>(["fail", "softfail", "temperror", "permerror"]);
const KNOWN_VERDICTS = new Set<EmailAuthVerdict>([
  "pass",
  "fail",
  "softfail",
  "neutral",
  "none",
  "temperror",
  "permerror",
  "unknown",
]);

export interface ParsedEmailAuthentication {
  authSpf?: EmailAuthVerdict;
  authDkim?: EmailAuthVerdict;
  authDmarc?: EmailAuthVerdict;
  authSummary: EmailAuthSummary;
}

function normalizeVerdict(value: string | undefined): EmailAuthVerdict | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized && KNOWN_VERDICTS.has(normalized as EmailAuthVerdict)
    ? normalized as EmailAuthVerdict
    : undefined;
}

function pickVerdict(values: readonly EmailAuthVerdict[]): EmailAuthVerdict | undefined {
  const fail = values.find((value) => FAIL_VERDICTS.has(value));
  if (fail) {
    return fail;
  }
  if (values.includes("pass")) {
    return "pass";
  }

  return values[0];
}

function readMechanism(header: string | undefined, mechanism: "spf" | "dkim" | "dmarc"): EmailAuthVerdict | undefined {
  if (!header) {
    return undefined;
  }

  const verdicts = Array.from(header.matchAll(new RegExp(`\\b${mechanism}\\s*=\\s*([a-z]+)`, "gi")))
    .map((match) => normalizeVerdict(match[1]))
    .filter((value): value is EmailAuthVerdict => Boolean(value));
  return pickVerdict(verdicts);
}

export function summarizeEmailAuthentication(input: {
  authSpf?: EmailAuthVerdict;
  authDkim?: EmailAuthVerdict;
  authDmarc?: EmailAuthVerdict;
}): EmailAuthSummary {
  const verdicts = [input.authSpf, input.authDkim, input.authDmarc]
    .filter((value): value is EmailAuthVerdict => Boolean(value));
  if (verdicts.some((value) => FAIL_VERDICTS.has(value))) {
    return "suspicious";
  }

  return "unknown";
}

/**
 * Parses IMAP-delivered Authentication-Results defensively: failures are
 * useful warning signals, but passes are not enough to trust raw headers.
 */
export function parseEmailAuthenticationResults(header: string | undefined): ParsedEmailAuthentication {
  const authSpf = readMechanism(header, "spf");
  const authDkim = readMechanism(header, "dkim");
  const authDmarc = readMechanism(header, "dmarc");
  return {
    ...(authSpf ? {authSpf} : {}),
    ...(authDkim ? {authDkim} : {}),
    ...(authDmarc ? {authDmarc} : {}),
    authSummary: summarizeEmailAuthentication({authSpf, authDkim, authDmarc}),
  };
}
