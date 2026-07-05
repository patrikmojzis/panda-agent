import {mkdir, writeFile} from "node:fs/promises";
import path from "node:path";

import type {JsonObject} from "../../lib/json.js";
import {isRecord} from "../../lib/records.js";
import type {CommandWritableFileResolver} from "../../domain/commands/files.js";
import type {CommandDescriptor, CommandRequest, CommandSuccess, RegisteredCommand} from "../../domain/commands/types.js";
import type {BackgroundToolJobService} from "../../domain/threads/runtime/tool-job-service.js";
import type {ThreadToolJobRecord} from "../../domain/threads/runtime/types.js";
import {
  DEFAULT_WEB_FETCH_MAX_CONTENT_CHARS,
  DEFAULT_WEB_FETCH_MAX_REDIRECTS,
  DEFAULT_WEB_FETCH_MAX_RESPONSE_BYTES,
  DEFAULT_WEB_FETCH_TIMEOUT_MS,
  DEFAULT_WEB_FETCH_USER_AGENT,
  fetchReadableWebPage,
  type FetchImpl,
} from "./web-fetch.js";
import type {LookupHostname} from "./safe-web-target.js";
import {
  fetchBravePlaceDescriptions,
  fetchBravePlacePois,
  searchBraveLlmContext,
  searchBraveImage,
  searchBraveNews,
  searchBravePlace,
  searchBraveVideo,
  searchBraveWeb,
  type BraveLlmContextInput,
  type BravePlaceDetailsInput,
  type BravePlaceSearchInput,
  type BraveSearchInput,
  type FetchImpl as BraveSearchFetchImpl,
} from "./brave-search.js";
import {
  DEFAULT_WEB_RESEARCH_MODEL,
  DEFAULT_WEB_RESEARCH_REASONING_EFFORT,
  DEFAULT_WEB_RESEARCH_TIMEOUT_MS,
  performWebResearch,
  serializeWebResearchResultForBackgroundJob,
  type WebResearchReasoningEffort,
} from "./research.js";

export const WEB_FETCH_COMMAND_NAME = "web.fetch";
export const OPENAI_WEB_RESEARCH_COMMAND_NAME = "openai.web_research";
export const BRAVE_WEB_SEARCH_COMMAND_NAME = "brave.web.search";
export const BRAVE_NEWS_SEARCH_COMMAND_NAME = "brave.news.search";
export const BRAVE_VIDEO_SEARCH_COMMAND_NAME = "brave.video.search";
export const BRAVE_IMAGE_SEARCH_COMMAND_NAME = "brave.image.search";
export const BRAVE_LLM_CONTEXT_COMMAND_NAME = "brave.llm.context";
export const BRAVE_PLACE_SEARCH_COMMAND_NAME = "brave.place.search";
export const BRAVE_PLACE_POI_COMMAND_NAME = "brave.place.poi";
export const BRAVE_PLACE_DESCRIPTION_COMMAND_NAME = "brave.place.description";

const BRAVE_SEARCH_RESULT_SHAPE = {
  provider: "brave",
  vertical: "web",
  query: "string",
  country: "string|null",
  freshness: "pd|pw|pm|py|date-range|null",
  resultCount: "number",
  safesearch: "off|moderate|strict|null",
  search_lang: "string|null",
  results: ["object"],
} satisfies JsonObject;

export const webFetchCommandDescriptor: CommandDescriptor = {
  name: WEB_FETCH_COMMAND_NAME,
  summary: "Fetch a public readable HTML page.",
  description: "Fetches a public HTTP/HTTPS HTML page and returns readable content plus metadata. Use --format text for plain text body output; --include-links/--no-links controls separate follow-up link metadata.",
  usage: "panda web fetch <url> [--max-chars <n>] [--format markdown|text] [--save <path>] [--include-links|--no-links]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "url",
      description: "HTTP/HTTPS URL to fetch.",
      required: true,
      kind: "positional",
      valueType: "string",
      valueName: "url",
    },
    {
      name: "max-chars",
      description: "Maximum readable content characters to return or save.",
      valueType: "number",
      valueName: "n",
    },
    {
      name: "format",
      description: "Readable output format.",
      valueType: "string",
      valueName: "markdown|text",
      enumValues: ["markdown", "text"],
    },
    {
      name: "save",
      description: "Save full readable content to a workspace path and return only a preview.",
      valueType: "string",
      valueName: "path",
    },
    {
      name: "include-links",
      description: "Include extracted follow-up links in JSON output.",
      valueType: "boolean",
    },
    {
      name: "no-links",
      description: "Omit extracted follow-up link metadata from JSON output. Use --format text to remove markdown links from the content body.",
      valueType: "boolean",
    },
    {
      name: "json",
      description: "Structured JSON object containing url and optional maxContentChars, format, save, and includeLinks.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "Fetch a page",
      command: "panda web fetch https://example.com",
    },
    {
      description: "Save a long page without dumping the whole body",
      command: "panda web fetch https://example.com/docs --max-chars 50000 --save ./docs.md",
    },
  ],
  requiredCapabilities: [WEB_FETCH_COMMAND_NAME],
  resultShape: {
    url: "string",
    finalUrl: "string",
    status: "number",
    contentType: "string",
    title: "string|null",
    content: "string|absent when saved",
    contentPreview: "string|absent unless saved",
    truncated: "boolean",
    saved: "object|null",
    links: ["object"],
  },
};

export const braveWebSearchCommandDescriptor: CommandDescriptor = {
  name: BRAVE_WEB_SEARCH_COMMAND_NAME,
  summary: "Search Brave Web Search.",
  description: "Searches Brave Web Search and returns structured result snippets plus source URLs. Use brave.llm.context when the next step is feeding retrieved context into a model.",
  usage: "panda brave web search <query> [-n|--count <n>] [--offset <n>] [--freshness pd|pw|pm|py|YYYY-MM-DDtoYYYY-MM-DD] [--country <code>] [--lang <code>] [--safe off|moderate|strict] [--extra-snippets] [--goggles <url-or-inline>]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "query",
      description: "Search query.",
      required: true,
      kind: "positional",
      valueType: "string",
      valueName: "query",
    },
    {
      name: "count",
      description: "Number of results, 1-20.",
      valueType: "number",
      valueName: "n",
    },
    {
      name: "offset",
      description: "Result page offset, 0-9.",
      valueType: "number",
      valueName: "n",
    },
    {
      name: "freshness",
      description: "Freshness filter: pd, pw, pm, py, or YYYY-MM-DDtoYYYY-MM-DD.",
      valueType: "string",
      valueName: "filter",
    },
    {
      name: "country",
      description: "2-character country code, or ALL.",
      valueType: "string",
      valueName: "code",
    },
    {
      name: "lang",
      description: "Search language code.",
      valueType: "string",
      valueName: "code",
    },
    {
      name: "safe",
      description: "Safe search mode.",
      valueType: "string",
      valueName: "off|moderate|strict",
      enumValues: ["off", "moderate", "strict"],
    },
    {
      name: "extra-snippets",
      description: "Request Brave extra snippets.",
      valueType: "boolean",
    },
    {
      name: "goggles",
      description: "Goggles URL or inline definition.",
      valueType: "string",
      valueName: "url-or-inline",
    },
    {
      name: "json",
      description: "Structured JSON object containing query and optional Brave search parameters.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "Search the web",
      command: "panda brave web search 'latest TypeScript release' -n 5 --freshness pw",
    },
    {
      description: "Use JSON input",
      command: "panda brave web search --json '{\"query\":\"latest TypeScript release\",\"count\":3}'",
    },
  ],
  requiredCapabilities: [BRAVE_WEB_SEARCH_COMMAND_NAME],
  resultShape: BRAVE_SEARCH_RESULT_SHAPE,
};

export const braveNewsSearchCommandDescriptor: CommandDescriptor = {
  ...braveWebSearchCommandDescriptor,
  name: BRAVE_NEWS_SEARCH_COMMAND_NAME,
  summary: "Search Brave News Search.",
  description: "Searches Brave's dedicated news index with freshness, country/language, safe-search, extra-snippet, and Goggles controls.",
  usage: "panda brave news search <query> [-n|--count <n>] [--offset <n>] [--freshness pd|pw|pm|py|YYYY-MM-DDtoYYYY-MM-DD] [--country <code>] [--lang <code>] [--safe off|moderate|strict] [--extra-snippets] [--goggles <url-or-inline>]",
  examples: [
    {
      description: "Search news from the past day",
      command: "panda brave news search 'AI regulation' -n 5 --freshness pd",
    },
    {
      description: "Use JSON input",
      command: "panda brave news search --json '{\"query\":\"AI regulation\",\"freshness\":\"pd\"}'",
    },
  ],
  requiredCapabilities: [BRAVE_NEWS_SEARCH_COMMAND_NAME],
  resultShape: {
    ...BRAVE_SEARCH_RESULT_SHAPE,
    vertical: "news",
  },
};

export const braveVideoSearchCommandDescriptor: CommandDescriptor = {
  ...braveWebSearchCommandDescriptor,
  name: BRAVE_VIDEO_SEARCH_COMMAND_NAME,
  summary: "Search Brave Video Search.",
  description: "Searches Brave's dedicated video index with freshness, pagination, country/language, safe-search, and spellcheck controls.",
  usage: "panda brave video search <query> [-n|--count <n>] [--offset <n>] [--freshness pd|pw|pm|py|YYYY-MM-DDtoYYYY-MM-DD] [--country <code>] [--lang <code>] [--safe off|moderate|strict] [--no-spellcheck]",
  arguments: [
    ...braveWebSearchCommandDescriptor.arguments.filter((argument) => argument.name !== "extra-snippets" && argument.name !== "goggles"),
    {
      name: "no-spellcheck",
      description: "Disable Brave spellcheck for the query.",
      valueType: "boolean",
    },
  ],
  examples: [
    {
      description: "Search recent videos",
      command: "panda brave video search 'machine learning tutorial' -n 10 --freshness pw",
    },
    {
      description: "Use JSON input",
      command: "panda brave video search --json '{\"query\":\"machine learning tutorial\",\"spellcheck\":false}'",
    },
  ],
  requiredCapabilities: [BRAVE_VIDEO_SEARCH_COMMAND_NAME],
  resultShape: {
    ...BRAVE_SEARCH_RESULT_SHAPE,
    vertical: "video",
  },
};

export const braveImageSearchCommandDescriptor: CommandDescriptor = {
  ...braveWebSearchCommandDescriptor,
  name: BRAVE_IMAGE_SEARCH_COMMAND_NAME,
  summary: "Search Brave Image Search.",
  description: "Searches Brave's dedicated image index and returns image URLs, thumbnails, source pages, dimensions, and metadata.",
  usage: "panda brave image search <query> [-n|--count <n>] [--country <code>] [--lang <code>] [--safe strict|off] [--no-spellcheck]",
  arguments: [
    {
      name: "query",
      description: "Image search query.",
      required: true,
      kind: "positional",
      valueType: "string",
      valueName: "query",
    },
    {
      name: "count",
      description: "Number of image results, 1-200.",
      valueType: "number",
      valueName: "n",
    },
    {
      name: "country",
      description: "2-character country code, or ALL.",
      valueType: "string",
      valueName: "code",
    },
    {
      name: "lang",
      description: "Search language code.",
      valueType: "string",
      valueName: "code",
    },
    {
      name: "safe",
      description: "Image safe search mode.",
      valueType: "string",
      valueName: "strict|off",
      enumValues: ["strict", "off"],
    },
    {
      name: "no-spellcheck",
      description: "Disable Brave spellcheck for the query.",
      valueType: "boolean",
    },
    {
      name: "json",
      description: "Structured JSON object containing query and optional Brave image search parameters.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "Search images",
      command: "panda brave image search 'modern architecture' -n 20 --safe strict",
    },
    {
      description: "Use JSON input",
      command: "panda brave image search --json '{\"query\":\"modern architecture\",\"count\":50}'",
    },
  ],
  requiredCapabilities: [BRAVE_IMAGE_SEARCH_COMMAND_NAME],
  resultShape: {
    ...BRAVE_SEARCH_RESULT_SHAPE,
    vertical: "image",
  },
};

export const braveLlmContextCommandDescriptor: CommandDescriptor = {
  name: BRAVE_LLM_CONTEXT_COMMAND_NAME,
  summary: "Retrieve Brave LLM Context.",
  description: "Calls Brave LLM Context, which returns extracted grounding content and source metadata for agent/RAG consumption.",
  usage: "panda brave llm context <query> [-n|--count <n>] [--max-tokens <n>] [--max-urls <n>] [--threshold strict|balanced|lenient|disabled] [--local] [--freshness pd|pw|pm|py|YYYY-MM-DDtoYYYY-MM-DD] [--country <code>] [--lang <code>] [--goggles <url-or-inline>]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "query",
      description: "Search query.",
      required: true,
      kind: "positional",
      valueType: "string",
      valueName: "query",
    },
    {
      name: "count",
      description: "Maximum search results to consider, 1-50.",
      valueType: "number",
      valueName: "n",
    },
    {
      name: "max-urls",
      description: "Maximum URLs in the response, 1-50.",
      valueType: "number",
      valueName: "n",
    },
    {
      name: "max-tokens",
      description: "Approximate maximum context tokens, 1024-32768.",
      valueType: "number",
      valueName: "n",
    },
    {
      name: "threshold",
      description: "Relevance threshold for included content.",
      valueType: "string",
      valueName: "strict|balanced|lenient|disabled",
      enumValues: ["strict", "balanced", "lenient", "disabled"],
    },
    {
      name: "local",
      description: "Enable local recall for location-aware queries.",
      valueType: "boolean",
    },
    {
      name: "country",
      description: "2-character country code, or ALL.",
      valueType: "string",
      valueName: "code",
    },
    {
      name: "lang",
      description: "Search language code.",
      valueType: "string",
      valueName: "code",
    },
    {
      name: "freshness",
      description: "Freshness filter: pd, pw, pm, py, or YYYY-MM-DDtoYYYY-MM-DD.",
      valueType: "string",
      valueName: "filter",
    },
    {
      name: "goggles",
      description: "Goggles URL or inline definition.",
      valueType: "string",
      valueName: "url-or-inline",
    },
    {
      name: "json",
      description: "Structured JSON object containing query and optional Brave LLM Context parameters.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "Retrieve model-ready context",
      command: "panda brave llm context 'best durable command CLI design' --max-tokens 8192 --threshold strict",
    },
    {
      description: "Use JSON input",
      command: "panda brave llm context --json '{\"query\":\"best durable command CLI design\",\"maximum_number_of_tokens\":8192}'",
    },
  ],
  requiredCapabilities: [BRAVE_LLM_CONTEXT_COMMAND_NAME],
  resultShape: {
    provider: "brave",
    vertical: "llm_context",
    query: "string",
    country: "string|null",
    freshness: "pd|pw|pm|py|date-range|null",
    resultCount: "number",
    grounding: "object",
    sources: "object",
  },
};

export const bravePlaceSearchCommandDescriptor: CommandDescriptor = {
  name: BRAVE_PLACE_SEARCH_COMMAND_NAME,
  summary: "Search Brave Place Search.",
  description: "Searches Brave's local place index for businesses, landmarks, addresses, streets, cities, and POIs. Place ids are ephemeral and should be used immediately.",
  usage: "panda brave place search [query] [--location <location>|--lat <number> --lon <number>] [-n|--count <n>] [--radius <meters>] [--country <code>] [--lang <code>] [--units metric|imperial] [--safe off|moderate|strict] [--no-spellcheck]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "query",
      description: "Place query. Omit for explore mode when a location or coordinates are supplied.",
      kind: "positional",
      valueType: "string",
      valueName: "query",
    },
    {
      name: "location",
      description: "Location string such as 'san francisco ca united states' or 'tokyo japan'.",
      valueType: "string",
      valueName: "location",
    },
    {
      name: "lat",
      description: "Latitude for coordinate-anchored search.",
      valueType: "number",
      valueName: "number",
    },
    {
      name: "lon",
      description: "Longitude for coordinate-anchored search.",
      valueType: "number",
      valueName: "number",
    },
    {
      name: "radius",
      description: "Search radius around coordinates in meters.",
      valueType: "number",
      valueName: "meters",
    },
    {
      name: "count",
      description: "Number of place results, 1-100.",
      valueType: "number",
      valueName: "n",
    },
    {
      name: "country",
      description: "2-character country code, or ALL.",
      valueType: "string",
      valueName: "code",
    },
    {
      name: "lang",
      description: "Search language code.",
      valueType: "string",
      valueName: "code",
    },
    {
      name: "units",
      description: "Distance units.",
      valueType: "string",
      valueName: "metric|imperial",
      enumValues: ["metric", "imperial"],
    },
    {
      name: "safe",
      description: "Safe search mode.",
      valueType: "string",
      valueName: "off|moderate|strict",
      enumValues: ["off", "moderate", "strict"],
    },
    {
      name: "no-spellcheck",
      description: "Disable Brave spellcheck for the query.",
      valueType: "boolean",
    },
    {
      name: "json",
      description: "Structured JSON object containing query/location/coordinate parameters.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "Find places by location name",
      command: "panda brave place search restaurants --location 'san francisco ca united states' -n 10",
    },
    {
      description: "Explore a coordinate area",
      command: "panda brave place search --lat 40.7128 --lon -74.0060 --radius 2000 -n 10",
    },
  ],
  requiredCapabilities: [BRAVE_PLACE_SEARCH_COMMAND_NAME],
  resultShape: {
    provider: "brave",
    vertical: "place",
    query: "string|null",
    locationInput: "string|null",
    resultCount: "number",
    places: ["object"],
    cities: ["object"],
    addresses: ["object"],
    streets: ["object"],
  },
};

export const bravePlacePoiCommandDescriptor: CommandDescriptor = {
  name: BRAVE_PLACE_POI_COMMAND_NAME,
  summary: "Fetch Brave Place POI details.",
  description: "Fetches photos, profiles, mentions, and detailed metadata for Brave place ids. IDs expire after roughly 8 hours; do not persist them.",
  usage: "panda brave place poi <id> [id...]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "id",
      description: "Brave place id from place search or web local results. Repeat as positionals, up to 20 ids.",
      required: true,
      kind: "positional",
      valueType: "string",
      valueName: "id",
    },
    {
      name: "json",
      description: "Structured JSON object containing ids.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "Fetch POI details",
      command: "panda brave place poi loc4FNMQJNOOCVHEB7UBOLN354ZYIDIYJ3RPRETERRY=",
    },
  ],
  requiredCapabilities: [BRAVE_PLACE_POI_COMMAND_NAME],
  resultShape: {
    provider: "brave",
    vertical: "place_poi",
    ids: ["string"],
    payload: "object",
  },
};

export const bravePlaceDescriptionCommandDescriptor: CommandDescriptor = {
  ...bravePlacePoiCommandDescriptor,
  name: BRAVE_PLACE_DESCRIPTION_COMMAND_NAME,
  summary: "Fetch Brave Place AI descriptions.",
  description: "Fetches Brave AI-generated descriptions for ephemeral place ids.",
  usage: "panda brave place description <id> [id...]",
  examples: [
    {
      description: "Fetch place descriptions",
      command: "panda brave place description loc4FNMQJNOOCVHEB7UBOLN354ZYIDIYJ3RPRETERRY=",
    },
  ],
  requiredCapabilities: [BRAVE_PLACE_DESCRIPTION_COMMAND_NAME],
  resultShape: {
    provider: "brave",
    vertical: "place_description",
    ids: ["string"],
    payload: "object",
  },
};

export const openAIWebResearchCommandDescriptor: CommandDescriptor = {
  name: OPENAI_WEB_RESEARCH_COMMAND_NAME,
  summary: "Start an OpenAI hosted web research background job.",
  description: "Starts a public web research job with OpenAI hosted web search and returns a background job id. Use background_job_wait when the answer is needed now.",
  usage: "panda openai web-research <query|@file|@-> [--model <model>] [--effort low|medium|high]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "query",
      description: "Research query. Use @file or @- for a longer prompt.",
      required: true,
      kind: "positional",
      valueType: "string",
      valueName: "query|@file|@-",
      valueSources: ["literal", "file", "stdin"] as const,
    },
    {
      name: "model",
      description: "OpenAI model to use for the research response.",
      valueType: "string",
      valueName: "model",
    },
    {
      name: "effort",
      description: "Reasoning effort for the OpenAI response.",
      valueType: "string",
      valueName: "low|medium|high",
      enumValues: ["low", "medium", "high"],
    },
    {
      name: "json",
      description: "Structured JSON object containing query plus optional model and effort.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "Start OpenAI web research",
      command: "panda openai web-research 'latest TypeScript release' --effort medium",
    },
    {
      description: "Use a longer query from stdin",
      command: "cat research-question.md | panda openai web-research @-",
    },
    {
      description: "Use JSON input",
      command: "panda openai web-research --json '{\"query\":\"latest TypeScript release\",\"effort\":\"medium\"}'",
    },
  ],
  requiredCapabilities: [OPENAI_WEB_RESEARCH_COMMAND_NAME],
  resultShape: {
    jobId: "string",
    kind: "web_research",
    status: "running|completed|failed|cancelled",
    summary: "string",
    progress: "object|null",
  },
};

type WebFetchFormat = "markdown" | "text";

interface WebFetchCommandInput {
  url: string;
  maxContentChars?: number;
  format: WebFetchFormat;
  save?: string;
  includeLinks: boolean;
}

function readWebFetchInput(input: unknown): WebFetchCommandInput {
  if (!isRecord(input) || typeof input.url !== "string" || !input.url.trim()) {
    throw new Error("web.fetch url must be a non-empty string.");
  }

  const maxContentChars = readOptionalNumber(input.maxContentChars ?? input.max_chars ?? input.maxChars, "web.fetch maxContentChars");
  if (maxContentChars !== undefined && maxContentChars <= 0) {
    throw new Error("web.fetch maxContentChars must be greater than 0.");
  }

  const rawFormat = readOptionalString(input.format, "web.fetch format") ?? "markdown";
  if (rawFormat !== "markdown" && rawFormat !== "text") {
    throw new Error("web.fetch format must be markdown or text.");
  }

  const includeLinks = readOptionalBoolean(input.includeLinks ?? input.include_links, "web.fetch includeLinks") ?? true;
  const save = readOptionalString(input.save, "web.fetch save");

  return {
    url: input.url.trim(),
    format: rawFormat,
    includeLinks,
    ...(maxContentChars !== undefined ? {maxContentChars} : {}),
    ...(save ? {save} : {}),
  };
}

function readOptionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`);
  }

  return value;
}

function readOptionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean.`);
  }

  return value;
}

function readOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readWebSearchInput(input: unknown, label = "brave.web.search"): BraveSearchInput {
  if (!isRecord(input) || typeof input.query !== "string" || !input.query.trim()) {
    throw new Error(`${label} query must be a non-empty string.`);
  }

  return {
    query: input.query.trim(),
    ...(readOptionalNumber(input.count, `${label} count`) !== undefined ? {count: readOptionalNumber(input.count, `${label} count`)} : {}),
    ...(readOptionalNumber(input.offset, `${label} offset`) !== undefined ? {offset: readOptionalNumber(input.offset, `${label} offset`)} : {}),
    ...(readOptionalString(input.country, `${label} country`) ? {country: readOptionalString(input.country, `${label} country`)} : {}),
    ...(readOptionalString(input.freshness, `${label} freshness`) ? {freshness: readOptionalString(input.freshness, `${label} freshness`) as BraveSearchInput["freshness"]} : {}),
    ...(readOptionalString(input.safesearch ?? input.safe, `${label} safesearch`) ? {safesearch: readOptionalString(input.safesearch ?? input.safe, `${label} safesearch`) as BraveSearchInput["safesearch"]} : {}),
    ...(readOptionalString(input.search_lang ?? input.lang, `${label} search_lang`) ? {search_lang: readOptionalString(input.search_lang ?? input.lang, `${label} search_lang`)} : {}),
    ...(readOptionalString(input.ui_lang, `${label} ui_lang`) ? {ui_lang: readOptionalString(input.ui_lang, `${label} ui_lang`)} : {}),
    ...(readOptionalBoolean(input.extra_snippets ?? input.extraSnippets, `${label} extra_snippets`) !== undefined ? {extra_snippets: readOptionalBoolean(input.extra_snippets ?? input.extraSnippets, `${label} extra_snippets`)} : {}),
    ...(readOptionalString(input.goggles, `${label} goggles`) ? {goggles: readOptionalString(input.goggles, `${label} goggles`)} : {}),
    ...(readOptionalBoolean(input.spellcheck, `${label} spellcheck`) !== undefined ? {spellcheck: readOptionalBoolean(input.spellcheck, `${label} spellcheck`)} : {}),
  };
}

function readPlaceSearchInput(input: unknown): BravePlaceSearchInput {
  if (!isRecord(input)) {
    throw new Error("brave.place.search input must be a JSON object.");
  }

  const query = readOptionalString(input.query, "brave.place.search query");
  const location = readOptionalString(input.location, "brave.place.search location");
  const latitude = readOptionalNumber(input.latitude ?? input.lat, "brave.place.search latitude");
  const longitude = readOptionalNumber(input.longitude ?? input.lon ?? input.lng, "brave.place.search longitude");

  return {
    ...(query ? {query} : {}),
    ...(readOptionalNumber(input.count, "brave.place.search count") !== undefined ? {count: readOptionalNumber(input.count, "brave.place.search count")} : {}),
    ...(readOptionalString(input.country, "brave.place.search country") ? {country: readOptionalString(input.country, "brave.place.search country")} : {}),
    ...(location ? {location} : {}),
    ...(latitude !== undefined ? {latitude} : {}),
    ...(longitude !== undefined ? {longitude} : {}),
    ...(readOptionalNumber(input.radius, "brave.place.search radius") !== undefined ? {radius: readOptionalNumber(input.radius, "brave.place.search radius")} : {}),
    ...(readOptionalString(input.safesearch ?? input.safe, "brave.place.search safesearch") ? {safesearch: readOptionalString(input.safesearch ?? input.safe, "brave.place.search safesearch") as BravePlaceSearchInput["safesearch"]} : {}),
    ...(readOptionalString(input.search_lang ?? input.lang, "brave.place.search search_lang") ? {search_lang: readOptionalString(input.search_lang ?? input.lang, "brave.place.search search_lang")} : {}),
    ...(readOptionalString(input.ui_lang, "brave.place.search ui_lang") ? {ui_lang: readOptionalString(input.ui_lang, "brave.place.search ui_lang")} : {}),
    ...(readOptionalBoolean(input.spellcheck, "brave.place.search spellcheck") !== undefined ? {spellcheck: readOptionalBoolean(input.spellcheck, "brave.place.search spellcheck")} : {}),
    ...(readOptionalString(input.units, "brave.place.search units") ? {units: readOptionalString(input.units, "brave.place.search units") as BravePlaceSearchInput["units"]} : {}),
  };
}

function readPlaceDetailsInput(input: unknown, label: string): BravePlaceDetailsInput {
  if (!isRecord(input)) {
    throw new Error(`${label} input must be a JSON object.`);
  }
  const rawIds = Array.isArray(input.ids)
    ? input.ids
    : typeof input.id === "string"
      ? [input.id]
      : [];
  if (!rawIds.every((id): id is string => typeof id === "string")) {
    throw new Error(`${label} ids must be strings.`);
  }

  return {ids: rawIds};
}

function readBraveLlmContextInput(input: unknown): BraveLlmContextInput {
  if (!isRecord(input)) {
    throw new Error("brave.llm.context input must be a JSON object.");
  }

  return {
    ...readWebSearchInput(input, "brave.llm.context"),
    ...(readOptionalNumber(input.maximum_number_of_urls ?? input.maxUrls, "brave.llm.context maximum_number_of_urls") !== undefined
      ? {maximum_number_of_urls: readOptionalNumber(input.maximum_number_of_urls ?? input.maxUrls, "brave.llm.context maximum_number_of_urls")}
      : {}),
    ...(readOptionalNumber(input.maximum_number_of_tokens ?? input.maxTokens, "brave.llm.context maximum_number_of_tokens") !== undefined
      ? {maximum_number_of_tokens: readOptionalNumber(input.maximum_number_of_tokens ?? input.maxTokens, "brave.llm.context maximum_number_of_tokens")}
      : {}),
    ...(readOptionalNumber(input.maximum_number_of_snippets, "brave.llm.context maximum_number_of_snippets") !== undefined
      ? {maximum_number_of_snippets: readOptionalNumber(input.maximum_number_of_snippets, "brave.llm.context maximum_number_of_snippets")}
      : {}),
    ...(readOptionalNumber(input.maximum_number_of_tokens_per_url, "brave.llm.context maximum_number_of_tokens_per_url") !== undefined
      ? {maximum_number_of_tokens_per_url: readOptionalNumber(input.maximum_number_of_tokens_per_url, "brave.llm.context maximum_number_of_tokens_per_url")}
      : {}),
    ...(readOptionalNumber(input.maximum_number_of_snippets_per_url, "brave.llm.context maximum_number_of_snippets_per_url") !== undefined
      ? {maximum_number_of_snippets_per_url: readOptionalNumber(input.maximum_number_of_snippets_per_url, "brave.llm.context maximum_number_of_snippets_per_url")}
      : {}),
    ...(readOptionalString(input.context_threshold_mode ?? input.threshold, "brave.llm.context context_threshold_mode")
      ? {context_threshold_mode: readOptionalString(input.context_threshold_mode ?? input.threshold, "brave.llm.context context_threshold_mode") as BraveLlmContextInput["context_threshold_mode"]}
      : {}),
    ...(readOptionalBoolean(input.enable_local ?? input.local, "brave.llm.context enable_local") !== undefined
      ? {enable_local: readOptionalBoolean(input.enable_local ?? input.local, "brave.llm.context enable_local")}
      : {}),
  };
}

interface WebResearchCommandInput {
  query: string;
  model?: string;
  reasoningEffort?: WebResearchReasoningEffort;
}

function readWebResearchInput(input: unknown, label = OPENAI_WEB_RESEARCH_COMMAND_NAME): WebResearchCommandInput {
  if (!isRecord(input) || typeof input.query !== "string" || !input.query.trim()) {
    throw new Error(`${label} query must be a non-empty string.`);
  }

  const model = readOptionalString(input.model, `${label} model`);
  const effort = readOptionalString(input.effort ?? input.reasoningEffort ?? input.reasoning_effort, `${label} effort`);
  if (effort !== undefined && effort !== "low" && effort !== "medium" && effort !== "high") {
    throw new Error(`${label} effort must be low, medium, or high.`);
  }

  return {
    query: input.query.trim(),
    ...(model ? {model} : {}),
    ...(effort ? {reasoningEffort: effort} : {}),
  };
}

function backgroundJobPayload(record: ThreadToolJobRecord): JsonObject {
  return {
    jobId: record.id,
    kind: record.kind,
    status: record.status,
    summary: record.summary,
    startedAt: record.startedAt,
    ...(record.finishedAt !== undefined ? {finishedAt: record.finishedAt} : {}),
    ...(record.durationMs !== undefined ? {durationMs: record.durationMs} : {}),
    ...(record.error ? {error: record.error} : {}),
    ...(record.statusReason ? {reason: record.statusReason} : {}),
    ...(record.progress ? {progress: record.progress} : {}),
    ...(record.result ? {result: record.result} : {}),
  };
}

function serializeWebFetchLinks(result: Awaited<ReturnType<typeof fetchReadableWebPage>>): JsonObject[] {
  return result.links.map((link) => ({
    text: link.text,
    url: link.url,
  }) satisfies JsonObject);
}

function webFetchSavedPreview(content: string): string {
  const limit = 1_000;
  return content.length > limit ? `${content.slice(0, limit)}...` : content;
}

function markdownishToPlainText(content: string): string {
  return content
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}

function formatWebFetchContent(content: string, format: WebFetchFormat): string {
  return format === "text" ? markdownishToPlainText(content) : content;
}

export function createWebFetchCommand(options: {
  fetchImpl?: FetchImpl;
  lookupHostname?: LookupHostname;
  timeoutMs?: number;
  maxRedirects?: number;
  maxResponseBytes?: number;
  maxContentChars?: number;
  userAgent?: string;
  fileResolver?: CommandWritableFileResolver;
} = {}): RegisteredCommand {
  return {
    descriptor: webFetchCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = readWebFetchInput(request.input);
      const result = await fetchReadableWebPage(input.url, {
        fetchImpl: options.fetchImpl,
        lookupHostname: options.lookupHostname,
        timeoutMs: options.timeoutMs ?? DEFAULT_WEB_FETCH_TIMEOUT_MS,
        maxRedirects: options.maxRedirects ?? DEFAULT_WEB_FETCH_MAX_REDIRECTS,
        maxResponseBytes: options.maxResponseBytes ?? DEFAULT_WEB_FETCH_MAX_RESPONSE_BYTES,
        maxContentChars: input.maxContentChars ?? options.maxContentChars ?? DEFAULT_WEB_FETCH_MAX_CONTENT_CHARS,
        userAgent: options.userAgent ?? DEFAULT_WEB_FETCH_USER_AGENT,
      });
      const content = formatWebFetchContent(result.content, input.format);
      let saved: JsonObject | null = null;
      if (input.save) {
        if (!options.fileResolver) {
          throw new Error("web.fetch --save requires command file resolver support.");
        }
        const resolved = await options.fileResolver.resolveWritablePath({
          request,
          file: {
            path: input.save,
          },
        });
        const savedContent = content.endsWith("\n") ? content : `${content}\n`;
        await mkdir(path.dirname(resolved.path), {recursive: true});
        await writeFile(resolved.path, savedContent, "utf8");
        saved = {
          path: resolved.path,
          displayPath: resolved.displayPath,
          bytes: Buffer.byteLength(savedContent, "utf8"),
          format: input.format,
        };
      }
      const output = {
        url: result.url,
        finalUrl: result.finalUrl,
        status: result.status,
        contentType: result.contentType,
        title: result.title,
        description: result.description,
        siteName: result.siteName,
        contentFormat: input.format,
        truncated: result.truncated,
        ...(saved ? {contentPreview: webFetchSavedPreview(content), saved} : {content}),
        ...(input.includeLinks ? {links: serializeWebFetchLinks(result)} : {}),
      } satisfies JsonObject;

      return {
        ok: true,
        command: WEB_FETCH_COMMAND_NAME,
        output,
        summary: `Fetched ${result.finalUrl}.`,
      };
    },
  };
}

export function createBraveWebSearchCommand(options: {
  apiKey?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: BraveSearchFetchImpl;
  timeoutMs?: number;
  defaultCount?: number;
  now?: () => number;
} = {}): RegisteredCommand {
  return {
    descriptor: braveWebSearchCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = readWebSearchInput(request.input, BRAVE_WEB_SEARCH_COMMAND_NAME);
      const result = await searchBraveWeb(input, {
        apiKey: options.apiKey,
        env: options.env,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
        defaultCount: options.defaultCount,
        now: options.now,
      });
      return {
        ok: true,
        command: BRAVE_WEB_SEARCH_COMMAND_NAME,
        output: result,
        summary: `Found ${result.resultCount} Brave web result${result.resultCount === 1 ? "" : "s"} for ${result.query}.`,
      };
    },
  };
}

export function createBraveNewsSearchCommand(options: {
  apiKey?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: BraveSearchFetchImpl;
  timeoutMs?: number;
  defaultCount?: number;
  now?: () => number;
} = {}): RegisteredCommand {
  return {
    descriptor: braveNewsSearchCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = readWebSearchInput(request.input, BRAVE_NEWS_SEARCH_COMMAND_NAME);
      const result = await searchBraveNews(input, {
        apiKey: options.apiKey,
        env: options.env,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
        defaultCount: options.defaultCount,
        now: options.now,
      });
      return {
        ok: true,
        command: BRAVE_NEWS_SEARCH_COMMAND_NAME,
        output: result,
        summary: `Found ${result.resultCount} Brave news result${result.resultCount === 1 ? "" : "s"} for ${result.query}.`,
      };
    },
  };
}

export function createBraveVideoSearchCommand(options: {
  apiKey?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: BraveSearchFetchImpl;
  timeoutMs?: number;
  defaultCount?: number;
  now?: () => number;
} = {}): RegisteredCommand {
  return {
    descriptor: braveVideoSearchCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = readWebSearchInput(request.input, BRAVE_VIDEO_SEARCH_COMMAND_NAME);
      const result = await searchBraveVideo(input, {
        apiKey: options.apiKey,
        env: options.env,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
        defaultCount: options.defaultCount,
        now: options.now,
      });
      return {
        ok: true,
        command: BRAVE_VIDEO_SEARCH_COMMAND_NAME,
        output: result,
        summary: `Found ${result.resultCount} Brave video result${result.resultCount === 1 ? "" : "s"} for ${result.query}.`,
      };
    },
  };
}

export function createBraveImageSearchCommand(options: {
  apiKey?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: BraveSearchFetchImpl;
  timeoutMs?: number;
  defaultCount?: number;
  now?: () => number;
} = {}): RegisteredCommand {
  return {
    descriptor: braveImageSearchCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = readWebSearchInput(request.input, BRAVE_IMAGE_SEARCH_COMMAND_NAME);
      const result = await searchBraveImage(input, {
        apiKey: options.apiKey,
        env: options.env,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
        defaultCount: options.defaultCount,
        now: options.now,
      });
      return {
        ok: true,
        command: BRAVE_IMAGE_SEARCH_COMMAND_NAME,
        output: result,
        summary: `Found ${result.resultCount} Brave image result${result.resultCount === 1 ? "" : "s"} for ${result.query}.`,
      };
    },
  };
}

export function createBraveLlmContextCommand(options: {
  apiKey?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: BraveSearchFetchImpl;
  timeoutMs?: number;
  now?: () => number;
} = {}): RegisteredCommand {
  return {
    descriptor: braveLlmContextCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = readBraveLlmContextInput(request.input);
      const result = await searchBraveLlmContext(input, {
        apiKey: options.apiKey,
        env: options.env,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
        now: options.now,
      });
      return {
        ok: true,
        command: BRAVE_LLM_CONTEXT_COMMAND_NAME,
        output: result,
        summary: `Retrieved Brave LLM context from ${result.resultCount} source${result.resultCount === 1 ? "" : "s"} for ${result.query}.`,
      };
    },
  };
}

export function createBravePlaceSearchCommand(options: {
  apiKey?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: BraveSearchFetchImpl;
  timeoutMs?: number;
  defaultCount?: number;
  now?: () => number;
} = {}): RegisteredCommand {
  return {
    descriptor: bravePlaceSearchCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = readPlaceSearchInput(request.input);
      const result = await searchBravePlace(input, {
        apiKey: options.apiKey,
        env: options.env,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
        defaultCount: options.defaultCount,
        now: options.now,
      });
      return {
        ok: true,
        command: BRAVE_PLACE_SEARCH_COMMAND_NAME,
        output: result,
        summary: `Found ${result.resultCount} Brave place result${result.resultCount === 1 ? "" : "s"}.`,
      };
    },
  };
}

export function createBravePlacePoiCommand(options: {
  apiKey?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: BraveSearchFetchImpl;
  timeoutMs?: number;
  now?: () => number;
} = {}): RegisteredCommand {
  return {
    descriptor: bravePlacePoiCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = readPlaceDetailsInput(request.input, BRAVE_PLACE_POI_COMMAND_NAME);
      const result = await fetchBravePlacePois(input, {
        apiKey: options.apiKey,
        env: options.env,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
        now: options.now,
      });
      return {
        ok: true,
        command: BRAVE_PLACE_POI_COMMAND_NAME,
        output: result,
        summary: `Fetched Brave POI details for ${result.ids.length} place id${result.ids.length === 1 ? "" : "s"}.`,
      };
    },
  };
}

export function createBravePlaceDescriptionCommand(options: {
  apiKey?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: BraveSearchFetchImpl;
  timeoutMs?: number;
  now?: () => number;
} = {}): RegisteredCommand {
  return {
    descriptor: bravePlaceDescriptionCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = readPlaceDetailsInput(request.input, BRAVE_PLACE_DESCRIPTION_COMMAND_NAME);
      const result = await fetchBravePlaceDescriptions(input, {
        apiKey: options.apiKey,
        env: options.env,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
        now: options.now,
      });
      return {
        ok: true,
        command: BRAVE_PLACE_DESCRIPTION_COMMAND_NAME,
        output: result,
        summary: `Fetched Brave place descriptions for ${result.ids.length} place id${result.ids.length === 1 ? "" : "s"}.`,
      };
    },
  };
}

function createWebResearchRegisteredCommand(options: {
  jobService: BackgroundToolJobService;
  apiKey?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  model?: string;
  reasoningEffort?: WebResearchReasoningEffort;
  descriptor: CommandDescriptor;
  commandName: typeof OPENAI_WEB_RESEARCH_COMMAND_NAME;
  label: string;
}): RegisteredCommand {
  return {
    descriptor: options.descriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = readWebResearchInput(request.input, options.label);
      if (!request.scope.threadId) {
        throw new Error(`${options.label} requires resolved command thread scope.`);
      }

      const model = input.model ?? options.model ?? DEFAULT_WEB_RESEARCH_MODEL;
      const reasoningEffort = input.reasoningEffort ?? options.reasoningEffort ?? DEFAULT_WEB_RESEARCH_REASONING_EFFORT;
      const record = await options.jobService.start({
        threadId: request.scope.threadId,
        kind: "web_research",
        summary: input.query,
        start: ({signal, emitProgress}) => ({
          progress: {
            status: "queued",
            query: input.query,
            model,
          },
          done: performWebResearch(input.query, {
            apiKey: options.apiKey,
            env: options.env,
            fetchImpl: options.fetchImpl,
            timeoutMs: options.timeoutMs ?? DEFAULT_WEB_RESEARCH_TIMEOUT_MS,
            model,
            reasoningEffort,
            signal,
            onProgress: (progress) => emitProgress({
              ...progress,
            }),
          }).then((result) => ({
            status: "completed" as const,
            result: serializeWebResearchResultForBackgroundJob(result),
          })),
        }),
      });

      return {
        ok: true,
        command: options.commandName,
        output: backgroundJobPayload(record),
        summary: `Started web research job ${record.id}.`,
      };
    },
  };
}

export function createOpenAIWebResearchCommand(options: {
  jobService: BackgroundToolJobService;
  apiKey?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  model?: string;
  reasoningEffort?: WebResearchReasoningEffort;
}): RegisteredCommand {
  return createWebResearchRegisteredCommand({
    ...options,
    descriptor: openAIWebResearchCommandDescriptor,
    commandName: OPENAI_WEB_RESEARCH_COMMAND_NAME,
    label: OPENAI_WEB_RESEARCH_COMMAND_NAME,
  });
}
