import {isRecord} from "../../lib/records.js";
import {requireNonEmptyString} from "../../lib/strings.js";

/**
 * Normalizes `{channel, connectorKey}` worker lookups with consistent trimming.
 */
export function normalizeChannelWorkerLookup<TLookup extends {
  channel: string;
  connectorKey: string;
}>(
  lookup: TLookup,
  scope: string,
): TLookup {
  return {
    ...lookup,
    channel: requireNonEmptyString(lookup.channel, `${scope} channel must not be empty.`),
    connectorKey: requireNonEmptyString(lookup.connectorKey, `${scope} connector key must not be empty.`),
  };
}

/**
 * Returns true when a pending-work notification targets the same connector.
 */
export function isMatchingChannelNotification(
  lookup: {
    channel: string;
    connectorKey: string;
  },
  notification: {
    channel: string;
    connectorKey: string;
  },
): boolean {
  return notification.channel === lookup.channel
    && notification.connectorKey === lookup.connectorKey;
}

/**
 * Parses the minimal connector notification shape used by channel workers.
 */
export function parseChannelNotification(
  payload: string,
): {channel: string; connectorKey: string} | null {
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }

    return {
      channel: requireNonEmptyString(parsed.channel, "Channel notification channel must not be empty."),
      connectorKey: requireNonEmptyString(parsed.connectorKey, "Channel notification connector key must not be empty."),
    };
  } catch {
    return null;
  }
}
