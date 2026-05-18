import ipaddr from "ipaddr.js";

import {isLoopbackHttpHostname} from "../../lib/http.js";
import {trimToNull, uniqueTrimmedStrings} from "../../lib/strings.js";

export interface GatewayNetworkControls {
  allowlist: readonly string[];
  trustedProxies: readonly string[];
}

export function parseGatewayIpList(raw: string | null): readonly string[] {
  return raw ? uniqueTrimmedStrings(raw.split(",")) : [];
}

function normalizeRemoteAddress(value: string | undefined): string {
  if (!value) {
    return "unknown";
  }
  if (value.startsWith("::ffff:")) {
    return value.slice("::ffff:".length);
  }
  return value;
}

function allowPublicWithoutIpAllowlist(env: NodeJS.ProcessEnv): boolean {
  return trimToNull(env.GATEWAY_ALLOW_PUBLIC_WITHOUT_IP_ALLOWLIST)?.toLowerCase() === "true";
}

function isGatewayAddressInList(address: string, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0 || address === "unknown") {
    return false;
  }
  let parsedAddress: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsedAddress = ipaddr.process(address);
  } catch {
    return false;
  }
  return allowlist.some((entry) => {
    try {
      if (entry.includes("/")) {
        return parsedAddress.match(ipaddr.parseCIDR(entry));
      }
      return parsedAddress.toString() === ipaddr.process(entry).toString();
    } catch {
      return false;
    }
  });
}

export function isGatewayClientAllowed(address: string, allowlist: readonly string[]): boolean {
  return allowlist.length === 0 || isGatewayAddressInList(address, allowlist);
}

function parseForwardedFor(value: string | string[] | undefined, trustedProxies: readonly string[]): string | null {
  const raw = Array.isArray(value) ? value.join(",") : value;
  if (!raw) {
    return null;
  }
  const addresses = raw.split(",").flatMap((candidate) => {
    const trimmed = normalizeRemoteAddress(candidate.trim());
    try {
      return [ipaddr.process(trimmed).toString()];
    } catch {
      return [];
    }
  });
  for (let index = addresses.length - 1; index >= 0; index -= 1) {
    const address = addresses[index];
    if (!address) {
      continue;
    }
    if (!isGatewayAddressInList(address, trustedProxies)) {
      return address;
    }
  }
  return addresses[0] ?? null;
}

export function resolveGatewayClientAddress(input: {
  remoteAddress?: string;
  forwardedFor?: string | string[];
  trustedProxies: readonly string[];
}): string {
  const remoteAddress = normalizeRemoteAddress(input.remoteAddress);
  if (!isGatewayAddressInList(remoteAddress, input.trustedProxies)) {
    return remoteAddress;
  }
  return parseForwardedFor(input.forwardedFor, input.trustedProxies) ?? remoteAddress;
}

export function resolveGatewayNetworkControls(input: {
  env: NodeJS.ProcessEnv;
  host: string;
}): GatewayNetworkControls {
  const allowlist = parseGatewayIpList(trimToNull(input.env.GATEWAY_IP_ALLOWLIST));
  const trustedProxies = parseGatewayIpList(trimToNull(input.env.GATEWAY_TRUSTED_PROXY_IPS));
  if (!isLoopbackHttpHostname(input.host) && allowlist.length === 0 && !allowPublicWithoutIpAllowlist(input.env)) {
    throw new Error("GATEWAY_IP_ALLOWLIST is required when binding Panda Gateway to a public host.");
  }
  return {
    allowlist,
    trustedProxies,
  };
}
