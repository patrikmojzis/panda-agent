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

export interface EmailAuthenticationHeaders {
  authenticationResults?: string;
  receivedSpf?: string;
  xSpamdResult?: string;
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

function readAuthenticationResultsMechanism(
  header: string | undefined,
  mechanism: "spf" | "dkim" | "dmarc",
): EmailAuthVerdict[] {
  if (!header) {
    return [];
  }

  return Array.from(header.matchAll(new RegExp(`\\b${mechanism}\\s*=\\s*([a-z]+)`, "gi")))
    .map((match) => normalizeVerdict(match[1]))
    .filter((value): value is EmailAuthVerdict => Boolean(value));
}

function readReceivedSpf(header: string | undefined): EmailAuthVerdict[] {
  if (!header) {
    return [];
  }

  return Array.from(header.matchAll(/(?:^|\n)\s*([a-z]+)/gi))
    .map((match) => normalizeVerdict(match[1]))
    .filter((value): value is EmailAuthVerdict => Boolean(value));
}

function hasRspamdSymbol(header: string, symbol: string): boolean {
  return new RegExp(`\\b${symbol}\\b`, "i").test(header);
}

function readRspamdSpf(header: string | undefined): EmailAuthVerdict[] {
  if (!header) {
    return [];
  }

  const verdicts: EmailAuthVerdict[] = [];
  if (hasRspamdSymbol(header, "R_SPF_FAIL")) {
    verdicts.push("fail");
  }
  if (hasRspamdSymbol(header, "R_SPF_SOFTFAIL")) {
    verdicts.push("softfail");
  }
  if (hasRspamdSymbol(header, "R_SPF_DNSFAIL")) {
    verdicts.push("temperror");
  }
  if (hasRspamdSymbol(header, "R_SPF_PERMFAIL")) {
    verdicts.push("permerror");
  }
  if (hasRspamdSymbol(header, "R_SPF_NEUTRAL")) {
    verdicts.push("neutral");
  }
  if (hasRspamdSymbol(header, "R_SPF_ALLOW")) {
    verdicts.push("pass");
  }

  return verdicts;
}

function readRspamdDkim(header: string | undefined): EmailAuthVerdict[] {
  if (!header) {
    return [];
  }

  const verdicts: EmailAuthVerdict[] = [];
  if (hasRspamdSymbol(header, "R_DKIM_REJECT")) {
    verdicts.push("fail");
  }
  if (hasRspamdSymbol(header, "R_DKIM_TEMPFAIL")) {
    verdicts.push("temperror");
  }
  if (hasRspamdSymbol(header, "R_DKIM_PERMFAIL")) {
    verdicts.push("permerror");
  }
  if (hasRspamdSymbol(header, "R_DKIM_ALLOW")) {
    verdicts.push("pass");
  }

  for (const match of header.matchAll(/\bDKIM_TRACE\b[^\[]*\[([^\]]+)\]/gi)) {
    const trace = match[1] ?? "";
    if (trace.includes(":-")) {
      verdicts.push("fail");
    }
    if (trace.includes(":+")) {
      verdicts.push("pass");
    }
  }

  return verdicts;
}

function readRspamdDmarc(header: string | undefined): EmailAuthVerdict[] {
  if (!header) {
    return [];
  }

  const verdicts: EmailAuthVerdict[] = [];
  if (hasRspamdSymbol(header, "DMARC_POLICY_REJECT") || hasRspamdSymbol(header, "DMARC_POLICY_QUARANTINE")) {
    verdicts.push("fail");
  }
  if (hasRspamdSymbol(header, "DMARC_POLICY_SOFTFAIL")) {
    verdicts.push("softfail");
  }
  if (hasRspamdSymbol(header, "DMARC_POLICY_ALLOW")) {
    verdicts.push("pass");
  }

  return verdicts;
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
 * Parses IMAP-delivered authentication evidence defensively: failures are
 * useful warning signals, but passes are not enough to trust raw headers.
 */
export function parseEmailAuthenticationHeaders(headers: EmailAuthenticationHeaders): ParsedEmailAuthentication {
  const authSpf = pickVerdict([
    ...readAuthenticationResultsMechanism(headers.authenticationResults, "spf"),
    ...readReceivedSpf(headers.receivedSpf),
    ...readRspamdSpf(headers.xSpamdResult),
  ]);
  const authDkim = pickVerdict([
    ...readAuthenticationResultsMechanism(headers.authenticationResults, "dkim"),
    ...readRspamdDkim(headers.xSpamdResult),
  ]);
  const authDmarc = pickVerdict([
    ...readAuthenticationResultsMechanism(headers.authenticationResults, "dmarc"),
    ...readRspamdDmarc(headers.xSpamdResult),
  ]);
  return {
    ...(authSpf ? {authSpf} : {}),
    ...(authDkim ? {authDkim} : {}),
    ...(authDmarc ? {authDmarc} : {}),
    authSummary: summarizeEmailAuthentication({authSpf, authDkim, authDmarc}),
  };
}

export function parseEmailAuthenticationResults(header: string | undefined): ParsedEmailAuthentication {
  return parseEmailAuthenticationHeaders({authenticationResults: header});
}
