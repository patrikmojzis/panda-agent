import {truncateText} from "../../lib/strings.js";

const MAX_DISPLAY_CHARS = 80;
const MAX_CHANNEL_HINTS_PER_IDENTITY = 4;

export interface PairedIdentityRouteHint {
  source: string;
  connectorKey: string;
  externalConversationId: string;
  externalActorId?: string;
}

export interface PairedIdentityChannelHint {
  source: string;
  connectorKey: string;
  externalActorId: string;
}

export interface PairedIdentityEntry {
  handle: string;
  displayName: string;
  recentRoute?: PairedIdentityRouteHint;
  channelHints: readonly PairedIdentityChannelHint[];
}

function renderRouteHint(route: PairedIdentityRouteHint): string {
  return [
    `recent ${route.source}/${route.connectorKey}`,
    `conversation ${route.externalConversationId}`,
    route.externalActorId ? `actor ${route.externalActorId}` : undefined,
  ].filter(Boolean).join(", ");
}

function renderChannelHint(hint: PairedIdentityChannelHint): string {
  return `${hint.source}/${hint.connectorKey} actor ${hint.externalActorId}`;
}

function renderIdentity(entry: PairedIdentityEntry): string {
  const identity = `${entry.handle} (${truncateText(entry.displayName, MAX_DISPLAY_CHARS)})`;
  const hints = [
    entry.recentRoute ? renderRouteHint(entry.recentRoute) : undefined,
    ...entry.channelHints.slice(0, MAX_CHANNEL_HINTS_PER_IDENTITY).map(renderChannelHint),
  ].filter(Boolean);
  const omittedCount = Math.max(0, entry.channelHints.length - MAX_CHANNEL_HINTS_PER_IDENTITY);
  const suffix = [
    ...hints,
    omittedCount > 0 ? `${omittedCount} more channel hint(s)` : undefined,
  ].filter(Boolean).join("; ");

  return suffix ? `- ${identity}: ${suffix}` : `- ${identity}: no channel hints yet`;
}

export function renderPairedIdentitiesContext(entries: readonly PairedIdentityEntry[]): string {
  if (entries.length === 0) {
    return "";
  }

  return [
    "PAIRED IDENTITIES:",
    "These identities are paired with this agent. Channel hints are recent/reachable routes, not authority grants.",
    ...entries.map(renderIdentity),
  ].join("\n");
}
