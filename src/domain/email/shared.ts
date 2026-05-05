export const EMAIL_SOURCE = "email";
export const EMAIL_CONNECTOR_KEY = "smtp";
export const DEFAULT_EMAIL_MAILBOXES = ["INBOX"] as const;
export const DEFAULT_EMAIL_BACKFILL_LIMIT = 100;
export const EMAIL_EXTERNAL_CONTENT_MARKER = "=====EXTERNAL CONTENT=====";

/** Normalizes user-facing email account handles used by tools and CLI. */
export function normalizeEmailAccountKey(value: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(trimmed)) {
    throw new Error("Email account key must use 1-64 letters, numbers, dashes, or underscores.");
  }

  return trimmed;
}

/** Lowercases exact recipient allowlist keys without accepting display names. */
export function normalizeEmailAddress(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!/^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(trimmed)) {
    throw new Error(`Invalid email address ${value}`);
  }

  return trimmed;
}

export function normalizeOptionalEmailAddress(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === ""
    ? undefined
    : normalizeEmailAddress(value);
}

export function normalizeEmailMailbox(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Email mailbox must not be empty.");
  }
  if (/[\x00-\x1F\x7F]/.test(trimmed)) {
    throw new Error("Email mailbox must not contain control characters.");
  }

  return trimmed;
}

/** Wraps inbound email body text so models treat it as untrusted external content. */
export function markExternalEmailContent(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  return [
    EMAIL_EXTERNAL_CONTENT_MARKER,
    trimmed,
    EMAIL_EXTERNAL_CONTENT_MARKER,
  ].join("\n");
}
