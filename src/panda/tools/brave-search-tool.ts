import {z} from "zod";

import type {ToolResultMessage} from "@mariozechner/pi-ai";

import type {RunContext} from "../../kernel/agent/run-context.js";
import {formatToolResultFallback, Tool, type ToolOutput} from "../../kernel/agent/tool.js";
import {ToolError} from "../../kernel/agent/exceptions.js";
import type {JsonObject, JsonValue} from "../../kernel/agent/types.js";
import type {PandaSessionContext} from "../../app/runtime/panda-session-context.js";

const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const DEFAULT_COUNT = 5;
const MAX_COUNT = 10;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_ERROR_CHARS = 4_000;
const RESULT_PREVIEW_LIMIT = 3;
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

type BraveWebSearchResult = {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
};

type BraveWebSearchResponse = {
  web?: {
    results?: BraveWebSearchResult[];
  };
};

export interface BraveSearchToolOptions {
  apiKey?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  defaultCount?: number;
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function resolveSiteName(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function trimNonEmptyString(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

async function readResponseError(response: Response): Promise<string> {
  const text = (await response.text()).trim();
  return truncateText(text, MAX_ERROR_CHARS);
}

function normalizeBraveCountry(value: string | undefined): string | undefined {
  const trimmed = trimNonEmptyString(value);
  if (!trimmed) {
    return undefined;
  }

  const canonical = trimmed.toUpperCase();
  return BRAVE_COUNTRY_CODES.has(canonical) ? canonical : "ALL";
}

function normalizeBraveSearchLang(value: string | undefined): string | undefined {
  const trimmed = trimNonEmptyString(value);
  if (!trimmed) {
    return undefined;
  }

  const canonical = BRAVE_SEARCH_LANG_ALIASES[trimmed.toLowerCase()] ?? trimmed.toLowerCase();
  if (!BRAVE_SEARCH_LANG_CODES.has(canonical)) {
    return undefined;
  }

  return canonical;
}

export function hasBraveSearchApiKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return trimNonEmptyString(env.BRAVE_API_KEY) !== null;
}

export class BraveSearchTool<TContext = PandaSessionContext>
  extends Tool<typeof BraveSearchTool.schema, TContext> {
  static schema = z.object({
    query: z.string().trim().min(1),
    count: z.number().int().min(1).max(MAX_COUNT).optional(),
    country: z.string().trim().min(1).optional(),
    freshness: z.enum(["day", "week", "month", "year"]).optional(),
    search_lang: z.string().trim().min(1).optional(),
  });

  name = "brave_search";
  description =
    "Search the web with Brave Search. Supports current web lookups plus optional country and search language filters.";
  schema = BraveSearchTool.schema;

  private readonly apiKey?: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;
  private readonly defaultCount: number;

  constructor(options: BraveSearchToolOptions = {}) {
    super();
    this.apiKey = trimNonEmptyString(options.apiKey) ?? undefined;
    this.env = options.env ?? process.env;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.defaultCount = Math.max(1, Math.min(MAX_COUNT, options.defaultCount ?? DEFAULT_COUNT));
  }

  override formatCall(args: Record<string, unknown>): string {
    return typeof args.query === "string" ? args.query : super.formatCall(args);
  }

  override formatResult(message: ToolResultMessage<JsonValue>): string {
    const details = message.details;
    if (!details || typeof details !== "object" || Array.isArray(details)) {
      return formatToolResultFallback(message);
    }

    const results = Array.isArray(details.results) ? details.results : [];
    const preview = results
      .slice(0, RESULT_PREVIEW_LIMIT)
      .map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          return null;
        }

        const record = entry as Record<string, unknown>;
        const title = typeof record.title === "string" && record.title.trim()
          ? record.title.trim()
          : "Untitled";
        const siteName = typeof record.siteName === "string" && record.siteName.trim()
          ? record.siteName.trim()
          : undefined;
        return siteName ? `- ${title} (${siteName})` : `- ${title}`;
      })
      .filter((entry): entry is string => Boolean(entry));

    const lines = [`${results.length} result${results.length === 1 ? "" : "s"}`];
    if (preview.length > 0) {
      lines.push(...preview);
    }
    if (results.length > RESULT_PREVIEW_LIMIT) {
      lines.push(`+${results.length - RESULT_PREVIEW_LIMIT} more`);
    }
    return lines.join("\n");
  }

  async handle(
    args: z.output<typeof BraveSearchTool.schema>,
    run: RunContext<TContext>,
  ): Promise<ToolOutput> {
    const apiKey = this.apiKey ?? trimNonEmptyString(this.env.BRAVE_API_KEY);
    if (!apiKey) {
      throw new ToolError("BRAVE_API_KEY is not configured.");
    }

    const country = normalizeBraveCountry(args.country);
    const searchLang = normalizeBraveSearchLang(args.search_lang);
    if (args.search_lang && !searchLang) {
      throw new ToolError(
        "search_lang must be a Brave-supported language code like 'en', 'en-gb', 'zh-hans', or 'zh-hant'.",
      );
    }

    const url = new URL(BRAVE_SEARCH_ENDPOINT);
    url.searchParams.set("q", args.query);
    url.searchParams.set("count", String(args.count ?? this.defaultCount));
    if (country) {
      url.searchParams.set("country", country);
    }
    if (args.freshness) {
      url.searchParams.set("freshness", args.freshness);
    }
    if (searchLang) {
      url.searchParams.set("search_lang", searchLang);
    }

    run.emitToolProgress({
      status: "searching",
      country: country ?? null,
      query: args.query,
      searchLang: searchLang ?? null,
    });

    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = run.signal ? AbortSignal.any([run.signal, timeoutSignal]) : timeoutSignal;
    const startedAt = Date.now();

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": apiKey,
        },
        signal,
      });

      if (!response.ok) {
        const detail = await readResponseError(response);
        throw new ToolError(
          `Brave Search API error (${response.status}): ${detail || response.statusText}`,
        );
      }

      const payload = await response.json() as BraveWebSearchResponse;
      const results = Array.isArray(payload.web?.results) ? payload.web.results : [];

      return {
        provider: "brave",
        query: args.query,
        country: country ?? null,
        freshness: args.freshness ?? null,
        elapsedMs: Date.now() - startedAt,
        resultCount: results.length,
        search_lang: searchLang ?? null,
        results: results.map((result) => {
          const url = result.url ?? "";
          return {
            title: result.title ?? "",
            url,
            snippet: result.description ?? "",
            siteName: url ? resolveSiteName(url) ?? null : null,
            published: result.age ?? null,
          } satisfies JsonObject;
        }),
      } satisfies JsonObject;
    } catch (error) {
      if (run.signal?.aborted) {
        throw new ToolError("Brave search was aborted.");
      }
      if (timeoutSignal.aborted) {
        throw new ToolError(`Brave search timed out after ${this.timeoutMs}ms.`);
      }
      if (error instanceof ToolError) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      throw new ToolError(`Brave search failed: ${message}`);
    }
  }
}
