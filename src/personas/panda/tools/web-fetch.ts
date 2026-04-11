import {lookup as dnsLookupCb, type LookupAddress} from "node:dns";
import {lookup as dnsLookup} from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import {isIP} from "node:net";

import {Readability} from "@mozilla/readability";
import ipaddr from "ipaddr.js";
import {parseHTML} from "linkedom";

import {ToolError} from "../../../kernel/agent/exceptions.js";

const DEFAULT_WEB_FETCH_TIMEOUT_MS = 20_000;
const DEFAULT_WEB_FETCH_MAX_REDIRECTS = 3;
const DEFAULT_WEB_FETCH_MAX_RESPONSE_BYTES = 2_000_000;
const DEFAULT_WEB_FETCH_MAX_CONTENT_CHARS = 20_000;
const DEFAULT_WEB_FETCH_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const DEFAULT_ACCEPT_LANGUAGE = "en-US,en;q=0.9";
const DEFAULT_ACCEPT_ENCODING = "identity";
const MAX_ERROR_BYTES = 64_000;
const MAX_HTML_CHARS_FOR_READABILITY = 1_000_000;
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
]);
const HIDDEN_CLASS_NAMES = new Set([
  "hidden",
  "invisible",
  "sr-only",
  "screen-reader-only",
  "visually-hidden",
]);
const INVISIBLE_UNICODE_RE =
  /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\uFEFF\u{E0000}-\u{E007F}]/gu;

export type WebFetchProgressStatus = "validating" | "fetching" | "extracting";
export type WebFetchProgress = {
  status: WebFetchProgressStatus;
  url?: string;
  finalUrl?: string;
  redirectCount?: number;
};

export type WebFetchLink = {
  text: string;
  url: string;
};

export type LookupHostname = (
  hostname: string,
) => Promise<readonly string[]> | readonly string[];

export type FetchImpl = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface FetchReadableWebPageOptions {
  fetchImpl?: FetchImpl;
  lookupHostname?: LookupHostname;
  timeoutMs?: number;
  maxRedirects?: number;
  maxResponseBytes?: number;
  maxContentChars?: number;
  userAgent?: string;
  signal?: AbortSignal;
  onProgress?: (progress: WebFetchProgress) => void;
}

export interface FetchReadableWebPageResult {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string | null;
  title: string | null;
  description: string | null;
  siteName: string | null;
  truncated: boolean;
  links: readonly WebFetchLink[];
  content: string;
}

type PageMetadata = {
  title?: string;
  description?: string;
  siteName?: string;
};

type HtmlDocument = ReturnType<typeof parseHTML>["document"];
type HtmlElementLike = {
  tagName: string;
  hasAttribute(name: string): boolean;
  getAttribute(name: string): string | null;
  remove(): void;
};
type ParsedIpAddress = ipaddr.IPv4 | ipaddr.IPv6;
type Ipv4Range = ReturnType<ipaddr.IPv4["range"]>;
type Ipv6Range = ReturnType<ipaddr.IPv6["range"]>;
type BlockedIpv6Range = Ipv6Range | "discard";
type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;
type PinnedLookup = (
  hostname: string,
  options: number | {all?: boolean; family?: number} | LookupCallback | undefined,
  callback?: LookupCallback,
) => void;
type SafeTarget = {
  hostname: string;
  addresses: readonly string[];
  lookup: PinnedLookup;
};
type FetchedResponse = {
  status: number;
  statusText: string;
  headers: Headers;
  bodyText: string;
};

type ReadableExtraction = {
  title?: string;
  description?: string;
  siteName?: string;
  content: string;
  links: readonly WebFetchLink[];
};

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

function trimNonEmptyString(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}

function parseBaseContentType(value: string | null): string | undefined {
  const [rawType] = value?.split(";") ?? [];
  return trimNonEmptyString(rawType)?.toLowerCase();
}

function parseCharset(value: string | null): string | undefined {
  const match = /charset\s*=\s*("?)([^";]+)\1/i.exec(value ?? "");
  return trimNonEmptyString(match?.[2]);
}

function getTextDecoder(contentType: string | null): TextDecoder {
  const charset = parseCharset(contentType);
  if (charset) {
    try {
      return new TextDecoder(charset);
    } catch {
      // Fall back to UTF-8 when the server advertises nonsense.
    }
  }

  return new TextDecoder("utf-8");
}

function truncateText(value: string, maxChars: number): {text: string; truncated: boolean} {
  if (value.length <= maxChars) {
    return {text: value, truncated: false};
  }

  return {
    text: value.slice(0, maxChars).trimEnd(),
    truncated: true,
  };
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gi, (_, dec) => String.fromCharCode(Number.parseInt(dec, 10)));
}

function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]+>/g, ""));
}

function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function stripInvisibleUnicode(value: string): string {
  return value.replace(INVISIBLE_UNICODE_RE, "");
}

function looksLikeHtml(value: string): boolean {
  const trimmed = value.trimStart().slice(0, 512).toLowerCase();
  if (!trimmed) {
    return false;
  }

  return trimmed.startsWith("<!doctype html")
    || trimmed.startsWith("<html")
    || /<(head|body|article|main|p|div)\b/.test(trimmed);
}

function isRedirectStatus(status: number): boolean {
  return status === 301
    || status === 302
    || status === 303
    || status === 307
    || status === 308;
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().replace(/\.+$/, "").toLowerCase();
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

async function defaultLookupHostname(hostname: string): Promise<readonly string[]> {
  const results = await dnsLookup(hostname, {all: true, verbatim: true});
  return results.map((entry) => entry.address);
}

async function resolveAddresses(
  hostname: string,
  lookupHostname: LookupHostname,
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
    throw new ToolError(`Unable to resolve ${hostname}.`);
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

async function resolveSafeTarget(
  url: URL,
  lookupHostname: LookupHostname,
): Promise<SafeTarget> {
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new ToolError("web_fetch only supports http:// and https:// URLs.");
  }
  if (url.username || url.password) {
    throw new ToolError("web_fetch does not allow URLs with embedded credentials.");
  }

  const hostname = normalizeHostname(url.hostname);
  if (!hostname) {
    throw new ToolError("web_fetch requires a valid hostname.");
  }
  if (isBlockedHostname(hostname)) {
    throw new ToolError(`web_fetch blocked a private hostname: ${hostname}`);
  }

  const addresses = await resolveAddresses(hostname, lookupHostname);
  const blockedAddress = addresses.find((address) => {
    const normalized = normalizeIpParseInput(address);
    return !normalized || isBlockedIpAddress(normalized);
  });
  if (blockedAddress) {
    throw new ToolError(`web_fetch blocked a private address for ${hostname}: ${blockedAddress}`);
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

function toHeaders(headers: Record<string, string>): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    result.set(name, value);
  }
  return result;
}

function fromNodeHeaders(
  headers: Record<string, string | string[] | undefined>,
): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      result.set(name, value.join(", "));
      continue;
    }
    if (typeof value === "string") {
      result.set(name, value);
    }
  }
  return result;
}

async function fetchWithCustomImpl(
  url: URL,
  params: {
    fetchImpl: FetchImpl;
    headers: Record<string, string>;
    signal?: AbortSignal;
    maxBytes: number;
  },
): Promise<FetchedResponse> {
  const response = await params.fetchImpl(url, {
    method: "GET",
    redirect: "manual",
    headers: toHeaders(params.headers),
    signal: params.signal,
  });

  return {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    bodyText: isRedirectStatus(response.status)
      ? ""
      : await readResponseText(response, params.maxBytes),
  };
}

export async function fetchWithPinnedLookup(
  url: URL,
  params: {
    lookup: PinnedLookup;
    headers: Record<string, string>;
    signal?: AbortSignal;
    maxBytes: number;
  },
): Promise<FetchedResponse> {
  const requestImpl = url.protocol === "https:" ? https.request : http.request;

  return await new Promise<FetchedResponse>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };
    const succeed = (value: FetchedResponse) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };

    const request = requestImpl({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port ? Number.parseInt(url.port, 10) : undefined,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: params.headers,
      lookup: params.lookup as never,
      signal: params.signal,
      agent: false,
    }, (response) => {
      const headers = fromNodeHeaders(response.headers);
      const status = response.statusCode ?? 0;
      const statusText = response.statusMessage ?? "";

      if (isRedirectStatus(status)) {
        response.resume();
        response.once("end", () => succeed({
          status,
          statusText,
          headers,
          bodyText: "",
        }));
        response.once("error", fail);
        return;
      }

      const contentLength = Number(headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > params.maxBytes) {
        response.resume();
        fail(new ToolError(
          `web_fetch response exceeded the ${params.maxBytes} byte limit before reading the body.`,
        ));
        return;
      }

      const chunks: Buffer[] = [];
      let totalBytes = 0;

      response.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buffer.byteLength;
        if (totalBytes > params.maxBytes) {
          response.destroy(new ToolError(`web_fetch response exceeded the ${params.maxBytes} byte limit.`));
          return;
        }
        chunks.push(buffer);
      });
      response.once("error", fail);
      response.once("end", () => {
        const combined = Buffer.concat(chunks);
        succeed({
          status,
          statusText,
          headers,
          bodyText: getTextDecoder(headers.get("content-type")).decode(combined),
        });
      });
    });

    request.once("error", fail);
    request.end();
  });
}

async function readResponseText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new ToolError(
      `web_fetch response exceeded the ${maxBytes} byte limit before reading the body.`,
    );
  }

  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const {done, value} = await reader.read();
    if (done) {
      break;
    }
    if (!value) {
      continue;
    }

    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ToolError(`web_fetch response exceeded the ${maxBytes} byte limit.`);
    }
    chunks.push(value);
  }

  const buffer = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return getTextDecoder(response.headers.get("content-type")).decode(buffer);
}

function sanitizeErrorSnippet(value: string): string {
  const trimmed = normalizeWhitespace(stripInvisibleUnicode(stripTags(value)));
  if (!trimmed) {
    return "";
  }

  return truncateText(trimmed, 4_000).text;
}

function absolutizeUrl(rawUrl: string, baseUrl: string): string | null {
  try {
    const resolved = new URL(rawUrl, baseUrl);
    if (!["http:", "https:"].includes(resolved.protocol)) {
      return null;
    }

    return resolved.toString();
  } catch {
    return null;
  }
}

function absolutizeAnchors(html: string, baseUrl: string): string {
  const {document} = parseHTML(`<html><body>${html}</body></html>`);
  for (const anchor of document.querySelectorAll("a[href]")) {
    const href = trimNonEmptyString(anchor.getAttribute("href"));
    if (!href) {
      anchor.removeAttribute("href");
      continue;
    }

    const absolute = absolutizeUrl(href, baseUrl);
    if (absolute) {
      anchor.setAttribute("href", absolute);
      continue;
    }

    anchor.removeAttribute("href");
  }

  return document.body?.innerHTML ?? html;
}

function htmlToMarkdown(html: string, baseUrl: string): string {
  let text = absolutizeAnchors(html, baseUrl)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "");

  text = text.replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, body) => {
    const label = normalizeWhitespace(stripTags(body));
    return label ? `[${label}](${href})` : href;
  });
  text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, body) => {
    const prefix = "#".repeat(Math.max(1, Math.min(6, Number.parseInt(level, 10))));
    const label = normalizeWhitespace(stripTags(body));
    return label ? `\n${prefix} ${label}\n` : "\n";
  });
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, body) => {
    const label = normalizeWhitespace(stripTags(body));
    return label ? `\n- ${label}` : "";
  });
  text = text
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|header|footer|main|aside|table|tr|ul|ol|blockquote|pre)>/gi, "\n");

  return normalizeWhitespace(stripInvisibleUnicode(stripTags(text)));
}

function readMetaContent(
  document: HtmlDocument,
  selectors: readonly string[],
): string | undefined {
  for (const selector of selectors) {
    const content = trimNonEmptyString(document.querySelector(selector)?.getAttribute("content"));
    if (content) {
      return content;
    }
  }

  return undefined;
}

function readPageMetadata(document: HtmlDocument, url: string): PageMetadata {
  return {
    title: trimNonEmptyString(document.querySelector("title")?.textContent ?? undefined),
    description: readMetaContent(document, [
      'meta[property="og:description"]',
      'meta[name="description"]',
      'meta[name="twitter:description"]',
    ]),
    siteName:
      readMetaContent(document, [
        'meta[property="og:site_name"]',
        'meta[name="application-name"]',
      ]) ?? trimNonEmptyString(new URL(url).hostname),
  };
}

function shouldRemoveElement(element: HtmlElementLike): boolean {
  const tagName = element.tagName.toLowerCase();
  if ([
    "script",
    "style",
    "noscript",
    "template",
    "iframe",
    "canvas",
    "svg",
    "object",
    "embed",
  ].includes(tagName)) {
    return true;
  }

  if (element.hasAttribute("hidden")) {
    return true;
  }
  if (element.getAttribute("aria-hidden") === "true") {
    return true;
  }

  const classNames = (element.getAttribute("class") ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (classNames.some((className) => HIDDEN_CLASS_NAMES.has(className))) {
    return true;
  }

  const style = (element.getAttribute("style") ?? "").toLowerCase();
  return style.includes("display:none")
    || style.includes("visibility:hidden")
    || style.includes("opacity:0")
    || style.includes("font-size:0");
}

function sanitizeHtml(html: string): string {
  const strippedComments = html.replace(/<!--[\s\S]*?-->/g, "");
  const {document} = parseHTML(strippedComments);
  const allElements = Array.from(document.querySelectorAll("*")) as HtmlElementLike[];
  for (let index = allElements.length - 1; index >= 0; index -= 1) {
    const element = allElements[index];
    if (!element) {
      continue;
    }
    if (shouldRemoveElement(element)) {
      element.remove();
    }
  }

  return (document as unknown as {toString(): string}).toString();
}

function extractLinks(html: string, baseUrl: string): readonly WebFetchLink[] {
  const {document} = parseHTML(`<html><body>${html}</body></html>`);
  const links: WebFetchLink[] = [];
  const seen = new Set<string>();

  for (const anchor of document.querySelectorAll("a[href]")) {
    const href = trimNonEmptyString(anchor.getAttribute("href"));
    if (!href) {
      continue;
    }

    const absolute = absolutizeUrl(href, baseUrl);
    if (!absolute || seen.has(absolute)) {
      continue;
    }

    const text = normalizeWhitespace(stripInvisibleUnicode(anchor.textContent ?? "")) || absolute;
    seen.add(absolute);
    links.push({text, url: absolute});
    if (links.length >= 20) {
      break;
    }
  }

  return links;
}

export function extractReadableContentFromHtml(params: {
  html: string;
  url: string;
}): ReadableExtraction {
  const sanitizedHtml = sanitizeHtml(params.html);
  const metadataDocument = parseHTML(sanitizedHtml).document;
  const metadata = readPageMetadata(metadataDocument, params.url);
  const fallbackHtml = metadataDocument.body?.innerHTML ?? sanitizedHtml;

  let readableHtml = fallbackHtml;
  let readableTitle = metadata.title;
  let readableDescription = metadata.description;
  let readableSiteName = metadata.siteName;

  if (sanitizedHtml.length <= MAX_HTML_CHARS_FOR_READABILITY) {
    const {document} = parseHTML(sanitizedHtml);
    try {
      (document as {baseURI?: string}).baseURI = params.url;
    } catch {
      // Best effort for relative links inside readability output.
    }

    const article = new Readability(document, {charThreshold: 0}).parse();
    if (article?.content) {
      readableHtml = article.content;
      readableTitle = trimNonEmptyString(article.title) ?? readableTitle;
      readableDescription = trimNonEmptyString(article.excerpt) ?? readableDescription;
      readableSiteName = trimNonEmptyString(article.siteName) ?? readableSiteName;
    }
  }

  const content = htmlToMarkdown(readableHtml, params.url);
  if (!content) {
    throw new ToolError("web_fetch could not extract any readable content from the page.");
  }

  return {
    title: readableTitle,
    description: readableDescription,
    siteName: readableSiteName,
    content,
    links: extractLinks(readableHtml, params.url),
  };
}

function formatHttpError(status: number, statusText: string, detail: string): string {
  const prefix = `web_fetch failed with HTTP ${status}${statusText ? ` ${statusText}` : ""}`;
  return detail ? `${prefix}: ${detail}` : prefix;
}

export async function fetchReadableWebPage(
  url: string,
  options: FetchReadableWebPageOptions = {},
): Promise<FetchReadableWebPageResult> {
  const lookupHostname = options.lookupHostname ?? defaultLookupHostname;
  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? DEFAULT_WEB_FETCH_TIMEOUT_MS));
  const maxRedirects = Math.max(0, Math.floor(options.maxRedirects ?? DEFAULT_WEB_FETCH_MAX_REDIRECTS));
  const maxResponseBytes = Math.max(
    1,
    Math.floor(options.maxResponseBytes ?? DEFAULT_WEB_FETCH_MAX_RESPONSE_BYTES),
  );
  const maxContentChars = Math.max(
    1,
    Math.floor(options.maxContentChars ?? DEFAULT_WEB_FETCH_MAX_CONTENT_CHARS),
  );
  const userAgent = trimNonEmptyString(options.userAgent) ?? DEFAULT_WEB_FETCH_USER_AGENT;

  let currentUrl: URL;
  try {
    currentUrl = new URL(url);
  } catch {
    throw new ToolError("web_fetch requires a valid URL.");
  }

  options.onProgress?.({
    status: "validating",
    url: currentUrl.toString(),
  });

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  const requestHeaders = {
    "accept-encoding": DEFAULT_ACCEPT_ENCODING,
    "accept-language": DEFAULT_ACCEPT_LANGUAGE,
    "user-agent": userAgent,
  };

  try {
    let redirectCount = 0;
    let response: FetchedResponse | null = null;

    while (true) {
      const safeTarget = await resolveSafeTarget(currentUrl, lookupHostname);
      options.onProgress?.({
        status: "fetching",
        url: currentUrl.toString(),
        redirectCount,
      });

      response = options.fetchImpl
        ? await fetchWithCustomImpl(currentUrl, {
            fetchImpl: options.fetchImpl,
            headers: requestHeaders,
            signal,
            maxBytes: maxResponseBytes,
          })
        : await fetchWithPinnedLookup(currentUrl, {
            lookup: safeTarget.lookup,
            headers: requestHeaders,
            signal,
            maxBytes: maxResponseBytes,
          });

      if (!isRedirectStatus(response.status)) {
        break;
      }

      const location = trimNonEmptyString(response.headers.get("location"));
      if (!location) {
        throw new ToolError(`web_fetch received redirect ${response.status} without a Location header.`);
      }

      if (redirectCount >= maxRedirects) {
        throw new ToolError(`web_fetch exceeded the redirect limit of ${maxRedirects}.`);
      }

      currentUrl = new URL(location, currentUrl);
      redirectCount += 1;
    }

    if (!response) {
      throw new ToolError("web_fetch did not receive a response.");
    }

    if (response.status < 200 || response.status >= 300) {
      const detail = sanitizeErrorSnippet(response.bodyText.slice(0, MAX_ERROR_BYTES));
      throw new ToolError(formatHttpError(response.status, response.statusText, detail));
    }

    const body = response.bodyText;
    const contentType = parseBaseContentType(response.headers.get("content-type"));
    if (contentType !== "text/html" && !looksLikeHtml(body)) {
      throw new ToolError(
        `web_fetch only supports HTML pages right now (got ${contentType ?? "unknown"}).`,
      );
    }

    options.onProgress?.({
      status: "extracting",
      url,
      finalUrl: currentUrl.toString(),
    });

    const extracted = extractReadableContentFromHtml({
      html: body,
      url: currentUrl.toString(),
    });
    const truncated = truncateText(extracted.content, maxContentChars);

    return {
      url,
      finalUrl: currentUrl.toString(),
      status: response.status,
      contentType: contentType ?? null,
      title: extracted.title ?? null,
      description: extracted.description ?? null,
      siteName: extracted.siteName ?? null,
      truncated: truncated.truncated,
      links: extracted.links,
      content: truncated.text,
    };
  } catch (error) {
    if (options.signal?.aborted) {
      throw new ToolError("web_fetch was aborted.");
    }
    if (timeoutSignal.aborted) {
      throw new ToolError(`web_fetch timed out after ${timeoutMs}ms.`);
    }
    if (error instanceof ToolError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new ToolError(`web_fetch failed: ${message}`);
  }
}

export {
  DEFAULT_WEB_FETCH_MAX_CONTENT_CHARS,
  DEFAULT_WEB_FETCH_MAX_REDIRECTS,
  DEFAULT_WEB_FETCH_MAX_RESPONSE_BYTES,
  DEFAULT_WEB_FETCH_TIMEOUT_MS,
  DEFAULT_WEB_FETCH_USER_AGENT,
};
