import * as http from "node:http";
import * as https from "node:https";

import {Readability} from "@mozilla/readability";
import {parseHTML} from "linkedom";

import {ToolError} from "../../../kernel/agent/exceptions.js";
import {
    defaultLookupHostname,
    type LookupHostname,
    type PinnedLookup,
    resolveSafeHttpTarget,
    trimNonEmptyString,
} from "./safe-web-target.js";

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

export type {LookupHostname} from "./safe-web-target.js";
export {createPinnedLookup} from "./safe-web-target.js";

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

export interface FetchSafeHttpResourceOptions {
  fetchImpl?: FetchImpl;
  lookupHostname?: LookupHostname;
  timeoutMs?: number;
  maxRedirects?: number;
  maxResponseBytes?: number;
  userAgent?: string;
  signal?: AbortSignal;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
}

export interface FetchSafeHttpResourceResult {
  url: string;
  finalUrl: string;
  status: number;
  statusText: string;
  contentType: string | null;
  headers: Headers;
  bodyText: string;
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
    method: "GET" | "POST";
    body?: string;
  },
): Promise<FetchedResponse> {
  const response = await params.fetchImpl(url, {
    method: params.method,
    redirect: "manual",
    headers: toHeaders(params.headers),
    body: params.body,
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
    method: "GET" | "POST";
    body?: string;
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
      method: params.method,
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
    if (params.body) {
      request.write(params.body);
    }
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

export async function fetchSafeHttpResource(
  url: string,
  options: FetchSafeHttpResourceOptions = {},
): Promise<FetchSafeHttpResourceResult> {
  const lookupHostname = options.lookupHostname ?? defaultLookupHostname;
  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? DEFAULT_WEB_FETCH_TIMEOUT_MS));
  const maxRedirects = Math.max(0, Math.floor(options.maxRedirects ?? DEFAULT_WEB_FETCH_MAX_REDIRECTS));
  const maxResponseBytes = Math.max(
    1,
    Math.floor(options.maxResponseBytes ?? DEFAULT_WEB_FETCH_MAX_RESPONSE_BYTES),
  );
  const userAgent = trimNonEmptyString(options.userAgent) ?? DEFAULT_WEB_FETCH_USER_AGENT;
  const method = options.method ?? "GET";

  let currentUrl: URL;
  try {
    currentUrl = new URL(url);
  } catch {
    throw new ToolError("web_fetch requires a valid URL.");
  }

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  const requestHeaders = {
    "accept-encoding": DEFAULT_ACCEPT_ENCODING,
    "accept-language": DEFAULT_ACCEPT_LANGUAGE,
    "user-agent": userAgent,
    ...(options.headers ?? {}),
  };

  try {
    let redirectCount = 0;
    let response: FetchedResponse | null = null;

    while (true) {
      const safeTarget = await resolveSafeHttpTarget(currentUrl, lookupHostname, "web_fetch");
      response = options.fetchImpl
        ? await fetchWithCustomImpl(currentUrl, {
            fetchImpl: options.fetchImpl,
            headers: requestHeaders,
            signal,
            maxBytes: maxResponseBytes,
            method,
            body: options.body,
          })
        : await fetchWithPinnedLookup(currentUrl, {
            lookup: safeTarget.lookup,
            headers: requestHeaders,
            signal,
            maxBytes: maxResponseBytes,
            method,
            body: options.body,
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

    return {
      url,
      finalUrl: currentUrl.toString(),
      status: response.status,
      statusText: response.statusText,
      contentType: response.headers.get("content-type"),
      headers: response.headers,
      bodyText: response.bodyText,
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

  try {
    options.onProgress?.({
      status: "fetching",
      url: currentUrl.toString(),
      redirectCount: 0,
    });

    const response = await fetchSafeHttpResource(url, {
      fetchImpl: options.fetchImpl,
      lookupHostname,
      timeoutMs,
      maxRedirects,
      maxResponseBytes,
      userAgent,
      signal: options.signal,
    });
    currentUrl = new URL(response.finalUrl);

    if (response.status < 200 || response.status >= 300) {
      const detail = sanitizeErrorSnippet(response.bodyText.slice(0, MAX_ERROR_BYTES));
      throw new ToolError(formatHttpError(response.status, response.statusText, detail));
    }

    const body = response.bodyText;
    const contentType = parseBaseContentType(response.contentType);
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
