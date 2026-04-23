import {lookup as dnsLookupCb, type LookupAddress} from "node:dns";
import {lookup as dnsLookup} from "node:dns/promises";
import {isIP} from "node:net";

import ipaddr from "ipaddr.js";

import {ToolError} from "../../kernel/agent/exceptions.js";
import {trimToUndefined} from "../../lib/strings.js";

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
]);

type ParsedIpAddress = ipaddr.IPv4 | ipaddr.IPv6;
type Ipv4Range = ReturnType<ipaddr.IPv4["range"]>;
type Ipv6Range = ReturnType<ipaddr.IPv6["range"]>;
type BlockedIpv6Range = Ipv6Range | "discard";
type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

export type LookupHostname = (
  hostname: string,
) => Promise<readonly string[]> | readonly string[];

export type PinnedLookup = (
  hostname: string,
  options: number | {all?: boolean; family?: number} | LookupCallback | undefined,
  callback?: LookupCallback,
) => void;

export interface SafeHttpTarget {
  hostname: string;
  addresses: readonly string[];
  lookup: PinnedLookup;
}

export interface SafeHttpTargetOptions {
  allowPrivateHostnames?: readonly string[];
}

const BLOCKED_IPV4_SPECIAL_USE_RANGES = new Set<Ipv4Range>([
  "unspecified",
  "broadcast",
  "multicast",
  "linkLocal",
  "loopback",
  "carrierGradeNat",
  "private",
  "reserved",
]);
const BLOCKED_IPV6_SPECIAL_USE_RANGES = new Set<BlockedIpv6Range>([
  "unspecified",
  "loopback",
  "linkLocal",
  "uniqueLocal",
  "multicast",
  "reserved",
  "benchmarking",
  "discard",
  "orchid2",
]);
const RFC2544_BENCHMARK_PREFIX: [ipaddr.IPv4, number] = [ipaddr.IPv4.parse("198.18.0.0"), 15];
const EMBEDDED_IPV4_SENTINEL_RULES: Array<{
  matches: (parts: number[]) => boolean;
  toHextets: (parts: number[]) => [high: number, low: number];
}> = [
  {
    matches: (parts) =>
      parts[0] === 0 &&
      parts[1] === 0 &&
      parts[2] === 0 &&
      parts[3] === 0 &&
      parts[4] === 0 &&
      parts[5] === 0,
    toHextets: (parts) => [parts[6]!, parts[7]!],
  },
  {
    matches: (parts) =>
      parts[0] === 0x0064 &&
      parts[1] === 0xff9b &&
      parts[2] === 0x0001 &&
      parts[3] === 0 &&
      parts[4] === 0 &&
      parts[5] === 0,
    toHextets: (parts) => [parts[6]!, parts[7]!],
  },
  {
    matches: (parts) => parts[0] === 0x2002,
    toHextets: (parts) => [parts[1]!, parts[2]!],
  },
  {
    matches: (parts) => parts[0] === 0x2001 && parts[1] === 0x0000,
    toHextets: (parts) => [(parts[6] ?? 0) ^ 0xffff, (parts[7] ?? 0) ^ 0xffff],
  },
  {
    matches: (parts) => ((parts[4] ?? -1) & 0xfcff) === 0 && parts[5] === 0x5efe,
    toHextets: (parts) => [parts[6]!, parts[7]!],
  },
];

export function trimNonEmptyString(value: string | null | undefined): string | undefined {
  return trimToUndefined(value);
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().replace(/\.+$/, "").toLowerCase();
}

function normalizeAllowedHostnames(
  hostnames: readonly string[] | undefined,
): Set<string> {
  return new Set(
    (hostnames ?? [])
      .map((hostname) => normalizeHostname(hostname))
      .filter(Boolean),
  );
}

function stripIpv6Brackets(value: string): string {
  if (value.startsWith("[") && value.endsWith("]")) {
    return value.slice(1, -1);
  }
  return value;
}

function normalizeIpParseInput(raw: string | undefined): string | undefined {
  const trimmed = trimNonEmptyString(raw);
  if (!trimmed) {
    return undefined;
  }
  return stripIpv6Brackets(trimmed);
}

function isNumericIpv4LiteralPart(value: string): boolean {
  return /^[0-9]+$/.test(value) || /^0x[0-9a-f]+$/i.test(value);
}

function parseIpv6WithEmbeddedIpv4(raw: string): ipaddr.IPv6 | undefined {
  if (!raw.includes(":") || !raw.includes(".")) {
    return undefined;
  }
  const match = /^(.*:)([^:%]+(?:\.[^:%]+){3})(%[0-9A-Za-z]+)?$/i.exec(raw);
  if (!match) {
    return undefined;
  }
  const prefix = match[1];
  const embeddedIpv4 = match[2];
  const zoneSuffix = match[3] ?? "";
  if (!prefix || !embeddedIpv4) {
    return undefined;
  }
  if (!ipaddr.IPv4.isValidFourPartDecimal(embeddedIpv4)) {
    return undefined;
  }
  const octets = embeddedIpv4.split(".").map((part) => Number.parseInt(part, 10));
  const first = octets[0];
  const second = octets[1];
  const third = octets[2];
  const fourth = octets[3];
  if (
    first === undefined ||
    second === undefined ||
    third === undefined ||
    fourth === undefined
  ) {
    return undefined;
  }
  const high = ((first << 8) | second).toString(16);
  const low = ((third << 8) | fourth).toString(16);
  const normalizedIpv6 = `${prefix}${high}:${low}${zoneSuffix}`;
  if (!ipaddr.IPv6.isValid(normalizedIpv6)) {
    return undefined;
  }
  return ipaddr.IPv6.parse(normalizedIpv6);
}

function parseCanonicalIpAddress(raw: string | undefined): ParsedIpAddress | undefined {
  const normalized = normalizeIpParseInput(raw);
  if (!normalized) {
    return undefined;
  }
  if (ipaddr.IPv4.isValid(normalized)) {
    if (!ipaddr.IPv4.isValidFourPartDecimal(normalized)) {
      return undefined;
    }
    return ipaddr.IPv4.parse(normalized);
  }
  if (ipaddr.IPv6.isValid(normalized)) {
    return ipaddr.IPv6.parse(normalized);
  }
  return parseIpv6WithEmbeddedIpv4(normalized);
}

function parseLooseIpAddress(raw: string | undefined): ParsedIpAddress | undefined {
  const normalized = normalizeIpParseInput(raw);
  if (!normalized) {
    return undefined;
  }
  if (ipaddr.isValid(normalized)) {
    return ipaddr.parse(normalized);
  }
  return parseIpv6WithEmbeddedIpv4(normalized);
}

function normalizeIpv4MappedAddress(address: ParsedIpAddress): ParsedIpAddress {
  if (address.kind() !== "ipv6") {
    return address;
  }
  const ipv6Address = address as ipaddr.IPv6;
  if (!ipv6Address.isIPv4MappedAddress()) {
    return ipv6Address;
  }
  return ipv6Address.toIPv4Address();
}

function isCanonicalDottedDecimalIpv4(raw: string | undefined): boolean {
  const normalized = normalizeIpParseInput(raw);
  return normalized ? ipaddr.IPv4.isValidFourPartDecimal(normalized) : false;
}

function isLegacyIpv4Literal(raw: string | undefined): boolean {
  const normalized = normalizeIpParseInput(raw);
  if (!normalized || normalized.includes(":")) {
    return false;
  }
  if (isCanonicalDottedDecimalIpv4(normalized)) {
    return false;
  }
  const parts = normalized.split(".");
  if (parts.length === 0 || parts.length > 4 || parts.some((part) => part.length === 0)) {
    return false;
  }
  return parts.every((part) => isNumericIpv4LiteralPart(part));
}

function looksLikeUnsupportedIpv4Literal(address: string): boolean {
  const parts = address.split(".");
  if (parts.length === 0 || parts.length > 4 || parts.some((part) => part.length === 0)) {
    return false;
  }
  return parts.every((part) => /^[0-9]+$/.test(part) || /^0x/i.test(part));
}

function isBlockedHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (!normalized) {
    return false;
  }
  return BLOCKED_HOSTNAMES.has(normalized)
    || normalized.endsWith(".localhost")
    || normalized.endsWith(".local")
    || normalized.endsWith(".internal");
}

function isBlockedSpecialUseIpv4Address(address: ipaddr.IPv4): boolean {
  return BLOCKED_IPV4_SPECIAL_USE_RANGES.has(address.range()) || address.match(RFC2544_BENCHMARK_PREFIX);
}

function isBlockedSpecialUseIpv6Address(address: ipaddr.IPv6): boolean {
  const range = address.range() as BlockedIpv6Range;
  if (BLOCKED_IPV6_SPECIAL_USE_RANGES.has(range)) {
    return true;
  }
  return (address.parts[0] ?? 0) >= 0xfec0 && (address.parts[0] ?? 0) <= 0xfeff;
}

function decodeIpv4FromHextets(high: number, low: number): ipaddr.IPv4 {
  const octets: [number, number, number, number] = [
    (high >>> 8) & 0xff,
    high & 0xff,
    (low >>> 8) & 0xff,
    low & 0xff,
  ];
  return ipaddr.IPv4.parse(octets.join("."));
}

function extractEmbeddedIpv4FromIpv6(address: ipaddr.IPv6): ipaddr.IPv4 | undefined {
  if (address.isIPv4MappedAddress()) {
    return address.toIPv4Address();
  }
  if (address.range() === "rfc6145" || address.range() === "rfc6052") {
    return decodeIpv4FromHextets(address.parts[6] ?? 0, address.parts[7] ?? 0);
  }
  for (const rule of EMBEDDED_IPV4_SENTINEL_RULES) {
    if (rule.matches(address.parts)) {
      const [high, low] = rule.toHextets(address.parts);
      return decodeIpv4FromHextets(high, low);
    }
  }
  return undefined;
}

function isBlockedIpAddress(address: string): boolean {
  const normalized = normalizeHostname(address);
  if (!normalized) {
    return false;
  }

  const parsed = parseCanonicalIpAddress(normalized);
  if (parsed) {
    const comparable = normalizeIpv4MappedAddress(parsed);
    if (comparable.kind() === "ipv4") {
      return isBlockedSpecialUseIpv4Address(comparable as ipaddr.IPv4);
    }
    const comparableIpv6 = comparable as ipaddr.IPv6;
    if (isBlockedSpecialUseIpv6Address(comparableIpv6)) {
      return true;
    }
    const embeddedIpv4 = extractEmbeddedIpv4FromIpv6(comparableIpv6);
    return embeddedIpv4 ? isBlockedSpecialUseIpv4Address(embeddedIpv4) : false;
  }

  if (normalized.includes(":") && !parseLooseIpAddress(normalized)) {
    return true;
  }
  if (!isCanonicalDottedDecimalIpv4(normalized) && isLegacyIpv4Literal(normalized)) {
    return true;
  }
  return looksLikeUnsupportedIpv4Literal(normalized);
}

export async function defaultLookupHostname(hostname: string): Promise<readonly string[]> {
  const results = await dnsLookup(hostname, {all: true, verbatim: true});
  return results.map((entry) => entry.address);
}

async function resolveAddresses(
  hostname: string,
  lookupHostname: LookupHostname,
  toolName: string,
): Promise<readonly string[]> {
  const normalizedIp = normalizeIpParseInput(hostname);
  if (normalizedIp && isIP(normalizedIp)) {
    return [normalizedIp];
  }

  const results = await lookupHostname(hostname);
  const addresses = results
    .map((address) => trimNonEmptyString(address))
    .filter((address): address is string => Boolean(address));
  if (addresses.length === 0) {
    throw new ToolError(`${toolName} could not resolve ${hostname}.`);
  }

  return addresses;
}

export function createPinnedLookup(params: {
  hostname: string;
  addresses: readonly string[];
  fallback?: typeof dnsLookupCb;
}): PinnedLookup {
  const normalizedHost = normalizeHostname(params.hostname);
  if (params.addresses.length === 0) {
    throw new ToolError(`Pinned lookup requires at least one address for ${params.hostname}`);
  }

  const fallback = params.fallback ?? dnsLookupCb;
  const fallbackLookup = fallback as unknown as (
    hostname: string,
    callback: LookupCallback,
  ) => void;
  const fallbackWithOptions = fallback as unknown as (
    hostname: string,
    options: unknown,
    callback: LookupCallback,
  ) => void;
  const records = params.addresses.map((address) => ({
    address,
    family: isIP(address) === 6 ? 6 : 4,
  }));
  let index = 0;

  return ((host: string, options?: unknown, callback?: unknown) => {
    const cb: LookupCallback =
      typeof options === "function" ? (options as LookupCallback) : (callback as LookupCallback);
    if (!cb) {
      return;
    }

    const normalized = normalizeHostname(host);
    if (!normalized || normalized !== normalizedHost) {
      if (typeof options === "function" || options === undefined) {
        return fallbackLookup(host, cb);
      }
      return fallbackWithOptions(host, options, cb);
    }

    const opts =
      typeof options === "object" && options !== null
        ? (options as {all?: boolean; family?: number})
        : {};
    const requestedFamily =
      typeof options === "number" ? options : typeof opts.family === "number" ? opts.family : 0;
    const candidates =
      requestedFamily === 4 || requestedFamily === 6
        ? records.filter((entry) => entry.family === requestedFamily)
        : records;
    const usable = candidates.length > 0 ? candidates : records;
    if (opts.all) {
      cb(null, usable as LookupAddress[]);
      return;
    }

    const chosen = usable[index % usable.length];
    if (!chosen) {
      cb(new Error(`Pinned lookup could not choose an address for ${host}`) as NodeJS.ErrnoException, "");
      return;
    }
    index += 1;
    cb(null, chosen.address, chosen.family);
  }) as PinnedLookup;
}

export async function resolveSafeHttpTarget(
  url: URL,
  lookupHostname: LookupHostname,
  toolName: string,
  options: SafeHttpTargetOptions = {},
): Promise<SafeHttpTarget> {
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new ToolError(`${toolName} only supports http:// and https:// URLs.`);
  }
  if (url.username || url.password) {
    throw new ToolError(`${toolName} does not allow URLs with embedded credentials.`);
  }

  const hostname = normalizeHostname(url.hostname);
  const allowedPrivateHostnames = normalizeAllowedHostnames(options.allowPrivateHostnames);
  const allowPrivateTarget = allowedPrivateHostnames.has(hostname);
  if (!hostname) {
    throw new ToolError(`${toolName} requires a valid hostname.`);
  }
  if (!allowPrivateTarget && isBlockedHostname(hostname)) {
    throw new ToolError(`${toolName} blocked a private hostname: ${hostname}`);
  }

  const addresses = await resolveAddresses(hostname, lookupHostname, toolName);
  if (!allowPrivateTarget) {
    const blockedAddress = addresses.find((address) => {
      const normalized = normalizeIpParseInput(address);
      return !normalized || isBlockedIpAddress(normalized);
    });
    if (blockedAddress) {
      throw new ToolError(`${toolName} blocked a private address for ${hostname}: ${blockedAddress}`);
    }
  }

  return {
    hostname,
    addresses,
    lookup: createPinnedLookup({
      hostname,
      addresses,
    }),
  };
}
