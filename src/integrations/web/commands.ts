import {mkdir, writeFile} from "node:fs/promises";
import path from "node:path";

import type {JsonObject} from "../../lib/json.js";
import {sleepWithSignal} from "../../lib/async.js";
import {isRecord} from "../../lib/records.js";
import {wrapExternalUntrustedContent} from "../../prompts/external-content.js";
import {ToolError} from "../../kernel/agent/exceptions.js";
import type {CommandWritableFileResolver} from "../../domain/commands/files.js";
import {COMMAND_AUDIT_METADATA} from "../../domain/commands/types.js";
import type {CommandDescriptor, CommandRequest, CommandSuccess, RegisteredCommand} from "../../domain/commands/types.js";
import type {BackgroundToolJobService} from "../../domain/threads/runtime/tool-job-service.js";
import type {ThreadToolJobRecord} from "../../domain/threads/runtime/types.js";
import {
  DEFAULT_WEB_FETCH_MAX_REDIRECTS,
  DEFAULT_WEB_FETCH_TIMEOUT_MS,
  DEFAULT_WEB_FETCH_USER_AGENT,
  fetchSafeHttpResource,
  type FetchImpl,
} from "./web-fetch.js";
import {extractReadableContentFromHtml, looksLikeHtml} from "./html-content.js";
import {
  DEFAULT_WEB_RESOURCE_SCOPE_BYTES,
  FileSystemWebResourceStore,
  WebResourceError,
} from "./web-resources.js";
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
  readBraveAttemptMetadata,
  type BraveLlmContextInput,
  type BravePlaceDetailsInput,
  type BravePlaceSearchInput,
  type BraveSearchInput,
  type BraveSearchOptions,
  type FetchImpl as BraveSearchFetchImpl,
} from "./brave-search.js";
import {BraveThrottleGate} from "./brave-throttle.js";
import {
  DEFAULT_WEB_RESEARCH_MODEL,
  DEFAULT_WEB_RESEARCH_REASONING_EFFORT,
  DEFAULT_WEB_RESEARCH_TIMEOUT_MS,
  performWebResearch,
  serializeWebResearchResultForBackgroundJob,
  type WebResearchReasoningEffort,
} from "./research.js";

export const WEB_FETCH_COMMAND_NAME = "web.fetch";
export const WEB_READ_COMMAND_NAME = "web.read";
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

const DEFAULT_WEB_FETCH_CHUNK_CHARS = 20_000;
const DEFAULT_WEB_FETCH_DOWNLOAD_BYTES = 10_000_000;
const MAX_WEB_FETCH_CHUNK_CHARS = 100_000;
const DEFAULT_WEB_FETCH_RETRY_BUDGET_MS = 30_000;
const MAX_WEB_FETCH_ATTEMPTS = 3;

export const webFetchCommandDescriptor: CommandDescriptor = {
  name: WEB_FETCH_COMMAND_NAME,
  summary: "Fetch a bounded public resource into model-ready content or an artifact.",
  description: "Safely GETs public HTML, text, Markdown, JSON, XML, CSV, PDF, image, or bounded binary content. --chunk-chars controls readable characters returned per response; it does not raise the network byte limit. Resource refs are short-lived and session-scoped. Binary bytes become artifacts, never stdout. Use browser only for client-rendered public pages; use curl for custom methods, headers, authentication, or protocol debugging. Private targets and HTTP 401/403 are terminal.",
  usage: "panda web fetch <url> [--chunk-chars <n>] [--format markdown|text] [--save <path>] [--include-links|--no-links]",
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
      name: "chunk-chars",
      description: "Readable characters returned per response. Does not raise the network download-byte limit.",
      valueType: "number",
      valueName: "n",
      defaultValue: DEFAULT_WEB_FETCH_CHUNK_CHARS,
      minimum: 1,
      maximum: MAX_WEB_FETCH_CHUNK_CHARS,
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
      description: "Structured JSON object containing url and optional chunkChars, format, save, and includeLinks. maxContentChars is invalid.",
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
      command: "panda web fetch https://example.com/docs --chunk-chars 50000 --save ./docs.md",
    },
  ],
  requiredCapabilities: [WEB_FETCH_COMMAND_NAME],
  resultShape: {
    url: "string",
    finalUrl: "string",
    status: "number",
    contentType: "string",
    title: "string|null",
    canonicalUrl: "string|null",
    content: "string|absent when saved",
    contentPreview: "string|absent unless saved",
    contentKind: "article|text|markdown|json|xml|csv|pdf|image|binary",
    downloadedBytes: "number",
    downloadLimitBytes: "number",
    attemptCount: "number",
    chunkLimitChars: "number",
    contentComplete: "boolean",
    resourceRef: "string|absent",
    resourceExpiresAt: "ISO timestamp",
    nextCursor: "string|absent",
    saved: "object|null",
    links: ["object"],
    artifact: "object|null",
    externalContent: "{untrusted:true,source:web,wrappedContent:true}",
  },
};

export const webReadCommandDescriptor: CommandDescriptor = {
  name: WEB_READ_COMMAND_NAME,
  summary: "Read the next chunk of a fetched web resource.",
  description: "Reads session-scoped short-lived untrusted content without repeating the network request. Resource refs and cursors are opaque and expire automatically after one hour.",
  usage: "panda web read <resource-ref> [--cursor <cursor>] [--chunk-chars <n>]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "resource-ref",
      description: "Opaque resourceRef returned by web.fetch.",
      required: true,
      kind: "positional",
      valueType: "string",
      valueName: "resource-ref",
    },
    {
      name: "cursor",
      description: "Opaque nextCursor returned by the previous chunk.",
      valueType: "string",
      valueName: "cursor",
    },
    {
      name: "chunk-chars",
      description: "Readable characters returned in this response.",
      valueType: "number",
      valueName: "n",
      defaultValue: DEFAULT_WEB_FETCH_CHUNK_CHARS,
      minimum: 1,
      maximum: MAX_WEB_FETCH_CHUNK_CHARS,
    },
    {
      name: "json",
      description: "Structured JSON object containing resourceRef and optional cursor and chunkChars.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "Continue a large resource",
      command: "panda web read web_abc123 --cursor cur_abc123",
    },
  ],
  requiredCapabilities: [WEB_READ_COMMAND_NAME],
  resultShape: {
    operation: "read",
    resourceRef: "string",
    contentKind: "string",
    contentFormat: "markdown|text",
    content: "string",
    chunkLimitChars: "number",
    contentComplete: "boolean",
    nextCursor: "string|absent",
    externalContent: "{untrusted:true,source:web,wrappedContent:true}",
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
  chunkChars: number;
  format: WebFetchFormat;
  save?: string;
  includeLinks: boolean;
}

function readWebFetchInput(input: unknown): WebFetchCommandInput {
  if (!isRecord(input) || typeof input.url !== "string" || !input.url.trim()) {
    throw new Error("web.fetch url must be a non-empty string.");
  }

  if (input.maxContentChars !== undefined || input.maxChars !== undefined || input.max_chars !== undefined) {
    throw new Error("web.fetch maxContentChars was removed; use chunkChars.");
  }
  const chunkChars = readChunkChars(input.chunkChars, "web.fetch chunkChars");

  const rawFormat = readOptionalString(input.format, "web.fetch format") ?? "markdown";
  if (rawFormat !== "markdown" && rawFormat !== "text") {
    throw new Error("web.fetch format must be markdown or text.");
  }

  const includeLinks = readOptionalBoolean(input.includeLinks ?? input.include_links, "web.fetch includeLinks") ?? true;
  const save = readOptionalString(input.save, "web.fetch save");

  return {
    url: input.url.trim(),
    chunkChars,
    format: rawFormat,
    includeLinks,
    ...(save ? {save} : {}),
  };
}

function readChunkChars(value: unknown, label: string): number {
  const parsed = readOptionalNumber(value, label) ?? DEFAULT_WEB_FETCH_CHUNK_CHARS;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_WEB_FETCH_CHUNK_CHARS) {
    throw new Error(`${label} must be an integer from 1 to ${MAX_WEB_FETCH_CHUNK_CHARS}.`);
  }
  return parsed;
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

type WebFailureCode =
  | "invalid_url"
  | "private_target"
  | "redirect_blocked"
  | "redirect_limit"
  | "remote_denial"
  | "remote_not_found"
  | "remote_throttle"
  | "remote_server_error"
  | "timeout"
  | "network_error"
  | "response_too_large"
  | "decode_failed"
  | "requires_browser"
  | "extract_failed"
  | "storage_failed"
  | "resource_expired";

type WebFailurePhase =
  | "validate"
  | "resolve"
  | "connect"
  | "download"
  | "decode"
  | "extract"
  | "store"
  | "read";

type WebCommandErrorDetails = {
  failureCode: WebFailureCode;
  phase: WebFailurePhase;
  retryable: boolean;
  nextAction: string;
  status?: number;
  contentType?: string | null;
  downloadLimitBytes?: number;
  attemptCount?: number;
  retryAfterMs?: number;
};

class WebCommandError extends Error {
  readonly pandaCommandErrorDetails: JsonObject;

  constructor(message: string, details: WebCommandErrorDetails) {
    super(message);
    this.name = "WebCommandError";
    this.pandaCommandErrorDetails = details;
  }
}

function baseContentType(value: string | null): string {
  return value?.split(";", 1)[0]?.trim().toLowerCase() || "application/octet-stream";
}

function classifyReadable(
  contentType: string,
  body: string,
): "html" | "text" | "markdown" | "json" | "xml" | "csv" | null {
  if (contentType === "text/html" || contentType === "application/xhtml+xml" || looksLikeHtml(body)) {
    return "html";
  }
  const sample = body.slice(0, 4_096);
  if (sample.includes("\0") || (sample.match(/\uFFFD/g)?.length ?? 0) > 8) {
    return null;
  }
  if (contentType === "application/json" || contentType.endsWith("+json")) {
    return "json";
  }
  if (contentType === "application/xml" || contentType === "text/xml" || contentType.endsWith("+xml")) {
    return "xml";
  }
  if (contentType === "text/csv" || contentType === "application/csv") {
    return "csv";
  }
  if (contentType === "text/markdown" || contentType === "text/x-markdown") {
    return "markdown";
  }
  if (contentType.startsWith("text/")) {
    return "text";
  }
  return contentType === "application/octet-stream" ? "text" : null;
}

function wrapWebContent(content: string, contentKind: string): string {
  return wrapExternalUntrustedContent(content, {source: "web", kind: contentKind});
}

function externalWebContentDetails(): JsonObject {
  return {untrusted: true, source: "web", wrappedContent: true};
}

function failureFor(error: unknown, downloadLimitBytes?: number): WebCommandError {
  if (error instanceof WebCommandError) return error;
  if (error instanceof WebResourceError) {
    return new WebCommandError(error.message, {
      failureCode: error.failureCode,
      phase: error.failureCode === "resource_expired" ? "read" : "store",
      retryable: false,
      nextAction: error.failureCode === "resource_expired" ? "fetch_again" : "stop",
      ...(downloadLimitBytes !== undefined ? {downloadLimitBytes} : {}),
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  const invalidTarget = lower.includes("valid url")
    || lower.includes("valid hostname")
    || lower.includes("only supports http")
    || lower.includes("embedded credentials");
  const failureCode: WebFailureCode = lower.includes("private") || lower.includes("public address")
    ? "private_target"
    : lower.includes("redirect limit") ? "redirect_limit"
      : lower.includes("redirect") ? "redirect_blocked"
        : lower.includes("byte limit") || lower.includes("exceeded") ? "response_too_large"
          : lower.includes("timed out") ? "timeout"
            : invalidTarget ? "invalid_url"
              : "network_error";
  const safeMessage = failureCode === "private_target"
    ? "web.fetch blocked a private target."
    : failureCode === "redirect_limit"
      ? "web.fetch exceeded its redirect limit."
      : failureCode === "redirect_blocked"
        ? "web.fetch blocked an unsafe redirect."
        : failureCode === "response_too_large"
          ? `web.fetch response exceeded the ${downloadLimitBytes ?? "configured"} byte limit.`
          : failureCode === "timeout"
            ? "web.fetch timed out."
            : failureCode === "invalid_url"
              ? "web.fetch requires a valid public HTTP/HTTPS URL."
              : "web.fetch could not retrieve the public resource.";
  return new WebCommandError(safeMessage, {
    failureCode,
    phase: failureCode === "invalid_url"
      ? "validate"
      : failureCode === "private_target"
        ? "resolve"
        : failureCode === "response_too_large"
          ? "download"
          : "connect",
    retryable: failureCode === "timeout" || failureCode === "network_error",
    nextAction: failureCode === "response_too_large" ? "curl_or_smaller_resource" : "stop",
    ...(downloadLimitBytes !== undefined ? {downloadLimitBytes} : {}),
  });
}

function remoteFailure(
  status: number,
  contentType: string,
  attemptCount: number,
  downloadLimitBytes: number,
  headers: Headers,
  now: () => number,
): WebCommandError {
  const failureCode: WebFailureCode = status === 401 || status === 403
    ? "remote_denial"
    : status === 404
      ? "remote_not_found"
      : status === 429
        ? "remote_throttle"
        : "remote_server_error";
  const retryAfterMs = readRetryAfterMs(headers, now);
  return new WebCommandError(`web.fetch failed with HTTP ${status}.`, {
    failureCode,
    phase: "download",
    retryable: status === 429 || status === 502 || status === 503 || status === 504,
    status,
    contentType,
    downloadLimitBytes,
    attemptCount,
    ...(retryAfterMs !== undefined ? {retryAfterMs} : {}),
    nextAction: transientStatus(status) ? "retry_later" : "stop",
  });
}

function requireDownloadLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_WEB_RESOURCE_SCOPE_BYTES) {
    throw new Error(`${label} must be an integer from 1 to ${DEFAULT_WEB_RESOURCE_SCOPE_BYTES}.`);
  }
  return value;
}

function configuredDownloadLimit(env: NodeJS.ProcessEnv | undefined): number {
  const raw = env?.WEB_FETCH_DOWNLOAD_LIMIT_BYTES?.trim();
  if (!raw) {
    return DEFAULT_WEB_FETCH_DOWNLOAD_BYTES;
  }
  return requireDownloadLimit(Number(raw), "WEB_FETCH_DOWNLOAD_LIMIT_BYTES");
}

function transientStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function readRetryAfterMs(headers: Headers, now: () => number): number | undefined {
  const retryAfterHeader = headers.get("retry-after");
  if (retryAfterHeader === null) {
    return undefined;
  }
  const retryAfterSeconds = Number(retryAfterHeader);
  const retryAfterDate = Date.parse(retryAfterHeader);
  const retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
    ? retryAfterSeconds * 1_000
    : Number.isFinite(retryAfterDate)
      ? Math.max(0, retryAfterDate - now())
      : Number.NaN;
  return Number.isFinite(retryAfterMs) ? retryAfterMs : undefined;
}

function retryDelayMs(
  headers: Headers,
  attempt: number,
  random: () => number,
  now: () => number,
): number {
  const retryAfterMs = readRetryAfterMs(headers, now);
  const base = retryAfterMs !== undefined
    ? Math.min(2_000, retryAfterMs)
    : Math.min(500, 100 * (attempt + 1));
  return Math.max(0, Math.round(base * (0.75 + random() * 0.5)));
}

function abortedFailure(downloadLimitBytes: number, attemptCount: number): WebCommandError {
  return new WebCommandError("web.fetch was aborted.", {
    failureCode: "timeout",
    phase: "connect",
    retryable: false,
    nextAction: "stop",
    downloadLimitBytes,
    attemptCount,
  });
}

export function createWebFetchCommand(options: {
  fetchImpl?: FetchImpl;
  lookupHostname?: LookupHostname;
  timeoutMs?: number;
  maxRedirects?: number;
  maxResponseBytes?: number;
  env?: NodeJS.ProcessEnv;
  resourceStore?: FileSystemWebResourceStore;
  retryBudgetMs?: number;
  signal?: AbortSignal;
  now?: () => number;
  random?: () => number;
  waitForRetry?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  userAgent?: string;
  fileResolver?: CommandWritableFileResolver;
} = {}): RegisteredCommand {
  const resources = options.resourceStore ?? new FileSystemWebResourceStore({env: options.env});
  const downloadLimitBytes = options.maxResponseBytes === undefined
    ? configuredDownloadLimit(options.env)
    : requireDownloadLimit(options.maxResponseBytes, "web.fetch maxResponseBytes");
  return {
    descriptor: webFetchCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = readWebFetchInput(request.input);
      const now = options.now ?? Date.now;
      const random = options.random ?? Math.random;
      const signal = request.signal && options.signal
        ? AbortSignal.any([request.signal, options.signal])
        : request.signal ?? options.signal;
      const retryDeadline = now()
        + Math.max(1, options.retryBudgetMs ?? DEFAULT_WEB_FETCH_RETRY_BUDGET_MS);
      let response: Awaited<ReturnType<typeof fetchSafeHttpResource>> | undefined;
      let attemptCount = 0;
      for (let attempt = 0; attempt < MAX_WEB_FETCH_ATTEMPTS; attempt += 1) {
        if (signal?.aborted) {
          throw abortedFailure(downloadLimitBytes, attemptCount);
        }
        const remainingMs = retryDeadline - now();
        if (remainingMs <= 0) {
          break;
        }
        attemptCount = attempt + 1;
        try {
          response = await fetchSafeHttpResource(input.url, {
            fetchImpl: options.fetchImpl,
            lookupHostname: options.lookupHostname,
            timeoutMs: Math.min(options.timeoutMs ?? DEFAULT_WEB_FETCH_TIMEOUT_MS, remainingMs),
            maxRedirects: options.maxRedirects ?? DEFAULT_WEB_FETCH_MAX_REDIRECTS,
            maxResponseBytes: downloadLimitBytes,
            userAgent: options.userAgent ?? DEFAULT_WEB_FETCH_USER_AGENT,
            signal,
            readErrorBody: false,
          });
        } catch (error) {
          if (signal?.aborted) {
            throw abortedFailure(downloadLimitBytes, attemptCount);
          }
          const failure = failureFor(error, downloadLimitBytes);
          failure.pandaCommandErrorDetails.attemptCount = attemptCount;
          if (!failure.pandaCommandErrorDetails.retryable || attempt === MAX_WEB_FETCH_ATTEMPTS - 1) {
            throw failure;
          }
          const delayMs = Math.min(
            retryDelayMs(new Headers(), attempt, random, now),
            Math.max(0, retryDeadline - now()),
          );
          if (delayMs <= 0) {
            throw failure;
          }
          try {
            await (options.waitForRetry ?? sleepWithSignal)(delayMs, signal);
          } catch {
            throw abortedFailure(downloadLimitBytes, attemptCount);
          }
          continue;
        }
        if (!transientStatus(response.status) || attempt === MAX_WEB_FETCH_ATTEMPTS - 1) {
          break;
        }
        const retryBudgetRemainingMs = Math.max(0, retryDeadline - now());
        if (retryBudgetRemainingMs <= 0) {
          break;
        }
        const delayMs = Math.min(
          retryDelayMs(response.headers, attempt, random, now),
          retryBudgetRemainingMs,
        );
        if (delayMs > 0) {
          try {
            await (options.waitForRetry ?? sleepWithSignal)(delayMs, signal);
          } catch {
            throw abortedFailure(downloadLimitBytes, attemptCount);
          }
        }
      }
      if (!response) {
        throw new WebCommandError("web.fetch retry budget elapsed.", {
          failureCode: "timeout",
          phase: "connect",
          retryable: true,
          nextAction: "retry_later",
          downloadLimitBytes,
          attemptCount,
        });
      }
      const contentType = baseContentType(response.contentType);
      if (response.status < 200 || response.status >= 300) {
        throw remoteFailure(
          response.status,
          contentType,
          attemptCount,
          downloadLimitBytes,
          response.headers,
          now,
        );
      }
      const readableKind = classifyReadable(contentType, response.bodyText);
      const scope = {agentKey: request.scope.agentKey, sessionId: request.scope.sessionId};
      const fetchedAt = new Date().toISOString();
      if (!readableKind) {
        const kind = contentType === "application/pdf"
          ? "pdf"
          : contentType.startsWith("image/")
            ? "image"
            : "binary";
        const filename = path.basename(new URL(response.finalUrl).pathname)
          || (kind === "pdf" ? "document.pdf" : "resource.bin");
        let stored;
        try {
          stored = await resources.store({
            scope,
            contentKind: kind,
            contentFormat: "binary",
            contentType,
            filename,
            bytes: response.bodyBytes,
            readable: false,
          });
        } catch (error) {
          throw failureFor(error, downloadLimitBytes);
        }
        const output = {
          operation: "fetch",
          resourceRef: stored.resourceRef,
          resourceExpiresAt: new Date(stored.expiresAt).toISOString(),
          url: input.url,
          finalUrl: response.finalUrl,
          status: response.status,
          contentType,
          contentKind: kind,
          downloadedBytes: response.downloadedBytes,
          downloadLimitBytes,
          fetchedAt,
          attemptCount,
          contentComplete: true,
          artifact: {
            path: stored.path,
            mimeType: contentType,
            filename: stored.filename,
            bytes: response.downloadedBytes,
          },
          externalContent: externalWebContentDetails(),
          cache: "miss",
        } satisfies JsonObject;
        return {
          ok: true,
          command: WEB_FETCH_COMMAND_NAME,
          output,
          summary: "Fetched a public web resource.",
          ...(kind === "pdf" || kind === "image" ? {
            artifact: {
              kind: kind === "pdf" ? "pdf" as const : "image" as const,
              source: "view_media" as const,
              path: stored.path,
              mimeType: contentType,
              bytes: response.downloadedBytes,
            },
          } : {}),
        };
      }
      let title: string | null = null;
      let description: string | null = null;
      let siteName: string | null = null;
      let canonicalUrl: string | null = null;
      let links: JsonObject[] = [];
      let normalized = response.bodyText;
      let contentKind: string = readableKind;
      if (readableKind === "html") {
        try {
          const extracted = extractReadableContentFromHtml({
            html: response.bodyText,
            url: response.finalUrl,
          });
          normalized = extracted.content;
          title = extracted.title ?? null;
          description = extracted.description ?? null;
          siteName = extracted.siteName ?? null;
          canonicalUrl = extracted.canonicalUrl ?? null;
          links = extracted.links.map((link) => ({text: link.text, url: link.url}));
          contentKind = "article";
        } catch (error) {
          const requiresBrowser = error instanceof ToolError
            && error.message.includes("could not extract any readable content");
          throw new WebCommandError(
            requiresBrowser
              ? "The response requires a browser."
              : "The response could not be extracted.",
            {
              failureCode: requiresBrowser ? "requires_browser" : "extract_failed",
              phase: "extract",
              retryable: false,
              status: response.status,
              contentType,
              downloadLimitBytes,
              attemptCount,
              nextAction: requiresBrowser ? "browser" : "stop",
            },
          );
        }
      } else if (readableKind === "json") {
        try {
          normalized = JSON.stringify(JSON.parse(response.bodyText), null, 2);
        } catch {
          throw new WebCommandError("The response advertised JSON but could not be decoded.", {
            failureCode: "decode_failed",
            phase: "decode",
            retryable: false,
            status: response.status,
            contentType,
            downloadLimitBytes,
            attemptCount,
            nextAction: "curl",
          });
        }
      }
      const fullContent = formatWebFetchContent(normalized, input.format);
      const stored = await resources.store({
        scope,
        contentKind,
        contentFormat: input.format,
        contentType,
        filename: "resource.txt",
        bytes: Buffer.from(fullContent),
        readable: true,
      }).catch((error) => {
        throw failureFor(error, downloadLimitBytes);
      });
      const first = await resources.read({
        scope,
        resourceRef: stored.resourceRef,
        chunkChars: input.chunkChars,
      }).catch((error) => {
        throw failureFor(error, downloadLimitBytes);
      });
      const content = wrapWebContent(first.content, contentKind);
      let saved: JsonObject | null = null;
      if (input.save) {
        if (!options.fileResolver) {
          throw new WebCommandError("web.fetch --save requires a writable execution environment.", {
            failureCode: "storage_failed",
            phase: "store",
            retryable: false,
            nextAction: "omit_save",
            downloadLimitBytes,
            attemptCount,
          });
        }
        try {
          const resolved = await options.fileResolver.resolveWritablePath({
            request,
            file: {
              path: input.save,
            },
          });
          const savedContent = fullContent.endsWith("\n") ? fullContent : `${fullContent}\n`;
          await mkdir(path.dirname(resolved.path), {recursive: true});
          await writeFile(resolved.path, savedContent, "utf8");
          saved = {
            path: resolved.path,
            displayPath: resolved.displayPath,
            bytes: Buffer.byteLength(savedContent, "utf8"),
            format: input.format,
          };
        } catch {
          throw new WebCommandError("web.fetch could not save the resource.", {
            failureCode: "storage_failed",
            phase: "store",
            retryable: false,
            nextAction: "omit_save",
            downloadLimitBytes,
            attemptCount,
          });
        }
      }
      const output = {
        operation: "fetch",
        resourceRef: stored.resourceRef,
        resourceExpiresAt: new Date(stored.expiresAt).toISOString(),
        url: input.url,
        finalUrl: response.finalUrl,
        status: response.status,
        contentType,
        contentKind,
        downloadedBytes: response.downloadedBytes,
        downloadLimitBytes,
        fetchedAt,
        attemptCount,
        title,
        description,
        siteName,
        canonicalUrl,
        contentFormat: input.format,
        chunkLimitChars: input.chunkChars,
        contentComplete: first.contentComplete,
        ...(first.nextCursor ? {nextCursor: first.nextCursor} : {}),
        truncated: !first.contentComplete,
        ...(saved ? {
          contentPreview: wrapWebContent(webFetchSavedPreview(first.content), contentKind),
          saved,
        } : {content}),
        ...(input.includeLinks ? {links} : {}),
        artifact: null,
        externalContent: externalWebContentDetails(),
        cache: "miss",
      } satisfies JsonObject;

      return {
        ok: true,
        command: WEB_FETCH_COMMAND_NAME,
        output,
        summary: "Fetched a public web resource.",
      };
    },
  };
}

export function createWebReadCommand(options: {
  env?: NodeJS.ProcessEnv;
  resourceStore?: FileSystemWebResourceStore;
} = {}): RegisteredCommand {
  const resources = options.resourceStore ?? new FileSystemWebResourceStore({env: options.env});
  return {
    descriptor: webReadCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      if (!isRecord(request.input)) {
        throw new Error("web.read input must be a JSON object.");
      }
      if (typeof request.input.resourceRef !== "string" || !request.input.resourceRef.trim()) {
        throw new Error("web.read resourceRef must be a non-empty string.");
      }
      const cursor = readOptionalString(request.input.cursor, "web.read cursor");
      const chunkChars = readChunkChars(request.input.chunkChars, "web.read chunkChars");
      try {
        const resourceRef = request.input.resourceRef.trim();
        const result = await resources.read({
          scope: {agentKey: request.scope.agentKey, sessionId: request.scope.sessionId},
          resourceRef,
          ...(cursor ? {cursor} : {}),
          chunkChars,
        });
        return {
          ok: true,
          command: WEB_READ_COMMAND_NAME,
          output: {
            operation: "read",
            resourceRef,
            contentKind: result.contentKind,
            contentFormat: result.contentFormat,
            content: wrapWebContent(result.content, result.contentKind),
            chunkLimitChars: chunkChars,
            contentComplete: result.contentComplete,
            ...(result.nextCursor ? {nextCursor: result.nextCursor} : {}),
            externalContent: externalWebContentDetails(),
          },
          summary: `Read ${resourceRef}.`,
        };
      } catch (error) {
        throw failureFor(error);
      }
    },
  };
}

export interface BraveCommandOptions {
  apiKey?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: BraveSearchFetchImpl;
  timeoutMs?: number;
  defaultCount?: number;
  now?: () => number;
  random?: () => number;
  retryBudgetMs?: number;
  throttleGate?: BraveThrottleGate;
}

function createBraveRequestOptions(options: BraveCommandOptions): (signal?: AbortSignal) => BraveSearchOptions {
  const throttleGate = options.throttleGate ?? new BraveThrottleGate({now: options.now});
  return (signal) => ({
    apiKey: options.apiKey,
    env: options.env,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    defaultCount: options.defaultCount,
    now: options.now,
    random: options.random,
    retryBudgetMs: options.retryBudgetMs,
    throttleGate,
    signal,
  });
}

function braveCommandAudit(result: object): Pick<CommandSuccess, typeof COMMAND_AUDIT_METADATA> {
  const metadata = readBraveAttemptMetadata(result);
  if (!metadata || (metadata.attemptCount <= 1 && metadata.totalBackoffMs === 0)) {
    return {};
  }
  return {[COMMAND_AUDIT_METADATA]: metadata};
}

export function createBraveWebSearchCommand(options: BraveCommandOptions = {}): RegisteredCommand {
  const requestOptions = createBraveRequestOptions(options);
  return {
    descriptor: braveWebSearchCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = readWebSearchInput(request.input, BRAVE_WEB_SEARCH_COMMAND_NAME);
      const result = await searchBraveWeb(input, requestOptions(request.signal));
      return {
        ok: true,
        command: BRAVE_WEB_SEARCH_COMMAND_NAME,
        output: result,
        summary: `Found ${result.resultCount} Brave web result${result.resultCount === 1 ? "" : "s"} for ${result.query}.`,
        ...braveCommandAudit(result),
      };
    },
  };
}

export function createBraveNewsSearchCommand(options: BraveCommandOptions = {}): RegisteredCommand {
  const requestOptions = createBraveRequestOptions(options);
  return {
    descriptor: braveNewsSearchCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = readWebSearchInput(request.input, BRAVE_NEWS_SEARCH_COMMAND_NAME);
      const result = await searchBraveNews(input, requestOptions(request.signal));
      return {
        ok: true,
        command: BRAVE_NEWS_SEARCH_COMMAND_NAME,
        output: result,
        summary: `Found ${result.resultCount} Brave news result${result.resultCount === 1 ? "" : "s"} for ${result.query}.`,
        ...braveCommandAudit(result),
      };
    },
  };
}

export function createBraveVideoSearchCommand(options: BraveCommandOptions = {}): RegisteredCommand {
  const requestOptions = createBraveRequestOptions(options);
  return {
    descriptor: braveVideoSearchCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = readWebSearchInput(request.input, BRAVE_VIDEO_SEARCH_COMMAND_NAME);
      const result = await searchBraveVideo(input, requestOptions(request.signal));
      return {
        ok: true,
        command: BRAVE_VIDEO_SEARCH_COMMAND_NAME,
        output: result,
        summary: `Found ${result.resultCount} Brave video result${result.resultCount === 1 ? "" : "s"} for ${result.query}.`,
        ...braveCommandAudit(result),
      };
    },
  };
}

export function createBraveImageSearchCommand(options: BraveCommandOptions = {}): RegisteredCommand {
  const requestOptions = createBraveRequestOptions(options);
  return {
    descriptor: braveImageSearchCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = readWebSearchInput(request.input, BRAVE_IMAGE_SEARCH_COMMAND_NAME);
      const result = await searchBraveImage(input, requestOptions(request.signal));
      return {
        ok: true,
        command: BRAVE_IMAGE_SEARCH_COMMAND_NAME,
        output: result,
        summary: `Found ${result.resultCount} Brave image result${result.resultCount === 1 ? "" : "s"} for ${result.query}.`,
        ...braveCommandAudit(result),
      };
    },
  };
}

export function createBraveLlmContextCommand(options: BraveCommandOptions = {}): RegisteredCommand {
  const requestOptions = createBraveRequestOptions(options);
  return {
    descriptor: braveLlmContextCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = readBraveLlmContextInput(request.input);
      const result = await searchBraveLlmContext(input, requestOptions(request.signal));
      return {
        ok: true,
        command: BRAVE_LLM_CONTEXT_COMMAND_NAME,
        output: result,
        summary: `Retrieved Brave LLM context from ${result.resultCount} source${result.resultCount === 1 ? "" : "s"} for ${result.query}.`,
        ...braveCommandAudit(result),
      };
    },
  };
}

export function createBravePlaceSearchCommand(options: BraveCommandOptions = {}): RegisteredCommand {
  const requestOptions = createBraveRequestOptions(options);
  return {
    descriptor: bravePlaceSearchCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = readPlaceSearchInput(request.input);
      const result = await searchBravePlace(input, requestOptions(request.signal));
      return {
        ok: true,
        command: BRAVE_PLACE_SEARCH_COMMAND_NAME,
        output: result,
        summary: `Found ${result.resultCount} Brave place result${result.resultCount === 1 ? "" : "s"}.`,
        ...braveCommandAudit(result),
      };
    },
  };
}

export function createBravePlacePoiCommand(options: BraveCommandOptions = {}): RegisteredCommand {
  const requestOptions = createBraveRequestOptions(options);
  return {
    descriptor: bravePlacePoiCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = readPlaceDetailsInput(request.input, BRAVE_PLACE_POI_COMMAND_NAME);
      const result = await fetchBravePlacePois(input, requestOptions(request.signal));
      return {
        ok: true,
        command: BRAVE_PLACE_POI_COMMAND_NAME,
        output: result,
        summary: `Fetched Brave POI details for ${result.ids.length} place id${result.ids.length === 1 ? "" : "s"}.`,
        ...braveCommandAudit(result),
      };
    },
  };
}

export function createBravePlaceDescriptionCommand(options: BraveCommandOptions = {}): RegisteredCommand {
  const requestOptions = createBraveRequestOptions(options);
  return {
    descriptor: bravePlaceDescriptionCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = readPlaceDetailsInput(request.input, BRAVE_PLACE_DESCRIPTION_COMMAND_NAME);
      const result = await fetchBravePlaceDescriptions(input, requestOptions(request.signal));
      return {
        ok: true,
        command: BRAVE_PLACE_DESCRIPTION_COMMAND_NAME,
        output: result,
        summary: `Fetched Brave place descriptions for ${result.ids.length} place id${result.ids.length === 1 ? "" : "s"}.`,
        ...braveCommandAudit(result),
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
