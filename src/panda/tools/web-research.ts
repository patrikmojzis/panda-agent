import {ToolError} from "../../kernel/agent/exceptions.js";
import {isRecord} from "../../lib/records.js";
import {trimToNull} from "../../lib/strings.js";
import {readResponseError} from "./http.js";

const OPENAI_RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses";
const DEFAULT_WEB_RESEARCH_MODEL = "gpt-5";
const DEFAULT_WEB_RESEARCH_REASONING_EFFORT = "low";
const DEFAULT_WEB_RESEARCH_TIMEOUT_MS = 60_000;
const MAX_ERROR_CHARS = 4_000;
const MAX_VISIBLE_SOURCES = 10;
const MAX_DETAIL_SOURCES = 20;

export type WebResearchReasoningEffort =  "low" | "medium" | "high";
export type WebResearchProgressStatus = "researching" | "formatting";
export type WebResearchProgress = {
  status: WebResearchProgressStatus;
  query?: string;
  model?: string;
  responseId?: string;
};

export type WebResearchCitation = {
  index: number;
  title: string | null;
  url: string;
};

export type WebResearchSource = {
  title: string | null;
  url: string;
};

export interface PerformWebResearchOptions {
  apiKey?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  model?: string;
  reasoningEffort?: WebResearchReasoningEffort;
  signal?: AbortSignal;
  onProgress?: (progress: WebResearchProgress) => void;
}

export interface PerformWebResearchResult {
  query: string;
  provider: "openai";
  model: string;
  responseId: string | null;
  status: string;
  elapsedMs: number;
  answer: string;
  citations: readonly WebResearchCitation[];
  sources: readonly WebResearchSource[];
  visibleSources: readonly WebResearchSource[];
}

type ResponseAnnotation = {
  title?: string;
  url?: string;
  startIndex?: number;
  endIndex?: number;
};

type ResponseOutputTextBlock = {
  text: string;
  annotations: readonly ResponseAnnotation[];
};

function buildResearchPrompt(query: string): string {
  return [
    "Research the user query on the public web and answer directly.",
    "Keep the answer concise and useful.",
    "Use current trustworthy sources.",
    "Include inline citations for factual claims.",
    "If evidence is mixed, say so plainly.",
    "",
    `User query: ${query}`,
  ].join("\n");
}

function parseResponseAnnotation(value: unknown): ResponseAnnotation | null {
  if (!isRecord(value)) {
    return null;
  }

  const url = trimToNull(value.url) ?? undefined;
  if (!url) {
    return null;
  }

  return {
    title: trimToNull(value.title) ?? undefined,
    url,
    startIndex: typeof value.start_index === "number" ? Math.trunc(value.start_index) : undefined,
    endIndex: typeof value.end_index === "number" ? Math.trunc(value.end_index) : undefined,
  };
}

function parseOutputTextBlock(value: unknown): ResponseOutputTextBlock | null {
  if (!isRecord(value) || value.type !== "output_text" || typeof value.text !== "string") {
    return null;
  }

  const annotations = Array.isArray(value.annotations)
    ? value.annotations
      .map((annotation) => parseResponseAnnotation(annotation))
      .filter((annotation): annotation is ResponseAnnotation => annotation !== null)
    : [];

  return {
    text: value.text,
    annotations,
  };
}

function getFinalMessageOutputTextBlock(output: unknown): ResponseOutputTextBlock | null {
  if (!Array.isArray(output)) {
    return null;
  }

  for (let itemIndex = output.length - 1; itemIndex >= 0; itemIndex -= 1) {
    const item = output[itemIndex];
    if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) {
      continue;
    }

    for (let contentIndex = item.content.length - 1; contentIndex >= 0; contentIndex -= 1) {
      const block = parseOutputTextBlock(item.content[contentIndex]);
      if (block) {
        return block;
      }
    }
  }

  return null;
}

function parseSource(value: unknown): WebResearchSource | null {
  if (!isRecord(value)) {
    return null;
  }

  const url = trimToNull(value.url);
  if (!url) {
    return null;
  }

  return {
    title: trimToNull(value.title),
    url,
  };
}

function dedupeSources(
  sources: readonly WebResearchSource[],
  maxSources = MAX_DETAIL_SOURCES,
): readonly WebResearchSource[] {
  const deduped: WebResearchSource[] = [];
  const seenUrls = new Set<string>();

  for (const source of sources) {
    if (seenUrls.has(source.url)) {
      continue;
    }

    seenUrls.add(source.url);
    deduped.push(source);

    if (deduped.length >= maxSources) {
      break;
    }
  }

  return deduped;
}

function extractSourcesFromWebSearchCalls(output: unknown): readonly WebResearchSource[] {
  if (!Array.isArray(output)) {
    return [];
  }

  const sources: WebResearchSource[] = [];
  for (const item of output) {
    if (!isRecord(item) || item.type !== "web_search_call" || !isRecord(item.action)) {
      continue;
    }

    const actionSources = item.action.sources;
    if (!Array.isArray(actionSources)) {
      continue;
    }

    for (const entry of actionSources) {
      const source = parseSource(entry);
      if (source) {
        sources.push(source);
      }
    }
  }

  return dedupeSources(sources);
}

function buildInlineCitations(
  text: string,
  annotations: readonly ResponseAnnotation[],
): {
  text: string;
  citations: readonly WebResearchCitation[];
} {
  if (annotations.length === 0) {
    return {text: text.trim(), citations: []};
  }

  const citationNumberByUrl = new Map<string, number>();
  const citations: WebResearchCitation[] = [];
  const insertions = new Map<number, string[]>();

  for (const annotation of annotations) {
    const url = trimToNull(annotation.url);
    if (!url) {
      continue;
    }

    let citationNumber = citationNumberByUrl.get(url);
    if (!citationNumber) {
      citationNumber = citationNumberByUrl.size + 1;
      citationNumberByUrl.set(url, citationNumber);
      citations.push({
        index: citationNumber,
        title: trimToNull(annotation.title),
        url,
      });
    }

    if (typeof annotation.endIndex !== "number" || Number.isNaN(annotation.endIndex)) {
      continue;
    }

    const safeIndex = Math.max(0, Math.min(text.length, annotation.endIndex));
    const marker = ` [[${citationNumber}]](${url})`;
    const markers = insertions.get(safeIndex) ?? [];
    if (!markers.includes(marker)) {
      markers.push(marker);
      insertions.set(safeIndex, markers);
    }
  }

  if (insertions.size === 0) {
    return {text: text.trim(), citations};
  }

  const orderedInsertions = [...insertions.entries()].sort((left, right) => left[0] - right[0]);
  let cursor = 0;
  let result = "";

  for (const [index, markers] of orderedInsertions) {
    result += text.slice(cursor, index);
    result += markers.join("");
    cursor = index;
  }

  result += text.slice(cursor);
  return {
    text: result.trim(),
    citations,
  };
}

function escapeMarkdownLabel(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

function getSourceLabel(source: WebResearchSource): string {
  if (source.title) {
    return escapeMarkdownLabel(source.title);
  }

  try {
    return escapeMarkdownLabel(new URL(source.url).host);
  } catch {
    return escapeMarkdownLabel(source.url);
  }
}

function formatMarkdownLinkDestination(url: string): string {
  return `<${url}>`;
}

export function renderWebResearchText(result: Pick<PerformWebResearchResult, "answer" | "visibleSources">): string {
  const answer = result.answer.trim();
  if (result.visibleSources.length === 0) {
    return answer;
  }

  const sourceLines = result.visibleSources.map((source) =>
    `- [${getSourceLabel(source)}](${formatMarkdownLinkDestination(source.url)})`
  );
  return `${answer}\n\nSources:\n${sourceLines.join("\n")}`;
}

function parseWebResearchPayload(
  query: string,
  payload: unknown,
  model: string,
  elapsedMs: number,
): PerformWebResearchResult {
  if (!isRecord(payload)) {
    throw new ToolError("OpenAI web research response was not valid JSON.");
  }

  const status = trimToNull(payload.status);
  if (!status) {
    throw new ToolError("OpenAI web research response did not include a valid status.");
  }

  if (status !== "completed") {
    throw new ToolError(`OpenAI web research did not complete successfully (status: ${status}).`);
  }

  const topLevelOutputText = typeof payload.output_text === "string" ? payload.output_text : "";
  const finalMessageBlock = getFinalMessageOutputTextBlock(payload.output);
  const messageText = finalMessageBlock?.text ?? "";
  const baseText = trimToNull(topLevelOutputText) ?? trimToNull(messageText);

  if (!baseText) {
    throw new ToolError("OpenAI web research response did not include final answer text.");
  }

  const preferTopLevelText = Boolean(
    trimToNull(topLevelOutputText)
      && trimToNull(messageText)
      && topLevelOutputText.trim() === messageText.trim(),
  );
  const citationBaseText = preferTopLevelText || !trimToNull(messageText)
    ? (topLevelOutputText || baseText)
    : (messageText || baseText);
  const formattedAnswer = finalMessageBlock
    ? buildInlineCitations(citationBaseText || baseText, finalMessageBlock.annotations)
    : {text: baseText, citations: [] as readonly WebResearchCitation[]};

  const sourcesFromCalls = extractSourcesFromWebSearchCalls(payload.output);
  const sources = sourcesFromCalls.length > 0
    ? sourcesFromCalls
    : dedupeSources(formattedAnswer.citations.map((citation) => ({
      title: citation.title,
      url: citation.url,
    })));

  return {
    query,
    provider: "openai",
    model,
    responseId: trimToNull(payload.id),
    status,
    elapsedMs,
    answer: formattedAnswer.text || baseText,
    citations: formattedAnswer.citations,
    sources,
    visibleSources: sources.slice(0, MAX_VISIBLE_SOURCES),
  };
}

export async function performWebResearch(
  query: string,
  options: PerformWebResearchOptions = {},
): Promise<PerformWebResearchResult> {
  const apiKey = trimToNull(options.apiKey) ?? trimToNull(options.env?.OPENAI_API_KEY);
  if (!apiKey) {
    throw new ToolError("OPENAI_API_KEY is not configured.");
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_WEB_RESEARCH_TIMEOUT_MS;
  const model = trimToNull(options.model) ?? DEFAULT_WEB_RESEARCH_MODEL;
  const reasoningEffort = options.reasoningEffort ?? DEFAULT_WEB_RESEARCH_REASONING_EFFORT;

  options.onProgress?.({
    status: "researching",
    query,
    model,
  });

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  const startedAt = Date.now();

  try {
    const response = await fetchImpl(OPENAI_RESPONSES_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        reasoning: {
          effort: reasoningEffort,
        },
        tools: [{
          type: "web_search",
        }],
        tool_choice: "auto",
        include: ["web_search_call.action.sources"],
        input: buildResearchPrompt(query),
      }),
      signal,
    });

    if (!response.ok) {
      const detail = await readResponseError(response, MAX_ERROR_CHARS);
      throw new ToolError(`OpenAI web research API error (${response.status}): ${detail || response.statusText}`);
    }

    const payload = await response.json();
    const responseId = isRecord(payload) ? (trimToNull(payload.id) ?? undefined) : undefined;
    options.onProgress?.({
      status: "formatting",
      query,
      model,
      responseId,
    });
    return parseWebResearchPayload(query, payload, model, Date.now() - startedAt);
  } catch (error) {
    if (options.signal?.aborted) {
      throw new ToolError("web_research was aborted.");
    }
    if (timeoutSignal.aborted) {
      throw new ToolError(`web_research timed out after ${timeoutMs}ms.`);
    }
    if (error instanceof ToolError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new ToolError(`OpenAI web research failed: ${message}`);
  }
}

export {
  DEFAULT_WEB_RESEARCH_MODEL,
  DEFAULT_WEB_RESEARCH_REASONING_EFFORT,
  DEFAULT_WEB_RESEARCH_TIMEOUT_MS,
};
