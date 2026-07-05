import * as http from "node:http";
import * as https from "node:https";

import {ToolError} from "../../kernel/agent/exceptions.js";
import {trimToUndefined, truncateTextWithStatus} from "../../lib/strings.js";
import {
    extractReadableContentFromHtml,
    looksLikeHtml,
    sanitizeHtmlTextSnippet,
    type WebFetchLink,
} from "./html-content.js";
import {
    defaultLookupHostname,
    type LookupHostname,
    type PinnedLookup,
    resolveSafeHttpTarget,
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
type WebFetchProgressStatus = "validating" | "fetching" | "extracting";
type WebFetchProgress = {
  status: WebFetchProgressStatus;
  url?: string;
  finalUrl?: string;
  redirectCount?: number;
};

export type FetchImpl = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface FetchReadableWebPageOptions {
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

interface FetchReadableWebPageResult {
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

interface FetchSafeHttpResourceOptions {
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

interface FetchSafeHttpResourceResult {
  url: string;
  finalUrl: string;
  status: number;
  statusText: string;
  contentType: string | null;
  headers: Headers;
  bodyText: string;
}

type FetchedResponse = {
  status: number;
  statusText: string;
  headers: Headers;
  bodyText: string;
};

function parseBaseContentType(value: string | null): string | undefined {
  const [rawType] = value?.split(";") ?? [];
  return trimToUndefined(rawType)?.toLowerCase();
}

function parseCharset(value: string | null): string | undefined {
  const match = /charset\s*=\s*("?)([^";]+)\1/i.exec(value ?? "");
  return trimToUndefined(match?.[2]);
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

function isRedirectStatus(status: number): boolean {
  return status === 301
    || status === 302
    || status === 303
    || status === 307
    || status === 308;
}

function carriesCallerControlledRequestState(input: {
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
}): boolean {
  return input.method !== "GET"
    || input.body !== undefined
    || Object.keys(input.headers ?? {}).length > 0;
}

function isSameOrigin(left: URL, right: URL): boolean {
  return left.origin.toLowerCase() === right.origin.toLowerCase();
}

function assertRedirectKeepsCallerStatePrivate(input: {
  currentUrl: URL;
  nextUrl: URL;
  carriesCallerState: boolean;
}): void {
  if (!input.carriesCallerState || isSameOrigin(input.currentUrl, input.nextUrl)) {
    return;
  }

  throw new ToolError(
    "web.fetch blocked a cross-origin redirect for a request with custom headers, method, or body.",
  );
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
      lookup: params.lookup,
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
          `web.fetch response exceeded the ${params.maxBytes} byte limit before reading the body.`,
        ));
        return;
      }

      const chunks: Buffer[] = [];
      let totalBytes = 0;

      response.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buffer.byteLength;
        if (totalBytes > params.maxBytes) {
          response.destroy(new ToolError(`web.fetch response exceeded the ${params.maxBytes} byte limit.`));
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
      `web.fetch response exceeded the ${maxBytes} byte limit before reading the body.`,
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
      throw new ToolError(`web.fetch response exceeded the ${maxBytes} byte limit.`);
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

function formatHttpError(status: number, statusText: string, detail: string): string {
  const prefix = `web.fetch failed with HTTP ${status}${statusText ? ` ${statusText}` : ""}`;
  return detail ? `${prefix}: ${detail}` : prefix;
}

/** Fetches an HTTP resource through safe-target validation, DNS pinning, redirect checks, and byte limits. */
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
  const userAgent = trimToUndefined(options.userAgent) ?? DEFAULT_WEB_FETCH_USER_AGENT;
  const method = options.method ?? "GET";
  const carriesCallerState = carriesCallerControlledRequestState({
    method,
    headers: options.headers,
    body: options.body,
  });

  let currentUrl: URL;
  try {
    currentUrl = new URL(url);
  } catch {
    throw new ToolError("web.fetch requires a valid URL.");
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
      const safeTarget = await resolveSafeHttpTarget(currentUrl, lookupHostname, "web.fetch");
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

      const location = trimToUndefined(response.headers.get("location"));
      if (!location) {
        throw new ToolError(`web.fetch received redirect ${response.status} without a Location header.`);
      }

      if (redirectCount >= maxRedirects) {
        throw new ToolError(`web.fetch exceeded the redirect limit of ${maxRedirects}.`);
      }

      const nextUrl = new URL(location, currentUrl);
      assertRedirectKeepsCallerStatePrivate({
        currentUrl,
        nextUrl,
        carriesCallerState,
      });

      currentUrl = nextUrl;
      redirectCount += 1;
    }

    if (!response) {
      throw new ToolError("web.fetch did not receive a response.");
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
      throw new ToolError("web.fetch was aborted.");
    }
    if (timeoutSignal.aborted) {
      throw new ToolError(`web.fetch timed out after ${timeoutMs}ms.`);
    }
    if (error instanceof ToolError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new ToolError(`web.fetch failed: ${message}`);
  }
}

/** Fetches a public HTML page and returns the readable page payload used by web.fetch and watch probes. */
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
  const userAgent = trimToUndefined(options.userAgent) ?? DEFAULT_WEB_FETCH_USER_AGENT;

  let currentUrl: URL;
  try {
    currentUrl = new URL(url);
  } catch {
    throw new ToolError("web.fetch requires a valid URL.");
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
      const detail = sanitizeHtmlTextSnippet(response.bodyText.slice(0, MAX_ERROR_BYTES));
      throw new ToolError(formatHttpError(response.status, response.statusText, detail));
    }

    const body = response.bodyText;
    const contentType = parseBaseContentType(response.contentType);
    if (contentType !== "text/html" && !looksLikeHtml(body)) {
      throw new ToolError(
        `web.fetch only supports HTML pages right now (got ${contentType ?? "unknown"}).`,
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
    const truncated = truncateTextWithStatus(extracted.content, maxContentChars);

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
    throw new ToolError(`web.fetch failed: ${message}`);
  }
}

export {
  DEFAULT_WEB_FETCH_MAX_CONTENT_CHARS,
  DEFAULT_WEB_FETCH_MAX_REDIRECTS,
  DEFAULT_WEB_FETCH_MAX_RESPONSE_BYTES,
  DEFAULT_WEB_FETCH_TIMEOUT_MS,
  DEFAULT_WEB_FETCH_USER_AGENT,
};
