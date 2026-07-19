import {ToolError} from "../../kernel/agent/exceptions.js";
import {isJsonObject, type JsonObject} from "../../lib/json.js";
import {trimToNull} from "../../lib/strings.js";
import {
  BraveThrottleGate,
  type BraveRateLimitFailureCode,
  type BraveThrottlePermit,
} from "./brave-throttle.js";

export const BRAVE_WEB_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
export const BRAVE_NEWS_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/news/search";
export const BRAVE_VIDEO_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/videos/search";
export const BRAVE_IMAGE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/images/search";
export const BRAVE_LLM_CONTEXT_ENDPOINT = "https://api.search.brave.com/res/v1/llm/context";
export const BRAVE_PLACE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/local/place_search";
export const BRAVE_PLACE_POIS_ENDPOINT = "https://api.search.brave.com/res/v1/local/pois";
export const BRAVE_PLACE_DESCRIPTIONS_ENDPOINT = "https://api.search.brave.com/res/v1/local/descriptions";
export const BRAVE_SEARCH_ENDPOINT = BRAVE_WEB_SEARCH_ENDPOINT;
export const DEFAULT_BRAVE_SEARCH_COUNT = 5;
export const MAX_BRAVE_WEB_SEARCH_COUNT = 20;
export const MAX_BRAVE_NEWS_SEARCH_COUNT = 50;
export const MAX_BRAVE_VIDEO_SEARCH_COUNT = 50;
export const MAX_BRAVE_IMAGE_SEARCH_COUNT = 200;
export const MAX_BRAVE_LLM_CONTEXT_COUNT = 50;
export const MAX_BRAVE_PLACE_SEARCH_COUNT = 100;
export const MAX_BRAVE_PLACE_DETAIL_IDS = 20;
export const MAX_BRAVE_SEARCH_COUNT = 10;
export const DEFAULT_BRAVE_SEARCH_TIMEOUT_MS = 10_000;
export const DEFAULT_BRAVE_RETRY_BUDGET_MS = 15_000;
export const MAX_BRAVE_PHYSICAL_ATTEMPTS = 3;

const MIN_BRAVE_QUOTA_WINDOW_MS = 24 * 60 * 60 * 1_000;
const BRAVE_COUNTRY_CODES = new Set([
  "AR",
  "AU",
  "AT",
  "BE",
  "BR",
  "CA",
  "CL",
  "DK",
  "FI",
  "FR",
  "DE",
  "GR",
  "HK",
  "IN",
  "ID",
  "IT",
  "JP",
  "KR",
  "MY",
  "MX",
  "NL",
  "NZ",
  "NO",
  "CN",
  "PL",
  "PT",
  "PH",
  "RU",
  "SA",
  "ZA",
  "ES",
  "SE",
  "CH",
  "TW",
  "TR",
  "GB",
  "US",
  "ALL",
]);
const BRAVE_SEARCH_LANG_CODES = new Set([
  "ar",
  "eu",
  "bn",
  "bg",
  "ca",
  "zh-hans",
  "zh-hant",
  "hr",
  "cs",
  "da",
  "nl",
  "en",
  "en-gb",
  "et",
  "fi",
  "fr",
  "gl",
  "de",
  "el",
  "gu",
  "he",
  "hi",
  "hu",
  "is",
  "it",
  "jp",
  "kn",
  "ko",
  "lv",
  "lt",
  "ms",
  "ml",
  "mr",
  "nb",
  "pl",
  "pt-br",
  "pt-pt",
  "pa",
  "ro",
  "ru",
  "sr",
  "sk",
  "sl",
  "es",
  "sv",
  "ta",
  "te",
  "th",
  "tr",
  "uk",
  "vi",
]);
const BRAVE_SEARCH_LANG_ALIASES: Record<string, string> = {
  ja: "jp",
  zh: "zh-hans",
  "zh-cn": "zh-hans",
  "zh-hk": "zh-hant",
  "zh-sg": "zh-hans",
  "zh-tw": "zh-hant",
};

export type BraveSearchFreshness = "pd" | "pw" | "pm" | "py" | `${number}-${number}-${number}to${number}-${number}-${number}`;
export type BraveSearchSafeSearch = "off" | "moderate" | "strict";
export type BraveLlmContextThresholdMode = "strict" | "balanced" | "lenient" | "disabled";
export type FetchImpl = typeof fetch;

type BraveSearchApiResult = {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
  extra_snippets?: string[];
  thumbnail?: {
    src?: string;
  };
  meta_url?: {
    hostname?: string;
    path?: string;
  };
};

type BraveWebSearchResponse = {
  web?: {
    results?: BraveSearchApiResult[];
  };
  query?: {
    more_results_available?: boolean;
  };
};

type BraveNewsSearchResponse = {
  results?: BraveSearchApiResult[];
  news?: {
    results?: BraveSearchApiResult[];
  };
  query?: {
    more_results_available?: boolean;
  };
};

type BraveImageApiResult = BraveSearchApiResult & {
  source?: string;
  page_url?: string;
  properties?: {
    url?: string;
    placeholder?: string;
    width?: number;
    height?: number;
  };
};

type BraveMediaSearchResponse = {
  results?: BraveSearchApiResult[];
  videos?: {
    results?: BraveSearchApiResult[];
  };
  images?: {
    results?: BraveImageApiResult[];
  };
  query?: {
    more_results_available?: boolean;
  };
};

type BravePlaceApiResult = {
  id?: string;
  title?: string;
  name?: string;
  url?: string;
  provider_url?: string;
  description?: string;
  coordinates?: number[];
  postal_address?: unknown;
  rating?: unknown;
  reviews?: unknown;
  distance?: unknown;
  categories?: unknown;
  price_range?: string;
  opening_hours?: unknown;
  contact?: unknown;
  thumbnail?: {
    src?: string;
  };
};

type BravePlaceSearchResponse = {
  type?: string;
  query?: JsonObject;
  results?: BravePlaceApiResult[];
  cities?: unknown[];
  addresses?: unknown[];
  streets?: unknown[];
  mixed?: unknown[];
  location?: unknown;
};

export interface BraveSearchInput {
  query: string;
  count?: number;
  country?: string;
  freshness?: BraveSearchFreshness;
  offset?: number;
  safesearch?: BraveSearchSafeSearch;
  search_lang?: string;
  ui_lang?: string;
  extra_snippets?: boolean;
  goggles?: string;
  spellcheck?: boolean;
}

export interface BraveLlmContextInput extends BraveSearchInput {
  maximum_number_of_urls?: number;
  maximum_number_of_tokens?: number;
  maximum_number_of_snippets?: number;
  maximum_number_of_tokens_per_url?: number;
  maximum_number_of_snippets_per_url?: number;
  context_threshold_mode?: BraveLlmContextThresholdMode;
  enable_local?: boolean;
}

export interface BraveSearchOptions {
  apiKey?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
  defaultCount?: number;
  signal?: AbortSignal;
  now?: () => number;
  random?: () => number;
  retryBudgetMs?: number;
  throttleGate?: BraveThrottleGate;
}

export interface BraveAttemptMetadata {
  attemptCount: number;
  totalBackoffMs: number;
}

const braveAttemptMetadata = new WeakMap<object, BraveAttemptMetadata>();

/** Reads internal retry telemetry without adding it to the model-visible result. */
export function readBraveAttemptMetadata(result: object): BraveAttemptMetadata | undefined {
  return braveAttemptMetadata.get(result);
}

export interface BraveSearchResult extends JsonObject {
  provider: "brave";
  vertical: "web" | "news" | "video" | "image";
  query: string;
  country: string | null;
  freshness: BraveSearchFreshness | null;
  elapsedMs: number;
  moreResultsAvailable: boolean | null;
  resultCount: number;
  safesearch: BraveSearchSafeSearch | null;
  search_lang: string | null;
  results: JsonObject[];
}

export interface BravePlaceSearchInput {
  query?: string;
  count?: number;
  country?: string;
  location?: string;
  latitude?: number;
  longitude?: number;
  radius?: number;
  safesearch?: BraveSearchSafeSearch;
  search_lang?: string;
  ui_lang?: string;
  spellcheck?: boolean;
  units?: "metric" | "imperial";
}

export interface BravePlaceDetailsInput {
  ids: string[];
}

export interface BravePlaceSearchResult extends JsonObject {
  provider: "brave";
  vertical: "place";
  query: string | null;
  country: string | null;
  elapsedMs: number;
  locationInput: string | null;
  latitude: number | null;
  longitude: number | null;
  radius: number | null;
  resultCount: number;
  cityCount: number;
  addressCount: number;
  streetCount: number;
  search_lang: string | null;
  safesearch: BraveSearchSafeSearch | null;
  places: JsonObject[];
  cities: JsonObject[];
  addresses: JsonObject[];
  streets: JsonObject[];
  mixed: JsonObject[];
  location: JsonObject | null;
}

export interface BravePlaceDetailsResult extends JsonObject {
  provider: "brave";
  vertical: "place_poi" | "place_description";
  ids: string[];
  elapsedMs: number;
  resultCount: number;
  payload: JsonObject;
}

export interface BraveLlmContextResult extends JsonObject {
  provider: "brave";
  vertical: "llm_context";
  query: string;
  country: string | null;
  freshness: BraveSearchFreshness | null;
  elapsedMs: number;
  search_lang: string | null;
  resultCount: number;
  grounding: JsonObject;
  sources: JsonObject;
}

function resolveSiteName(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

export function normalizeBraveCountry(value: string | undefined): string | undefined {
  const trimmed = trimToNull(value);
  if (!trimmed) {
    return undefined;
  }

  const canonical = trimmed.toUpperCase();
  return BRAVE_COUNTRY_CODES.has(canonical) ? canonical : "ALL";
}

export function normalizeBraveSearchLang(value: string | undefined): string | undefined {
  const trimmed = trimToNull(value);
  if (!trimmed) {
    return undefined;
  }

  const canonical = BRAVE_SEARCH_LANG_ALIASES[trimmed.toLowerCase()] ?? trimmed.toLowerCase();
  if (!BRAVE_SEARCH_LANG_CODES.has(canonical)) {
    return undefined;
  }

  return canonical;
}

export function normalizeBraveFreshness(value: string | undefined): BraveSearchFreshness | undefined {
  const trimmed = trimToNull(value);
  if (!trimmed) {
    return undefined;
  }

  const normalized = trimmed.toLowerCase();
  const aliases: Record<string, BraveSearchFreshness> = {
    day: "pd",
    week: "pw",
    month: "pm",
    year: "py",
  };
  if (normalized === "pd" || normalized === "pw" || normalized === "pm" || normalized === "py") {
    return normalized;
  }
  if (aliases[normalized]) {
    return aliases[normalized];
  }
  if (/^\d{4}-\d{2}-\d{2}to\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return normalized as BraveSearchFreshness;
  }

  return undefined;
}

function normalizeBraveSafeSearch(value: string | undefined): BraveSearchSafeSearch | undefined {
  const trimmed = trimToNull(value);
  if (!trimmed) {
    return undefined;
  }

  const normalized = trimmed.toLowerCase();
  if (normalized === "off" || normalized === "moderate" || normalized === "strict") {
    return normalized;
  }

  return undefined;
}

function normalizeThresholdMode(value: string | undefined): BraveLlmContextThresholdMode | undefined {
  const trimmed = trimToNull(value);
  if (!trimmed) {
    return undefined;
  }

  const normalized = trimmed.toLowerCase();
  if (normalized === "strict" || normalized === "balanced" || normalized === "lenient" || normalized === "disabled") {
    return normalized;
  }

  return undefined;
}

function normalizePlaceUnits(value: string | undefined): "metric" | "imperial" | undefined {
  const trimmed = trimToNull(value);
  if (!trimmed) {
    return undefined;
  }

  const normalized = trimmed.toLowerCase();
  if (normalized === "metric" || normalized === "imperial") {
    return normalized;
  }

  return undefined;
}

export function hasBraveSearchApiKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return trimToNull(env.BRAVE_API_KEY) !== null;
}

function resolveApiKey(options: BraveSearchOptions): string {
  const apiKey = trimToNull(options.apiKey) ?? trimToNull((options.env ?? process.env).BRAVE_API_KEY);
  if (!apiKey) {
    throw new ToolError("BRAVE_API_KEY is not configured.");
  }

  return apiKey;
}

function normalizeCommonSearchInput(
  input: BraveSearchInput,
): BraveSearchInput & {
  country?: string;
  freshness?: BraveSearchFreshness;
  safesearch?: BraveSearchSafeSearch;
  search_lang?: string;
} {
  const country = normalizeBraveCountry(input.country);
  const searchLang = normalizeBraveSearchLang(input.search_lang);
  if (input.search_lang && !searchLang) {
    throw new ToolError(
      "search_lang must be a Brave-supported language code like 'en', 'en-gb', 'zh-hans', or 'zh-hant'.",
    );
  }
  const freshness = normalizeBraveFreshness(input.freshness);
  if (input.freshness && !freshness) {
    throw new ToolError("freshness must be pd, pw, pm, py, day, week, month, year, or YYYY-MM-DDtoYYYY-MM-DD.");
  }
  const safesearch = normalizeBraveSafeSearch(input.safesearch);
  if (input.safesearch && !safesearch) {
    throw new ToolError("safesearch must be off, moderate, or strict.");
  }

  return {
    ...input,
    ...(country ? {country} : {}),
    ...(freshness ? {freshness} : {}),
    ...(safesearch ? {safesearch} : {}),
    ...(searchLang ? {search_lang: searchLang} : {}),
  };
}

function boundedCount(value: number | undefined, defaultCount: number, maxCount: number): number {
  const candidate = value ?? defaultCount;
  if (!Number.isFinite(candidate)) {
    return defaultCount;
  }

  return Math.max(1, Math.min(maxCount, Math.trunc(candidate)));
}

function maybeSetNumberParam(url: URL, name: string, value: number | undefined, range: {min: number; max: number}): void {
  if (value === undefined) {
    return;
  }
  if (!Number.isFinite(value)) {
    throw new ToolError(`${name} must be a finite number.`);
  }

  const integer = Math.trunc(value);
  if (integer < range.min || integer > range.max) {
    throw new ToolError(`${name} must be between ${range.min} and ${range.max}.`);
  }

  url.searchParams.set(name, String(integer));
}

function buildSearchUrl(
  endpoint: string,
  input: BraveSearchInput,
  options: BraveSearchOptions & {
    maxCount: number;
    includeFreshness?: boolean;
    includeOffset?: boolean;
    includeExtraSnippets?: boolean;
    includeGoggles?: boolean;
  },
): {url: URL; normalized: ReturnType<typeof normalizeCommonSearchInput>} {
  const normalized = normalizeCommonSearchInput(input);
  const defaultCount = Math.max(
    1,
    Math.min(options.maxCount, options.defaultCount ?? DEFAULT_BRAVE_SEARCH_COUNT),
  );
  const url = new URL(endpoint);
  url.searchParams.set("q", normalized.query);
  url.searchParams.set("count", String(boundedCount(normalized.count, defaultCount, options.maxCount)));
  if (normalized.country) {
    url.searchParams.set("country", normalized.country);
  }
  if (normalized.freshness && options.includeFreshness !== false) {
    url.searchParams.set("freshness", normalized.freshness);
  }
  if (normalized.offset !== undefined && options.includeOffset !== false) {
    maybeSetNumberParam(url, "offset", normalized.offset, {min: 0, max: 9});
  }
  if (normalized.safesearch) {
    url.searchParams.set("safesearch", normalized.safesearch);
  }
  if (normalized.search_lang) {
    url.searchParams.set("search_lang", normalized.search_lang);
  }
  if (normalized.ui_lang) {
    url.searchParams.set("ui_lang", normalized.ui_lang);
  }
  if (normalized.extra_snippets === true && options.includeExtraSnippets !== false) {
    url.searchParams.set("extra_snippets", "true");
  }
  if (normalized.goggles && options.includeGoggles !== false) {
    url.searchParams.set("goggles", normalized.goggles);
  }
  if (normalized.spellcheck !== undefined) {
    url.searchParams.set("spellcheck", String(normalized.spellcheck));
  }

  return {url, normalized};
}

interface BraveRateLimitResponse {
  retryable: boolean;
  retryAfterMs?: number;
  failureCode: BraveRateLimitFailureCode;
}

interface BraveRateLimitErrorDetails extends JsonObject {
  provider: "brave";
  status: 429;
  failureCode: BraveRateLimitFailureCode;
  retryable: boolean;
  retryAfterMs: number;
  attemptCount: number;
  totalBackoffMs: number;
  autoRetryExhausted: true;
}

class BraveRateLimitError extends ToolError {
  readonly pandaCommandErrorCode = "rate_limited" as const;
  readonly pandaCommandErrorDetails: BraveRateLimitErrorDetails;

  constructor(details: BraveRateLimitErrorDetails) {
    super(details.retryable
      ? "Brave Search remained rate limited after bounded retries."
      : "Brave Search quota is exhausted.");
    this.pandaCommandErrorDetails = details;
  }
}

function parsePositiveDelayMs(value: string | null, now: () => number): number | undefined {
  if (!value) {
    return undefined;
  }
  if (/^\d+$/.test(value.trim())) {
    const milliseconds = Number(value.trim()) * 1_000;
    return Number.isSafeInteger(milliseconds) && milliseconds > 0 ? milliseconds : undefined;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return undefined;
  }
  const milliseconds = Math.ceil(timestamp - now());
  return milliseconds > 0 ? milliseconds : undefined;
}

function parseCsvNumbers(value: string | null): Array<number | undefined> {
  return value?.split(",").map((entry) => {
    const parsed = Number(entry.trim());
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  }) ?? [];
}

function parsePolicyWindowsMs(value: string | null): Array<number | undefined> {
  return value?.split(",").map((entry) => {
    const match = /(?:^|;)\s*w=(\d+)\s*(?:;|$)/i.exec(entry.trim());
    const seconds = match?.[1] ? Number(match[1]) : Number.NaN;
    const milliseconds = seconds * 1_000;
    return Number.isSafeInteger(milliseconds) && milliseconds > 0 ? milliseconds : undefined;
  }) ?? [];
}

function readBraveRateLimitResponse(headers: Headers, now: () => number): BraveRateLimitResponse {
  const retryAfterMs = parsePositiveDelayMs(headers.get("retry-after"), now);
  const remaining = parseCsvNumbers(headers.get("x-ratelimit-remaining"));
  const resetsMs = parseCsvNumbers(headers.get("x-ratelimit-reset"))
    .map((seconds) => seconds === undefined ? undefined : Math.ceil(seconds * 1_000));
  const policyWindowsMs = parsePolicyWindowsMs(headers.get("x-ratelimit-policy"));
  const exhaustedIndices = remaining.flatMap((value, index) => value === 0 ? [index] : []);
  const quotaExhausted = exhaustedIndices.some((index) => (
    (policyWindowsMs[index] ?? 0) >= MIN_BRAVE_QUOTA_WINDOW_MS
  ));
  const exhaustedResetMs = exhaustedIndices
    .map((index) => resetsMs[index])
    .filter((value): value is number => value !== undefined && value > 0);
  const documentedResetMs = exhaustedResetMs.length > 0
    ? Math.max(...exhaustedResetMs)
    : resetsMs.find((value): value is number => value !== undefined && value > 0);
  const providerMinimumMs = Math.max(retryAfterMs ?? 0, documentedResetMs ?? 0);

  return {
    retryable: !quotaExhausted,
    failureCode: quotaExhausted ? "quota_exhausted" : "rate_limited",
    ...(providerMinimumMs > 0 ? {retryAfterMs: providerMinimumMs} : {}),
  };
}

function equalJitterDelayMs(attemptIndex: number, random: () => number): number {
  const [minimum, maximum] = attemptIndex <= 0 ? [1_000, 2_000] : [4_000, 8_000];
  const sample = Math.max(0, Math.min(1, random()));
  return Math.round(minimum + ((maximum - minimum) * sample));
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The response is already terminal; body cleanup must not replace its safe error.
  }
}

function rateLimitError(input: {
  gate: BraveThrottleGate;
  attemptCount: number;
  totalBackoffMs: number;
  retryable: boolean;
  failureCode: BraveRateLimitFailureCode;
}): BraveRateLimitError {
  return new BraveRateLimitError({
    provider: "brave",
    status: 429,
    failureCode: input.failureCode,
    retryable: input.retryable,
    retryAfterMs: input.gate.retryAfterMs(),
    attemptCount: input.attemptCount,
    totalBackoffMs: input.totalBackoffMs,
    autoRetryExhausted: true,
  });
}

async function fetchBraveJson<TPayload>(
  url: URL,
  options: BraveSearchOptions,
): Promise<{payload: TPayload; elapsedMs: number; attemptMetadata: BraveAttemptMetadata}> {
  const apiKey = resolveApiKey(options);
  const timeoutMs = options.timeoutMs ?? DEFAULT_BRAVE_SEARCH_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const startedAt = now();
  const deadlineMs = startedAt + Math.max(1, options.retryBudgetMs ?? DEFAULT_BRAVE_RETRY_BUDGET_MS);
  const gate = options.throttleGate ?? new BraveThrottleGate({now});
  let attemptCount = 0;
  let totalBackoffMs = 0;

  for (let attemptIndex = 0; attemptIndex < MAX_BRAVE_PHYSICAL_ATTEMPTS; attemptIndex += 1) {
    let acquired;
    try {
      acquired = await gate.acquire({deadlineMs, signal: options.signal});
    } catch {
      throw new ToolError("Brave search was aborted.");
    }
    totalBackoffMs += acquired.allowed ? acquired.permit.waitedMs : acquired.waitedMs;
    if (!acquired.allowed) {
      throw rateLimitError({
        gate,
        attemptCount,
        totalBackoffMs,
        retryable: acquired.retryable,
        failureCode: acquired.failureCode,
      });
    }

    const permit: BraveThrottlePermit = acquired.permit;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
    attemptCount += 1;
    let response: Response;
    try {
      response = await (options.fetchImpl ?? fetch)(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": apiKey,
        },
        signal,
      });
    } catch (error) {
      gate.reportRequestFailure(permit);
      if (options.signal?.aborted) {
        throw new ToolError("Brave search was aborted.");
      }
      if (timeoutSignal.aborted) {
        throw new ToolError(`Brave search timed out after ${timeoutMs}ms.`);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new ToolError(`Brave search failed: ${message}`);
    }

    if (response.status !== 429) {
      gate.reportNonRateLimited(permit);
      if (!response.ok) {
        await discardResponseBody(response);
        throw new ToolError(`Brave Search API request failed with status ${response.status}.`);
      }
      return {
        payload: await response.json() as TPayload,
        elapsedMs: now() - startedAt,
        attemptMetadata: {attemptCount, totalBackoffMs},
      };
    }

    const rateLimit = readBraveRateLimitResponse(response.headers, now);
    await discardResponseBody(response);
    const retryAfterMs = rateLimit.retryAfterMs
      ?? equalJitterDelayMs(Math.min(attemptIndex, 1), random);
    gate.reportRateLimit({
      permit,
      retryAfterMs,
      retryable: rateLimit.retryable,
      failureCode: rateLimit.failureCode,
    });
    const remainingBudgetMs = Math.max(0, deadlineMs - now());
    if (
      !rateLimit.retryable
      || attemptCount >= MAX_BRAVE_PHYSICAL_ATTEMPTS
      || retryAfterMs > remainingBudgetMs
    ) {
      throw rateLimitError({
        gate,
        attemptCount,
        totalBackoffMs,
        retryable: rateLimit.retryable,
        failureCode: rateLimit.failureCode,
      });
    }
  }

  throw rateLimitError({
    gate,
    attemptCount,
    totalBackoffMs,
    retryable: true,
    failureCode: "rate_limited",
  });
}

function serializeSearchResult(result: BraveSearchApiResult): JsonObject {
  const resultUrl = result.url ?? "";
  return {
    title: result.title ?? "",
    url: resultUrl,
    snippet: result.description ?? "",
    siteName: result.meta_url?.hostname ?? (resultUrl ? resolveSiteName(resultUrl) ?? null : null),
    published: result.age ?? null,
    ...(Array.isArray(result.extra_snippets) ? {extraSnippets: result.extra_snippets} : {}),
    ...(result.thumbnail?.src ? {thumbnailUrl: result.thumbnail.src} : {}),
  } satisfies JsonObject;
}

function serializeImageResult(result: BraveImageApiResult): JsonObject {
  const serialized = serializeSearchResult(result);
  return {
    ...serialized,
    sourcePageUrl: result.page_url ?? result.url ?? null,
    originalImageUrl: result.properties?.url ?? result.url ?? null,
    placeholderUrl: result.properties?.placeholder ?? null,
    width: typeof result.properties?.width === "number" ? result.properties.width : null,
    height: typeof result.properties?.height === "number" ? result.properties.height : null,
  } satisfies JsonObject;
}

function serializeJsonArray(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isJsonObject) : [];
}

function serializePlaceResult(result: BravePlaceApiResult): JsonObject {
  return {
    id: result.id ?? "",
    title: result.title ?? result.name ?? "",
    url: result.url ?? null,
    providerUrl: result.provider_url ?? null,
    description: result.description ?? "",
    coordinates: Array.isArray(result.coordinates) ? result.coordinates : null,
    postalAddress: isJsonObject(result.postal_address) ? result.postal_address : null,
    rating: isJsonObject(result.rating) ? result.rating : null,
    reviews: isJsonObject(result.reviews) ? result.reviews : null,
    distance: isJsonObject(result.distance) ? result.distance : null,
    categories: Array.isArray(result.categories) ? result.categories : [],
    priceRange: result.price_range ?? null,
    openingHours: isJsonObject(result.opening_hours) ? result.opening_hours : null,
    contact: isJsonObject(result.contact) ? result.contact : null,
    ...(result.thumbnail?.src ? {thumbnailUrl: result.thumbnail.src} : {}),
  } satisfies JsonObject;
}

function serializeSearchResultPayload(input: {
  vertical: "web" | "news" | "video" | "image";
  normalized: ReturnType<typeof normalizeCommonSearchInput>;
  elapsedMs: number;
  results: readonly BraveSearchApiResult[];
  moreResultsAvailable?: boolean;
  serialize?: (result: BraveSearchApiResult) => JsonObject;
}): BraveSearchResult {
  return {
    provider: "brave",
    vertical: input.vertical,
    query: input.normalized.query,
    country: input.normalized.country ?? null,
    freshness: input.normalized.freshness ?? null,
    elapsedMs: input.elapsedMs,
    moreResultsAvailable: input.moreResultsAvailable ?? null,
    resultCount: input.results.length,
    safesearch: input.normalized.safesearch ?? null,
    search_lang: input.normalized.search_lang ?? null,
    results: input.results.map(input.serialize ?? serializeSearchResult),
  };
}

function attachBraveAttemptMetadata<T extends object>(
  result: T,
  metadata: BraveAttemptMetadata,
): T {
  braveAttemptMetadata.set(result, metadata);
  return result;
}

export async function searchBraveWeb(
  input: BraveSearchInput,
  options: BraveSearchOptions = {},
): Promise<BraveSearchResult> {
  const {url, normalized} = buildSearchUrl(BRAVE_WEB_SEARCH_ENDPOINT, input, {
    ...options,
    maxCount: MAX_BRAVE_WEB_SEARCH_COUNT,
  });
  const {payload, elapsedMs, attemptMetadata} = await fetchBraveJson<BraveWebSearchResponse>(url, options);
  const results = Array.isArray(payload.web?.results) ? payload.web.results : [];

  return attachBraveAttemptMetadata(serializeSearchResultPayload({
    vertical: "web",
    normalized,
    elapsedMs,
    results,
    moreResultsAvailable: payload.query?.more_results_available,
  }), attemptMetadata);
}

export async function searchBraveNews(
  input: BraveSearchInput,
  options: BraveSearchOptions = {},
): Promise<BraveSearchResult> {
  const {url, normalized} = buildSearchUrl(BRAVE_NEWS_SEARCH_ENDPOINT, input, {
    ...options,
    maxCount: MAX_BRAVE_NEWS_SEARCH_COUNT,
  });
  const {payload, elapsedMs, attemptMetadata} = await fetchBraveJson<BraveNewsSearchResponse>(url, options);
  const results = Array.isArray(payload.results)
    ? payload.results
    : Array.isArray(payload.news?.results)
      ? payload.news.results
      : [];

  return attachBraveAttemptMetadata(serializeSearchResultPayload({
    vertical: "news",
    normalized,
    elapsedMs,
    results,
    moreResultsAvailable: payload.query?.more_results_available,
  }), attemptMetadata);
}

export async function searchBraveVideo(
  input: BraveSearchInput,
  options: BraveSearchOptions = {},
): Promise<BraveSearchResult> {
  const {url, normalized} = buildSearchUrl(BRAVE_VIDEO_SEARCH_ENDPOINT, input, {
    ...options,
    maxCount: MAX_BRAVE_VIDEO_SEARCH_COUNT,
    includeExtraSnippets: false,
    includeGoggles: false,
  });
  const {payload, elapsedMs, attemptMetadata} = await fetchBraveJson<BraveMediaSearchResponse>(url, options);
  const results = Array.isArray(payload.results)
    ? payload.results
    : Array.isArray(payload.videos?.results)
      ? payload.videos.results
      : [];

  return attachBraveAttemptMetadata(serializeSearchResultPayload({
    vertical: "video",
    normalized,
    elapsedMs,
    results,
    moreResultsAvailable: payload.query?.more_results_available,
  }), attemptMetadata);
}

export async function searchBraveImage(
  input: BraveSearchInput,
  options: BraveSearchOptions = {},
): Promise<BraveSearchResult> {
  const {url, normalized} = buildSearchUrl(BRAVE_IMAGE_SEARCH_ENDPOINT, input, {
    ...options,
    maxCount: MAX_BRAVE_IMAGE_SEARCH_COUNT,
    includeFreshness: false,
    includeOffset: false,
    includeExtraSnippets: false,
    includeGoggles: false,
  });
  if (normalized.safesearch === "moderate") {
    throw new ToolError("brave.image.search safesearch must be off or strict.");
  }
  const {payload, elapsedMs, attemptMetadata} = await fetchBraveJson<BraveMediaSearchResponse>(url, options);
  const results = Array.isArray(payload.results)
    ? payload.results as BraveImageApiResult[]
    : Array.isArray(payload.images?.results)
      ? payload.images.results
      : [];

  return attachBraveAttemptMetadata(serializeSearchResultPayload({
    vertical: "image",
    normalized: {
      ...normalized,
      freshness: undefined,
      offset: undefined,
    },
    elapsedMs,
    results,
    moreResultsAvailable: payload.query?.more_results_available,
    serialize: (result) => serializeImageResult(result as BraveImageApiResult),
  }), attemptMetadata);
}

function normalizePlaceInput(input: BravePlaceSearchInput): BravePlaceSearchInput & {
  country?: string;
  safesearch?: BraveSearchSafeSearch;
  search_lang?: string;
  units?: "metric" | "imperial";
} {
  const query = trimToNull(input.query);
  const location = trimToNull(input.location);
  const country = normalizeBraveCountry(input.country);
  const searchLang = normalizeBraveSearchLang(input.search_lang);
  if (input.search_lang && !searchLang) {
    throw new ToolError(
      "search_lang must be a Brave-supported language code like 'en', 'en-gb', 'zh-hans', or 'zh-hant'.",
    );
  }
  const safesearch = normalizeBraveSafeSearch(input.safesearch);
  if (input.safesearch && !safesearch) {
    throw new ToolError("safesearch must be off, moderate, or strict.");
  }
  const units = normalizePlaceUnits(input.units);
  if (input.units && !units) {
    throw new ToolError("units must be metric or imperial.");
  }
  const hasLatitude = input.latitude !== undefined;
  const hasLongitude = input.longitude !== undefined;
  if (hasLatitude !== hasLongitude) {
    throw new ToolError("brave.place.search requires both latitude and longitude when using coordinates.");
  }
  if (input.latitude !== undefined && (!Number.isFinite(input.latitude) || input.latitude < -90 || input.latitude > 90)) {
    throw new ToolError("latitude must be between -90 and 90.");
  }
  if (input.longitude !== undefined && (!Number.isFinite(input.longitude) || input.longitude < -180 || input.longitude > 180)) {
    throw new ToolError("longitude must be between -180 and 180.");
  }
  if (input.radius !== undefined && (!Number.isFinite(input.radius) || input.radius <= 0)) {
    throw new ToolError("radius must be a positive number.");
  }
  if (!query && !location && (input.latitude === undefined || input.longitude === undefined)) {
    throw new ToolError("brave.place.search requires a query, --location, or --lat/--lon coordinates.");
  }

  return {
    ...input,
    ...(query ? {query} : {}),
    ...(location ? {location} : {}),
    ...(country ? {country} : {}),
    ...(safesearch ? {safesearch} : {}),
    ...(searchLang ? {search_lang: searchLang} : {}),
    ...(units ? {units} : {}),
  };
}

function buildPlaceSearchUrl(input: BravePlaceSearchInput, options: BraveSearchOptions): {url: URL; normalized: ReturnType<typeof normalizePlaceInput>} {
  const normalized = normalizePlaceInput(input);
  const url = new URL(BRAVE_PLACE_SEARCH_ENDPOINT);
  if (normalized.query) {
    url.searchParams.set("q", normalized.query);
  }
  url.searchParams.set("count", String(boundedCount(normalized.count, options.defaultCount ?? DEFAULT_BRAVE_SEARCH_COUNT, MAX_BRAVE_PLACE_SEARCH_COUNT)));
  if (normalized.country) {
    url.searchParams.set("country", normalized.country);
  }
  if (normalized.location) {
    url.searchParams.set("location", normalized.location);
  }
  if (normalized.latitude !== undefined) {
    url.searchParams.set("latitude", String(normalized.latitude));
  }
  if (normalized.longitude !== undefined) {
    url.searchParams.set("longitude", String(normalized.longitude));
  }
  if (normalized.radius !== undefined) {
    url.searchParams.set("radius", String(normalized.radius));
  }
  if (normalized.safesearch) {
    url.searchParams.set("safesearch", normalized.safesearch);
  }
  if (normalized.search_lang) {
    url.searchParams.set("search_lang", normalized.search_lang);
  }
  if (normalized.ui_lang) {
    url.searchParams.set("ui_lang", normalized.ui_lang);
  }
  if (normalized.spellcheck !== undefined) {
    url.searchParams.set("spellcheck", String(normalized.spellcheck));
  }
  if (normalized.units) {
    url.searchParams.set("units", normalized.units);
  }

  return {url, normalized};
}

function normalizePlaceIds(input: BravePlaceDetailsInput): string[] {
  const ids = input.ids.map((id) => id.trim()).filter(Boolean);
  if (ids.length === 0) {
    throw new ToolError("Place detail commands require at least one id.");
  }
  if (ids.length > MAX_BRAVE_PLACE_DETAIL_IDS) {
    throw new ToolError(`Place detail commands accept at most ${MAX_BRAVE_PLACE_DETAIL_IDS} ids.`);
  }

  return [...new Set(ids)];
}

function buildPlaceDetailsUrl(endpoint: string, ids: string[]): URL {
  const url = new URL(endpoint);
  for (const id of ids) {
    url.searchParams.append("ids", id);
  }
  return url;
}

function countPayloadResults(payload: JsonObject): number {
  for (const key of ["results", "pois", "descriptions"]) {
    const value = payload[key];
    if (Array.isArray(value)) {
      return value.length;
    }
  }

  return Object.keys(payload).length > 0 ? 1 : 0;
}

export async function searchBravePlace(
  input: BravePlaceSearchInput,
  options: BraveSearchOptions = {},
): Promise<BravePlaceSearchResult> {
  const {url, normalized} = buildPlaceSearchUrl(input, options);
  const {payload, elapsedMs, attemptMetadata} = await fetchBraveJson<BravePlaceSearchResponse>(url, options);
  const places = Array.isArray(payload.results) ? payload.results.map(serializePlaceResult) : [];
  const cities = serializeJsonArray(payload.cities);
  const addresses = serializeJsonArray(payload.addresses);
  const streets = serializeJsonArray(payload.streets);
  const mixed = serializeJsonArray(payload.mixed);

  return attachBraveAttemptMetadata({
    provider: "brave",
    vertical: "place",
    query: normalized.query ?? null,
    country: normalized.country ?? null,
    elapsedMs,
    locationInput: normalized.location ?? null,
    latitude: normalized.latitude ?? null,
    longitude: normalized.longitude ?? null,
    radius: normalized.radius ?? null,
    resultCount: places.length,
    cityCount: cities.length,
    addressCount: addresses.length,
    streetCount: streets.length,
    search_lang: normalized.search_lang ?? null,
    safesearch: normalized.safesearch ?? null,
    places,
    cities,
    addresses,
    streets,
    mixed,
    location: isJsonObject(payload.location) ? payload.location : null,
  }, attemptMetadata);
}

export async function fetchBravePlacePois(
  input: BravePlaceDetailsInput,
  options: BraveSearchOptions = {},
): Promise<BravePlaceDetailsResult> {
  const ids = normalizePlaceIds(input);
  const {payload, elapsedMs, attemptMetadata} = await fetchBraveJson<JsonObject>(buildPlaceDetailsUrl(BRAVE_PLACE_POIS_ENDPOINT, ids), options);
  return attachBraveAttemptMetadata({
    provider: "brave",
    vertical: "place_poi",
    ids,
    elapsedMs,
    resultCount: countPayloadResults(payload),
    payload,
  }, attemptMetadata);
}

export async function fetchBravePlaceDescriptions(
  input: BravePlaceDetailsInput,
  options: BraveSearchOptions = {},
): Promise<BravePlaceDetailsResult> {
  const ids = normalizePlaceIds(input);
  const {payload, elapsedMs, attemptMetadata} = await fetchBraveJson<JsonObject>(buildPlaceDetailsUrl(BRAVE_PLACE_DESCRIPTIONS_ENDPOINT, ids), options);
  return attachBraveAttemptMetadata({
    provider: "brave",
    vertical: "place_description",
    ids,
    elapsedMs,
    resultCount: countPayloadResults(payload),
    payload,
  }, attemptMetadata);
}

function buildLlmContextUrl(input: BraveLlmContextInput): {url: URL; normalized: ReturnType<typeof normalizeCommonSearchInput>; thresholdMode?: BraveLlmContextThresholdMode} {
  const {url, normalized} = buildSearchUrl(BRAVE_LLM_CONTEXT_ENDPOINT, input, {
    maxCount: MAX_BRAVE_LLM_CONTEXT_COUNT,
  });
  const thresholdMode = normalizeThresholdMode(input.context_threshold_mode);
  if (input.context_threshold_mode && !thresholdMode) {
    throw new ToolError("context_threshold_mode must be strict, balanced, lenient, or disabled.");
  }

  maybeSetNumberParam(url, "maximum_number_of_urls", input.maximum_number_of_urls, {min: 1, max: 50});
  maybeSetNumberParam(url, "maximum_number_of_tokens", input.maximum_number_of_tokens, {min: 1024, max: 32768});
  maybeSetNumberParam(url, "maximum_number_of_snippets", input.maximum_number_of_snippets, {min: 1, max: 100});
  maybeSetNumberParam(url, "maximum_number_of_tokens_per_url", input.maximum_number_of_tokens_per_url, {min: 512, max: 8192});
  maybeSetNumberParam(url, "maximum_number_of_snippets_per_url", input.maximum_number_of_snippets_per_url, {min: 1, max: 100});
  if (thresholdMode) {
    url.searchParams.set("context_threshold_mode", thresholdMode);
  }
  if (input.enable_local !== undefined) {
    url.searchParams.set("enable_local", String(input.enable_local));
  }

  return {url, normalized, ...(thresholdMode ? {thresholdMode} : {})};
}

export async function searchBraveLlmContext(
  input: BraveLlmContextInput,
  options: BraveSearchOptions = {},
): Promise<BraveLlmContextResult> {
  const {url, normalized} = buildLlmContextUrl(input);
  const {payload, elapsedMs, attemptMetadata} = await fetchBraveJson<{grounding?: unknown; sources?: unknown}>(url, options);
  const grounding = isJsonObject(payload.grounding) ? payload.grounding : {};
  const sources = isJsonObject(payload.sources) ? payload.sources : {};
  const generic = Array.isArray(grounding.generic) ? grounding.generic : [];

  return attachBraveAttemptMetadata({
    provider: "brave",
    vertical: "llm_context",
    query: normalized.query,
    country: normalized.country ?? null,
    freshness: normalized.freshness ?? null,
    elapsedMs,
    search_lang: normalized.search_lang ?? null,
    resultCount: generic.length,
    grounding,
    sources,
  }, attemptMetadata);
}
