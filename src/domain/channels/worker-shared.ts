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
    const parsed = JSON.parse(payload) as Partial<{
      channel: unknown;
      connectorKey: unknown;
    }>;
    if (!parsed || typeof parsed.channel !== "string" || typeof parsed.connectorKey !== "string") {
      return null;
    }

    return {
      channel: parsed.channel,
      connectorKey: parsed.connectorKey,
    };
  } catch {
    return null;
  }
}
